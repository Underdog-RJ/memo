import copy
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from .provider import model_provider


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def default_data_dir() -> Path:
    return Path(os.getenv("MEMO_DATA_DIR") or Path.home() / "Library/Application Support/Memo").resolve()


def atomic_write(path: Path, text: str, *, exclusive: bool = False) -> None:
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
    temp = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", errors="backslashreplace") as file:
            file.write(text)
            file.flush()
            os.fsync(file.fileno())
        if exclusive:
            os.link(temp, path)
        else:
            os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def escape_markdown(text: str) -> str:
    escaped = re.sub(r"([\\`*_{}\[\]()#+.!|<>~])", r"\\\1", text)
    return re.sub(r"\r?\n", "  \n  ", escaped)


class Store:
    def __init__(self, directory: Path):
        self.directory = directory.resolve()
        self.state_path = self.directory / "state.json"
        self.inbox_path = self.directory / "codex"
        self.markdown_path = self.directory / "备忘录.md"
        self.export_error = ""
        self.directory.mkdir(parents=True, mode=0o700, exist_ok=True)
        self.inbox_path.mkdir(mode=0o700, exist_ok=True)
        try:
            self.state = json.loads(self.state_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            self.state = {
                "settings": {
                    "model": model_provider()["defaultModel"],
                    "reminderTime": "09:00", "summaryTime": "21:00", "projects": [],
                },
                "items": [], "proposals": [], "processed": [],
                "schedule": {"createdAt": timestamp()},
            }
            atomic_write(self.state_path, json.dumps(self.state, ensure_ascii=False, indent=2))
        self.export_markdown()

    def change(self, apply):
        # Callbacks are synchronous. Requests and the scheduler commit on one event loop.
        updated = copy.deepcopy(self.state)
        result = apply(updated)
        atomic_write(self.state_path, json.dumps(updated, ensure_ascii=False, indent=2))
        items_changed = updated["items"] != self.state["items"]
        self.state = updated
        if items_changed or self.export_error:
            self.export_markdown()
        return result

    def source(self, source_id: str) -> dict | None:
        if not re.fullmatch(r"[a-f0-9]{64}", source_id):
            return None
        try:
            return json.loads((self.inbox_path / (source_id + ".json")).read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None

    def unprocessed(self) -> list[dict]:
        processed = set(self.state["processed"])
        sources = (self.source(path.stem) for path in self.inbox_path.glob("*.json") if path.stem not in processed)
        return sorted((source for source in sources if source), key=lambda source: source["receivedAt"])

    def export_markdown(self):
        sections = ["# 备忘录", "## 待办"]
        for item in self.state["items"]:
            if item["kind"] != "task":
                continue
            mark = "x" if item["done"] else " "
            due = f"（{item['due']}）" if item["due"] else ""
            sections.append(f"- [{mark}] {escape_markdown(item['text'])}{due}")
        sections.append("## 笔记")
        sections.extend("- " + escape_markdown(item["text"]) for item in self.state["items"] if item["kind"] == "note")
        try:
            atomic_write(self.markdown_path, "\n\n".join(sections) + "\n")
            self.export_error = ""
        except OSError:
            self.export_error = "Markdown 暂未导出。应用内记录已保存，后续保存或重启时会重试。"
