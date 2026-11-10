import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { homedir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const label = "local.memo.agent"
const target = "gui/" + userInfo().uid
const plist = join(homedir(), "Library", "LaunchAgents", label + ".plist")
const logs = join(homedir(), "Library", "Application Support", "Memo")
const launchctl = (...args) => spawnSync("/bin/launchctl", args, { stdio: "inherit" })
const xml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

if (process.platform !== "darwin") throw new Error("登录启动仅支持 macOS。")
const action = process.argv[2]
if (action === "disable") {
  if (existsSync(plist)) {
    launchctl("bootout", target, plist)
    rmSync(plist)
  }
  console.log("已移除 Memo 登录启动。")
} else if (action === "enable") {
  if (!existsSync(join(root, "dist/server.js"))) throw new Error("请先运行 npm run build。")
  mkdirSync(dirname(plist), { recursive: true })
  mkdirSync(logs, { recursive: true, mode: 0o700 })
  if (existsSync(plist)) launchctl("bootout", target, plist)
  const args = [process.execPath, "--env-file-if-exists=.env", join(root, "dist/server.js")]
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(arg => "<string>" + xml(arg) + "</string>").join("")}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>StandardOutPath</key><string>${xml(join(logs, "server.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(logs, "server-error.log"))}</string>
</dict></plist>
`, { mode: 0o600 })
  if (launchctl("bootstrap", target, plist).status !== 0) process.exitCode = 1
  else console.log("Memo 已设置为登录后启动。")
} else {
  console.log("用法：npm run login -- enable|disable")
  process.exitCode = 1
}
