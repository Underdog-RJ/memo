import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { basename } from "node:path"
import type { Model, Operation } from "./model.js"
import type { Item, Proposal, Source, State, Store } from "./store.js"

export const localDay = (time = new Date()) =>
  [time.getFullYear(), time.getMonth() + 1, time.getDate()].map(value => String(value).padStart(2, "0")).join("-")

export function validDue(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(value + "T00:00:00Z")
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value ? value : null
}

export class Conflict extends Error {}

const openTasks = (state: Readonly<State>) => state.items.filter(item => item.kind === "task" && !item.done)
const normalize = (text: string) => text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase()
const union = (a: string[], b: string[]) => [...new Set([...a, ...b])]

function addItem(state: State, proposal: Pick<Proposal, "kind" | "text" | "due">, id: string = randomUUID()): Item {
  const item: Item = {
    id, kind: proposal.kind === "note" ? "note" : "task", text: proposal.text,
    due: proposal.kind === "task" ? proposal.due : null, done: false, createdAt: new Date().toISOString()
  }
  state.items.unshift(item)
  return item
}

function queue(state: State, proposal: Proposal) {
  const existing = state.proposals.find(other => other.status === "pending" && other.kind === proposal.kind &&
    (proposal.kind === "complete"
      ? [...other.candidates].sort().join() === [...proposal.candidates].sort().join()
      : normalize(other.text) === normalize(proposal.text) && other.due === proposal.due))
  if (existing) {
    existing.evidence = union(existing.evidence, proposal.evidence)
    return existing
  }
  state.proposals.unshift(proposal)
  return proposal
}

function toProposal(operation: Operation, tasks: Item[], sources: Source[]): Proposal | undefined {
  const text = operation.text.trim().slice(0, 2000)
  const candidates = operation.kind === "complete"
    ? union([], operation.candidates).filter(id => tasks.some(task => task.id === id)).slice(0, 8)
    : []
  const evidence = union([], operation.evidence).filter(id => sources.some(source => source.id === id))
  if (!text || (operation.kind === "complete" && !candidates.length) || (sources.length && !evidence.length)) return
  return {
    id: randomUUID(), kind: operation.kind, text, due: validDue(operation.due),
    candidates, evidence, status: "pending"
  }
}

export class Memo {
  private summarizing = false

  constructor(
    readonly store: Store,
    private readonly model: Model,
    private readonly notify: (message: string) => void
  ) {}

  async input(text: string) {
    const { state } = this.store
    const tasks = openTasks(state)
    const result = await this.model({ text, items: tasks, sources: [], today: localDay(), model: state.settings.model })
    let added = 0
    const pending: string[] = []
    this.store.change(next => {
      const stillOpen = openTasks(next).filter(item => tasks.some(before => before.id === item.id && before.text === item.text))
      for (const operation of result.operations.slice(0, 25)) {
        const proposal = toProposal(operation, stillOpen, [])
        if (!proposal) continue
        if (proposal.kind === "complete") pending.push(queue(next, proposal).id)
        else {
          addItem(next, proposal)
          added++
        }
      }
    })
    return { added, pending, message: added || pending.length ? "" : result.message || "没有找到可更新的记录。" }
  }

  review(id: string, action: "accept" | "reject", candidate?: string) {
    this.store.change(state => {
      const proposal = state.proposals.find(entry => entry.id === id)
      if (!proposal) throw new Conflict("这条建议已不存在。")
      const status = action === "accept" ? "accepted" : "rejected"
      if (proposal.status === status) return
      if (proposal.status !== "pending") throw new Conflict("这条建议已经处理。")
      if (action === "accept") {
        if (proposal.kind === "complete") {
          const task = state.items.find(item => item.id === candidate && item.kind === "task")
          if (!task || !proposal.candidates.includes(task.id)) throw new Conflict("请先选择要完成的待办。")
          task.done = true
          for (const other of state.proposals) {
            if (other.id !== id && other.status === "pending" && other.kind === "complete") {
              other.candidates = other.candidates.filter(entry => entry !== task.id)
              if (!other.candidates.length) other.status = "rejected"
            }
          }
        } else {
          const duplicate = state.items.some(item => item.kind === proposal.kind && !item.done &&
            item.due === (proposal.kind === "task" ? proposal.due : null) && normalize(item.text) === normalize(proposal.text))
          if (!duplicate) addItem(state, proposal, proposal.id)
        }
      }
      proposal.status = status
    })
  }

  edit(id: string, text: string, due: string | null) {
    this.store.change(state => {
      const item = state.items.find(entry => entry.id === id)
      if (!item) throw new Conflict("这条记录已不存在。")
      if (item.text !== text) {
        for (const proposal of state.proposals) {
          if (proposal.status !== "pending" || !proposal.candidates.includes(id)) continue
          proposal.candidates = proposal.candidates.filter(candidate => candidate !== id)
          if (!proposal.candidates.length) proposal.status = "rejected"
        }
      }
      item.text = text
      item.due = item.kind === "task" ? validDue(due) : null
    })
  }

