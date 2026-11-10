import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Memo, latestSlot, localDay, schedule } from "../dist/memo.js"
import { startServer } from "../dist/server.js"
import { Store } from "../dist/store.js"

const op = (kind, text, extra = {}) => ({ kind, text, due: null, candidates: [], evidence: [], ...extra })
const answer = (...operations) => ({ operations, message: "" })

function fixture(t, model, notify = () => {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "memo-test-")))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return new Memo(new Store(directory), model, notify)
}

function capture(memo, turn, project = memo.store.directory) {
  return execFileSync(process.execPath, ["dist/capture.js"], {
    input: JSON.stringify({
      hook_event_name: "Stop", cwd: project, session_id: "test-session",
      turn_id: turn, last_assistant_message: "登录超时已修复。还需要验证支付回调。"
    }),
    env: { ...process.env, MEMO_DATA_DIR: memo.store.directory }, encoding: "utf8"
  })
}

test("adds an explicit task and waits for an unambiguous completion confirmation", async t => {
  const memo = fixture(t, async ({ text, items }) => text === "新增"
    ? answer(op("task", "修复登录超时"), op("task", "检查登录审计"))
    : answer(op("task", "验证支付回调", { due: "2026-11-11" }),
      op("complete", "登录那块搞定了", { candidates: ["invented", ...items.map(item => item.id)] })))
  await memo.input("新增")
  const result = await memo.input("登录那块搞定了，明天看一下支付回调")
  assert.equal(result.added, 1)
  assert.equal(result.pending.length, 1)
  const proposal = memo.view().proposals[0]
  assert.equal(proposal.candidates.length, 2)
  assert.throws(() => memo.review(proposal.id, "accept", "invented"))
  assert.equal(memo.view().items.some(item => item.done), false)
  const task = memo.view().items.find(item => item.text === "修复登录超时")
  memo.review(proposal.id, "accept", task.id)
  memo.review(proposal.id, "accept", task.id)
  const restarted = new Store(memo.store.directory)
  assert.equal(restarted.state.items.find(item => item.id === task.id).done, true)
  assert.match(readFileSync(restarted.markdownPath, "utf8"), /- \[x\] 修复登录超时/)
})

test("captures only selected Codex projects, gates inference, and retries without duplicate proposals", async t => {
  let failures = 1
  const memo = fixture(t, async ({ sources }) => {
    if (failures-- > 0) throw new Error("模型离线")
    return answer(op("task", "验证支付回调", { evidence: sources.map(source => source.id) }),
      op("task", "无来源的建议", { evidence: ["invented"] }))
  })
  assert.equal(capture(memo, "not-selected").trim(), "{}")
  assert.equal(readdirSync(memo.store.inboxPath).length, 0)
  memo.store.change(state => { state.settings.projects = [{ path: memo.store.directory, allowModel: false }] })
  capture(memo, "one")
  capture(memo, "one")
  assert.equal(memo.view().localOnly, 1)
  assert.equal(await memo.summarize(), 0)
  memo.store.change(state => { state.settings.projects[0].allowModel = true })
  await assert.rejects(memo.summarize(), /模型离线/)
  assert.equal(memo.view().waiting, 1)
  assert.equal(await memo.summarize(), 1)
  capture(memo, "two")
  assert.equal(await memo.summarize(), 0)
  const proposal = memo.view().proposals[0]
  assert.equal(proposal.sources.length, 2)
  assert.match(proposal.sources[0].excerpt, /支付回调/)
  assert.equal(memo.view().items.length, 0)
  memo.review(proposal.id, "accept")
  assert.equal(memo.view().items[0].text, "验证支付回调")
  assert.equal(memo.view().schedule.error, undefined)
})

test("catches up after a missed slot and remembers it across checks", async t => {
  const messages = []
  const memo = fixture(t, async () => answer(op("task", "到期待办", { due: "2026-11-10" })), message => messages.push(message))
  memo.store.change(state => { state.schedule.createdAt = new Date(2026, 10, 10, 8).toISOString() })
  await memo.input("记一笔")
  const wake = new Date(2026, 10, 11, 8)
  assert.equal(localDay(latestSlot(wake, "21:00")), "2026-11-10")
  schedule(memo, wake)
  await new Promise(resolve => setImmediate(resolve))
  schedule(memo, wake)
  assert.equal(messages.length, 1)
  assert.equal(memo.store.state.schedule.summary, "2026-11-10")
  assert.equal(memo.store.state.schedule.reminder, "2026-11-10")
})

test("serves the local page and rejects cross-origin writes", async t => {
  const memo = fixture(t, async () => answer(op("note", "这是页面发来的笔记")))
  const server = startServer(memo, 0)
  await once(server, "listening")
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = "http://127.0.0.1:" + server.address().port
  assert.match(await (await fetch(url)).text(), /我的备忘录/)
  const write = origin => fetch(url + "/api/input", {
    method: "POST", headers: { Origin: origin, "X-Memo-Request": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ text: "记一下" })
  })
  assert.equal((await write("http://example.com")).status, 403)
  assert.equal((await write(url)).status, 200)
  assert.equal((await (await fetch(url + "/api/state")).json()).items[0].text, "这是页面发来的笔记")
})
