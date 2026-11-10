import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { homedir } from "node:os"

export const defaultDataDir = () => resolve(process.env.MEMO_DATA_DIR || join(homedir(), "Library", "Application Support", "Memo"))

export interface Item {
  id: string
  kind: "note" | "task"
  text: string
  due: string | null
  done: boolean
  createdAt: string
}

export interface Source {
  id: string
  project: string
  session: string
  turn: string
  text: string
  receivedAt: string
}

export interface Proposal {
  id: string
  kind: "note" | "task" | "complete"
  text: string
  due: string | null
  candidates: string[]
  evidence: string[]
  status: "pending" | "accepted" | "rejected"
}

export interface Settings {
  model: string
  reminderTime: string
  summaryTime: string
  projects: { path: string; allowModel: boolean }[]
}

export interface State {
  settings: Settings
  items: Item[]
  proposals: Proposal[]
  processed: string[]
  schedule: { createdAt: string; reminder?: string; summary?: string; error?: string; notice?: string }
}

export function writeAtomic(file: string, text: string) {
  const temp = file + "." + randomUUID() + ".tmp"
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: "wx", flush: true })
    renameSync(temp, file)
  } finally {
    rmSync(temp, { force: true })
  }
}

const escapeMarkdown = (text: string) => text.replace(/[\\`*_{}\[\]()#+.!|<>~]/g, "\\$&").replace(/\r?\n/g, "  \n  ")

export class Store {
  readonly statePath: string
  readonly inboxPath: string
  readonly markdownPath: string
  private current: State
  exportError = ""

  constructor(readonly directory: string) {
    this.statePath = join(directory, "state.json")
    this.inboxPath = join(directory, "codex")
    this.markdownPath = join(directory, "备忘录.md")
    mkdirSync(this.inboxPath, { recursive: true, mode: 0o700 })
    try {
      this.current = JSON.parse(readFileSync(this.statePath, "utf8"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      this.current = {
        settings: { model: "sonnet", reminderTime: "09:00", summaryTime: "21:00", projects: [] },
        items: [], proposals: [], processed: [], schedule: { createdAt: new Date().toISOString() }
      }
      writeAtomic(this.statePath, JSON.stringify(this.current, null, 2))
    }
    this.exportMarkdown()
  }

  get state(): Readonly<State> { return this.current }

  change(apply: (state: State) => void) {
    const next = structuredClone(this.current)
    apply(next)
    writeAtomic(this.statePath, JSON.stringify(next, null, 2))
    const itemsChanged = JSON.stringify(next.items) !== JSON.stringify(this.current.items)
    this.current = next
    if (itemsChanged || this.exportError) this.exportMarkdown()
  }

  source(id: string): Source | undefined {
    if (!/^[a-f0-9]{64}$/.test(id)) return
    try {
      return JSON.parse(readFileSync(join(this.inboxPath, id + ".json"), "utf8"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }

  unprocessed() {
    const processed = new Set(this.current.processed)
    return readdirSync(this.inboxPath)
      .filter(name => name.endsWith(".json") && !processed.has(name.slice(0, -5)))
      .map(name => this.source(name.slice(0, -5)))
      .filter((source): source is Source => Boolean(source))
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
  }

  private exportMarkdown() {
    const sections = ["# 备忘录", "## 待办",
      ...this.current.items.filter(item => item.kind === "task").map(item =>
        "- [" + (item.done ? "x" : " ") + "] " + escapeMarkdown(item.text) + (item.due ? "（" + item.due + "）" : "")),
      "## 笔记",
      ...this.current.items.filter(item => item.kind === "note").map(item => "- " + escapeMarkdown(item.text))]
    try {
      writeAtomic(this.markdownPath, sections.join("\n\n") + "\n")
      this.exportError = ""
    } catch {
      this.exportError = "Markdown 暂未导出。应用内记录已保存，后续保存或重启时会重试。"
    }
  }
}