  get isSummarizing() { return this.summarizing }

  async summarize() {
    if (this.summarizing) throw new Conflict("正在汇总，请稍候。")
    this.summarizing = true
    let count = 0
    try {
      const sources = this.eligibleSources()
      for (let offset = 0; offset < sources.length; offset += 6) {
        const batch = sources.slice(offset, offset + 6).filter(source => this.isAuthorized(source))
        if (!batch.length) continue
        const tasks = openTasks(this.store.state)
        const result = await this.model({ text: "", items: tasks, sources: batch,
          today: localDay(), model: this.store.state.settings.model })
        if (batch.some(source => !this.isAuthorized(source))) {
          throw new Error("项目授权已变更，本批汇总已中止。")
        }
        this.store.change(state => {
          const activeTasks = openTasks(state).filter(item => tasks.some(before => before.id === item.id && before.text === item.text))
          for (const operation of result.operations.slice(0, 50)) {
            const proposal = toProposal(operation, activeTasks, batch)
            if (!proposal) continue
            if (proposal.kind !== "complete" && state.items.some(item => item.kind === proposal.kind && !item.done &&
              normalize(item.text) === normalize(proposal.text) && item.due === (proposal.kind === "task" ? proposal.due : null))) continue
            if (queue(state, proposal).id === proposal.id) count++
          }
          state.processed.push(...batch.map(source => source.id))
        })
      }
      this.store.change(state => { delete state.schedule.error })
      return count
    } catch (error) {
      this.store.change(state => {
        state.schedule.error = error instanceof Error ? error.message : "汇总失败。"
      })
      throw error
    } finally {
      this.summarizing = false
      if (count) this.notify("Codex 汇总新增 " + count + " 条待确认建议。")
    }
  }

  eligibleSources() { return this.store.unprocessed().filter(source => this.isAuthorized(source)) }

  private isAuthorized(source: Source) {
    return this.store.state.settings.projects.some(project => project.path === source.project && project.allowModel)
  }

  reminder(now = new Date(), slot?: string) {
    const tasks = openTasks(this.store.state).filter(item => item.due && item.due <= localDay(now))
    const pending = this.store.state.proposals.filter(item => item.status === "pending").length
    const names = tasks.slice(0, 3).map(task => task.text.replace(/\s+/g, " ").slice(0, 48))
    const message = "到期或逾期 " + tasks.length + " 项，待确认 " + pending + " 项。" + names.join("、")
    this.store.change(state => {
      state.schedule.notice = message
      if (slot) state.schedule.reminder = slot
    })
    if (tasks.length || pending) this.notify(message)
  }

  view() {
    const { state } = this.store
    const pendingSources = this.store.unprocessed()
    const proposals = state.proposals.filter(proposal => proposal.status === "pending").map(proposal => ({
      ...proposal, sources: proposal.evidence.flatMap(id => {
        const source = this.store.source(id)
        return source ? [{ project: basename(source.project), session: source.session, turn: source.turn,
          receivedAt: source.receivedAt, excerpt: source.text.slice(0, 1200) }] : []
      })
    }))
    return {
      items: state.items, proposals, settings: state.settings, schedule: state.schedule,
      waiting: pendingSources.filter(source => this.isAuthorized(source)).length,
      localOnly: pendingSources.filter(source => !this.isAuthorized(source)).length,
      summarizing: this.summarizing, markdownPath: this.store.markdownPath, exportError: this.store.exportError
    }
  }
}

export function notifyMac(message: string) {
  if (process.platform !== "darwin") return
  const script = 'on run argv\ndisplay notification (item 1 of argv) with title "Memo"\nend run'
  execFile("/usr/bin/osascript", ["-e", script, message], { timeout: 5000 }, error => {
    if (error) console.warn("Memo: macOS 通知发送失败。")
  })
}

export function latestSlot(now: Date, time: string) {
  const [hour, minute] = time.split(":").map(Number)
  const slot = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute)
  if (slot > now) return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, hour, minute)
  return slot
}

export function schedule(memo: Memo, now = new Date()) {
  const { state } = memo.store
  const slots = (["reminder", "summary"] as const)
    .map(kind => ({ kind, slot: latestSlot(now, state.settings[kind === "reminder" ? "reminderTime" : "summaryTime"]) }))
    .filter(({ kind, slot }) => +slot >= Date.parse(state.schedule.createdAt) && (!state.schedule[kind] || localDay(slot) > state.schedule[kind]!))
    .sort((a, b) => +a.slot - +b.slot)
  for (const { kind, slot } of slots) {
    const day = localDay(slot)
    if (kind === "reminder") {
      memo.reminder(now, day)
    } else if (!memo.isSummarizing) {
      void memo.summarize()
        .catch(error => console.warn("Memo:", error.message))
        .then(() => memo.store.change(next => { next.schedule.summary = day }))
        .catch(error => console.error("Memo: 无法保存汇总进度。", error))
    }
  }
}
