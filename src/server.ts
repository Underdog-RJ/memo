import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { readFileSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { defaultDataDir, Store } from "./store.js"
import { claude } from "./model.js"
import { modelProvider } from "./provider.js"
import { Conflict, Memo, notifyMac, schedule, validDue } from "./memo.js"

const root = fileURLToPath(new URL("../", import.meta.url))
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]]
])
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const settingsSchema = z.object({
  model: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9._:-]+$/),
  reminderTime: clock, summaryTime: clock,
  projects: z.array(z.object({ path: z.string().trim().min(1).max(4096), allowModel: z.boolean() })).max(40)
})
const inputSchema = z.object({ text: z.string().trim().min(1).max(4000) })
const editSchema = z.object({
  text: z.string().trim().min(1).max(2000), due: z.string().nullable().refine(value => value === null || validDue(value) === value)
})
const reviewSchema = z.object({ action: z.enum(["accept", "reject"]), candidate: z.uuid().optional() })

class BadRequest extends Error {}

async function body(request: IncomingMessage) {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new BadRequest("需要 JSON 请求。")
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > 256_000) {
      request.resume()
      throw new BadRequest("请求内容过长。")
    }
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) }
  catch { throw new BadRequest("JSON 格式有误。") }
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

function hookConfig(directory: string) {
  const command = "MEMO_DATA_DIR=" + quote(directory) + " " + quote(process.execPath) + " " + quote(join(root, "dist", "capture.js"))
  return { hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } }
}

export function startServer(memo: Memo, port: number, host = "127.0.0.1") {
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const address = server.address()
    if (!address || typeof address === "string") return response.writeHead(503).end()
    const authority = host + ":" + address.port
    const origin = "http://" + authority
    response.setHeader("Cache-Control", "no-store")
    response.setHeader("X-Content-Type-Options", "nosniff")
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
    const json = (status: number, value: unknown) => response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(value))
    if (request.headers.host !== authority) return json(403, { error: "请通过本机地址访问 Memo。" })
    const method = request.method
    const route = request.url
    if (method !== "GET" && (request.headers.origin !== origin || request.headers["x-memo-request"] !== "1")) {
      return json(403, { error: "请求来源无效。" })
    }
    try {
      if (method === "GET") {
        if (route === "/api/state") {
          const provider = modelProvider()
          return json(200, { ...memo.view(), provider, configured: Boolean(process.env[provider.keyName]?.trim()),
            hookConfig: hookConfig(memo.store.directory) })
        }
        const asset = route && assets.get(route)
        if (asset) return response.writeHead(200, { "Content-Type": asset[1] }).end(readFileSync(join(root, "public", asset[0])))
      }
      if (method === "POST") {
        if (route === "/api/input") return json(200, await memo.input(inputSchema.parse(await body(request)).text))
        if (route === "/api/summary") return json(200, { count: await memo.summarize() })
        const review = route?.match(/^\/api\/proposals\/([\w-]+)$/)
        if (review) {
          const { action, candidate } = reviewSchema.parse(await body(request))
          memo.review(review[1], action, candidate)
          return json(200, {})
        }
      }
      if (method === "PUT") {
        if (route === "/api/settings") {
          const settings = settingsSchema.parse(await body(request))
          const unique = new Map<string, boolean>()
          for (const project of settings.projects) {
            try {
              if (!isAbsolute(project.path)) throw new Error()
              const path = realpathSync(project.path)
              if (!statSync(path).isDirectory()) throw new Error()
              if (unique.has(path)) throw new BadRequest("项目目录重复：" + project.path)
              unique.set(path, project.allowModel)
            } catch (error) {
              if (error instanceof BadRequest) throw error
              throw new BadRequest("项目路径需要是本机已存在的绝对目录：" + project.path)
            }
          }
          settings.projects = [...unique].map(([path, allowModel]) => ({ path, allowModel }))
          memo.store.change(state => { state.settings = settings })
          return json(200, {})
        }
        const edit = route?.match(/^\/api\/items\/([\w-]+)$/)
        if (edit) {
          const { text, due } = editSchema.parse(await body(request))
          memo.edit(edit[1], text, due)
          return json(200, {})
        }
      }
      return json(404, { error: "找不到这个页面。" })
    } catch (error) {
      if (error instanceof z.ZodError) return json(400, { error: "输入格式有误，请检查内容、时间和模型名称。" })
      if (error instanceof BadRequest || error instanceof Conflict) return json(error instanceof Conflict ? 409 : 400, { error: error.message })
      const message = error instanceof Error && /^(Claude|请在项目|项目授权)/.test(error.message)
        ? error.message : "保存或处理失败，请检查本地服务日志。"
      if (message.startsWith("保存")) console.error("Memo:", error)
      return json(500, { error: message })
    }
  })
  return server.listen(port, host)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.MEMO_PORT ?? "4317")
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MEMO_PORT 无效。")
  const memo = new Memo(new Store(defaultDataDir()), claude, notifyMac)
  const server = startServer(memo, port)
  server.on("listening", () => {
    console.log("Memo · http://127.0.0.1:" + port)
    const tick = () => {
      try { schedule(memo) }
      catch (error) { console.error("Memo 定时任务失败", error) }
    }
    tick()
    setInterval(tick, 15_000).unref()
  })
}
