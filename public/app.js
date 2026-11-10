const $ = id => document.getElementById(id)
const element = (tag, text = "", className = "") => {
  const node = document.createElement(tag)
  node.textContent = text
  node.className = className
  return node
}
const button = (text, callback, className = "subtle") => {
  const node = element("button", text, className)
  node.type = "button"
  node.addEventListener("click", () => run(node, callback))
  return node
}
const dateText = new Intl.DateTimeFormat("zh-CN", { dateStyle: "full" })
$("today").textContent = dateText.format(new Date())

let current
let rendered = ""
let polling = false
let interactions = 0

async function api(path, method = "GET", body) {
  const response = await fetch(path, {
    method,
    headers: method === "GET" ? {} : { "Content-Type": "application/json", "X-Memo-Request": "1" },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error)
  return data
}

function feedback(text, error = false) {
  $("feedback").textContent = text
  $("feedback").hidden = !text
  $("feedback").classList.toggle("error", error)
}

async function run(control, action) {
  interactions++
  control.disabled = true
  try { await action() }
  catch (error) { feedback(error.message, true) }
  finally {
    interactions--
    control.disabled = false
    updateControls()
  }
}

function updateControls() {
  if (!current || interactions) return
  $("run-summary").disabled = current.summarizing || !current.waiting || !current.configured
  $("run-summary").textContent = current.summarizing ? "正在汇总…" : current.schedule.error ? "重试汇总" : "立即汇总"
  $("capture").querySelector("button").disabled = !current.configured
}

function projectRow(project = { path: "", allowModel: false }) {
  const row = element("div", "", "project-row")
  const path = element("input")
  path.placeholder = "/Users/you/project"
  path.setAttribute("aria-label", "项目目录")
  path.value = project.path
  path.required = true
  const check = element("input")
  check.type = "checkbox"
  check.checked = project.allowModel
  const label = element("label", " 允许模型处理")
  label.prepend(check)
  row.append(path, label, button("移除", () => row.remove()))
  $("projects").append(row)
}

function loadSettings() {
  const { settings, hookConfig, markdownPath } = current
  $("model").value = settings.model
  $("model").placeholder = current.provider.defaultModel
  $("reminder").value = settings.reminderTime
  $("summary").value = settings.summaryTime
  $("projects").replaceChildren()
  settings.projects.forEach(projectRow)
  $("path").textContent = markdownPath
  $("hook").textContent = JSON.stringify(hookConfig, null, 2)
}

function record(item) {
  const entry = element("article", "", "record" + (item.done ? " completed" : ""))
  const title = element("div", "", "row")
  title.append(element("p", item.text, "record-text"), button("编辑", async () => {
    const text = window.prompt("编辑记录", item.text)
    if (text === null || !text.trim()) return
    const due = item.kind === "task" ? window.prompt("到期日期（YYYY-MM-DD，留空表示无日期）", item.due || "") : ""
    if (due === null) return
    await api("/api/items/" + item.id, "PUT", { text, due: due.trim() || null })
    await refresh()
    feedback("记录已保存。")
  }))
  entry.append(title)
  if (item.due) entry.append(element("p", "到期 " + item.due, "muted"))
  return entry
}

function renderItems() {
  const target = $("items")
  const tasks = current.items.filter(item => item.kind === "task" && !item.done)
  const notes = current.items.filter(item => item.kind === "note")
  const completed = current.items.filter(item => item.done)
  $("item-count").textContent = tasks.length + " 项待办"
  target.replaceChildren()
  if (!current.items.length) target.append(element("p", "还没有记录，先记一笔吧。", "muted"))
  for (const [title, items] of [["进行中", tasks], ["笔记", notes]]) {
    if (items.length) target.append(element("h3", title), ...items.map(record))
  }
  if (completed.length) {
    const group = element("details", "", "section-line")
    group.append(element("summary", "已完成 · " + completed.length), ...completed.map(record))
    target.append(group)
  }
}

function renderProposals() {
  const target = $("proposals")
  $("inbox-count").textContent = current.proposals.length + " 条"
  target.replaceChildren()
  if (!current.proposals.length) target.append(element("p", "有更新建议时，会出现在这里。", "muted"))
  for (const proposal of current.proposals) {
    const entry = element("article", "", "proposal")
    const complete = proposal.kind === "complete"
    const candidates = proposal.candidates.map(id => current.items.find(item => item.id === id)).filter(Boolean)
    entry.append(element("p", (complete ? "建议完成" : proposal.kind === "task" ? "建议新增待办" : "建议新增笔记"), "proposal-title"))
    entry.append(element("p", proposal.text + (proposal.due && !complete ? "（" + proposal.due + "）" : "")))
    if (proposal.sources.length) {
      const evidence = element("details")
      evidence.append(element("summary", "Codex 来源 · " + proposal.sources.length + " 条"))
      for (const source of proposal.sources) {
        const snippet = element("blockquote", source.excerpt)
        snippet.append(element("p", source.project + " · " + source.session + " / " + source.turn, "muted"))
        evidence.append(snippet)
      }
      entry.append(evidence)
    }
    const actions = element("div", "", "actions")
    const choice = element("select")
    if (complete) {
      choice.setAttribute("aria-label", "选择要完成的待办")
      if (candidates.length > 1) choice.add(new Option("请选择待办", ""))
      for (const task of candidates) choice.add(new Option(task.text, task.id))
      actions.append(choice)
    }
    const review = async action => {
      if (complete && action === "accept" && !choice.value) throw new Error("请先选择要完成的待办。")
      await api("/api/proposals/" + proposal.id, "POST", { action, candidate: choice.value || undefined })
      await refresh()
      feedback(action === "accept" ? "已更新备忘录。" : "已驳回这条建议。")
    }
    actions.append(button("确认", () => review("accept"), "primary"), button("驳回", () => review("reject")))
    entry.append(actions)
    target.append(entry)
  }
}

async function refresh() {
  const data = await api("/api/state")
  current = data
  const signature = JSON.stringify([data.items, data.proposals])
  if (signature !== rendered) {
    rendered = signature
    renderItems()
    renderProposals()
  }
  $("setup").textContent = "在项目的 .env 中设置 " + data.provider.keyName + " 后重启，即可使用自然语言录入和汇总。"
  $("setup").hidden = data.configured
  $("queue").textContent = [
    data.waiting ? data.waiting + " 条 Codex 回复待汇总" : "没有待汇总的 Codex 回复",
    data.localOnly ? data.localOnly + " 条仅留本机" : ""
  ].filter(Boolean).join(" · ")
  $("schedule-text").textContent = data.settings.reminderTime + " 提醒 · " + data.settings.summaryTime + " 汇总"
  const issue = data.schedule.error || data.exportError
  $("schedule-error").textContent = issue || ""
  $("schedule-error").hidden = !issue
  updateControls()
}

$("capture").addEventListener("submit", event => {
  event.preventDefault()
  run(event.submitter, async () => {
    feedback("Claude 正在整理…")
    const result = await api("/api/input", "POST", { text: $("text").value })
    $("text").value = ""
    await refresh()
    feedback([result.added ? "已保存 " + result.added + " 条。" : "",
      result.pending.length ? "有 " + result.pending.length + " 条待确认。" : "", result.message].filter(Boolean).join(" "))
    if (result.pending.length) $("inbox").scrollIntoView({ block: "nearest" })
  })
})
$("settings-toggle").addEventListener("click", () => {
  if (!current) return
  if ($("settings").hidden) loadSettings()
  $("settings").hidden = !$("settings").hidden
})
$("close-settings").addEventListener("click", () => { $("settings").hidden = true })
$("add-project").addEventListener("click", () => projectRow())
$("copy-hook").addEventListener("click", event => run(event.currentTarget, async () => {
  await navigator.clipboard.writeText($("hook").textContent)
  feedback("已复制 Hook 配置。")
}))
$("preferences").addEventListener("submit", event => {
  event.preventDefault()
  run(event.submitter, async () => {
    const projects = [...$("projects").children].map(row => ({
      path: row.querySelector("input").value, allowModel: row.querySelector("input[type=checkbox]").checked
    }))
    await api("/api/settings", "PUT", {
      model: $("model").value, reminderTime: $("reminder").value, summaryTime: $("summary").value, projects
    })
    await refresh()
    loadSettings()
    feedback("设置已保存。")
  })
})
$("run-summary").addEventListener("click", event => run(event.currentTarget, async () => {
  feedback("正在汇总 Codex 回复…")
  const result = await api("/api/summary", "POST")
  await refresh()
  feedback("汇总完成，新增 " + result.count + " 条待确认建议。")
}))

refresh().catch(error => feedback(error.message, true))
setInterval(async () => {
  if (polling || interactions) return
  polling = true
  try { await refresh() }
  catch (error) { feedback(error.message, true) }
  finally { polling = false }
}, 5000)
