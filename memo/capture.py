import hashlib
import json
import re
import sys
from pathlib import Path

from .store import atomic_write, default_data_dir, timestamp


MEMO_REQUEST = re.compile(
    r"^\s*(?:(?:请)?帮我(?:记录一下|记录|记下来|记一下|记一笔|记个(?:备忘录|备忘|待办))"
    r"|请(?:记一下|记录一下)|记个(?:备忘录|备忘|待办)|memo\s*[:：])",
    re.IGNORECASE,
)


def source_id_for(session: str, turn: str, kind: str) -> str:
    identity = [session, turn]
    if kind == "user_memo":
        identity.append(kind)
    serialized = json.dumps(identity, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(serialized.encode()).hexdigest()


def capture(event: dict) -> None:
    name = event.get("hook_event_name")
    if name not in ("Stop", "UserPromptSubmit"):
        return
    field = "prompt" if name == "UserPromptSubmit" else "last_assistant_message"
    fields = ("cwd", "session_id", "turn_id", field)
    if any(not isinstance(event.get(key), str) for key in fields):
        return
    text = event[field].strip()
    if not text:
        return
    kind = "assistant"
    if name == "UserPromptSubmit":
        match = MEMO_REQUEST.match(text)
        if not match or not text[match.end():].strip(" ，。:：,.！!？?"):
            return
        kind = "user_memo"
    directory = default_data_dir()
    state = json.loads((directory / "state.json").read_text(encoding="utf-8"))
    project = str(Path(event["cwd"]).resolve(strict=True))
    if not any(entry["path"] == project for entry in state["settings"]["projects"]):
        return
    session, turn = event["session_id"], event["turn_id"]
    inbox = directory / "codex"
    if kind == "assistant" and (inbox / (source_id_for(session, turn, "user_memo") + ".json")).exists():
        return
    source_id = source_id_for(session, turn, kind)
    source = {
        "id": source_id, "project": project, "session": session, "turn": turn,
        "receivedAt": timestamp(), "text": text[:12000], "kind": kind,
    }
    atomic_write(inbox / (source_id + ".json"), json.dumps(source, ensure_ascii=False), exclusive=True)


def main() -> None:
    try:
        event = json.load(sys.stdin)
        if isinstance(event, dict):
            capture(event)
    except (FileNotFoundError, FileExistsError):
        pass
    except (OSError, ValueError, KeyError):
        print("Memo: 无法收集本轮回复。", file=sys.stderr)
    print("{}")


if __name__ == "__main__":
    main()
