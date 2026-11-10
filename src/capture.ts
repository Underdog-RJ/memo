import { createHash, randomUUID } from "node:crypto"
import { linkSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { defaultDataDir, type Source, type State } from "./store.js"

try {
  const event = JSON.parse(readFileSync(0, "utf8"))
  if (
    event.hook_event_name === "Stop" &&
    typeof event.cwd === "string" &&
    typeof event.session_id === "string" &&
    typeof event.turn_id === "string" &&
    typeof event.last_assistant_message === "string" &&
    event.last_assistant_message.trim()
  ) {
    const directory = defaultDataDir()
    const state: State = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"))
    const project = realpathSync(event.cwd)
    if (state.settings.projects.some(entry => entry.path === project)) {
      const id = createHash("sha256").update(JSON.stringify([event.session_id, event.turn_id])).digest("hex")
      const source: Source = {
        id, project, session: event.session_id, turn: event.turn_id,
        receivedAt: new Date().toISOString(), text: event.last_assistant_message.trim().slice(0, 12_000)
      }
      const target = join(directory, "codex", id + ".json")
      const temp = target + "." + randomUUID() + ".tmp"
      try {
        writeFileSync(temp, JSON.stringify(source), { mode: 0o600, flag: "wx", flush: true })
        linkSync(temp, target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      } finally {
        rmSync(temp, { force: true })
      }
    }
  }
} catch (error) {
  // Collection never blocks a Codex turn.
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") process.stderr.write("Memo: 无法收集本轮回复。\n")
}
process.stdout.write("{}\n")
