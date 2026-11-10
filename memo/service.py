import asyncio
import logging
import re
import subprocess
import sys
import unicodedata
from datetime import date, datetime, time, timedelta
from pathlib import Path
from uuid import uuid4

from .model import Operation
from .store import Store, timestamp

logger = logging.getLogger(__name__)


class Conflict(Exception):
    pass


def valid_due(value: str | None) -> str | None:
    if value is None or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        return None


def normalize(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text).split()).casefold()


def open_tasks(state: dict) -> list[dict]:
    return [item for item in state["items"] if item["kind"] == "task" and not item["done"]]


def active_tasks(state: dict, previous: list[dict]) -> list[dict]:
    titles = {item["id"]: item["text"] for item in previous}
    return [item for item in open_tasks(state) if titles.get(item["id"]) == item["text"]]


def add_item(state: dict, proposal: dict, item_id: str | None = None):
    kind = "note" if proposal["kind"] == "note" else "task"
    state["items"].insert(0, {
        "id": item_id or str(uuid4()), "kind": kind, "text": proposal["text"],
        "due": proposal["due"] if kind == "task" else None,
        "done": False, "createdAt": timestamp(),
    })


def matches(item: dict, proposal: dict) -> bool:
    return (
        item["kind"] == proposal["kind"]
        and normalize(item["text"]) == normalize(proposal["text"])
        and item["due"] == (proposal["due"] if proposal["kind"] == "task" else None)
    )


def queue(state: dict, proposal: dict) -> str:
    for existing in state["proposals"]:
        if existing["status"] != "pending" or existing["kind"] != proposal["kind"]:
            continue
        duplicate = (
            set(existing["candidates"]) == set(proposal["candidates"])
            if proposal["kind"] == "complete" else matches(existing, proposal)
        )
        if duplicate:
            existing["evidence"] = list(dict.fromkeys(existing["evidence"] + proposal["evidence"]))
            return existing["id"]
    state["proposals"].insert(0, proposal)
    return proposal["id"]


def to_proposal(operation: Operation, tasks: list[dict], sources: list[dict]) -> dict | None:
    text = operation.text.strip()[:2000]
    task_ids = {task["id"] for task in tasks}
    source_ids = {source["id"] for source in sources}
    candidates = []
    if operation.kind == "complete":
        candidates = [key for key in dict.fromkeys(operation.candidates) if key in task_ids][:8]
    evidence = [key for key in dict.fromkeys(operation.evidence) if key in source_ids]
    if not text or (operation.kind == "complete" and not candidates) or (sources and not evidence):
        return None
    return {
        "id": str(uuid4()), "kind": operation.kind, "text": text, "due": valid_due(operation.due),
        "candidates": candidates, "evidence": evidence, "status": "pending",
    }


def invalidate_candidate(state: dict, item_id: str, except_id: str = ""):
    for proposal in state["proposals"]:
        if proposal["id"] == except_id or proposal["status"] != "pending" or item_id not in proposal["candidates"]:
            continue
        proposal["candidates"].remove(item_id)
        if not proposal["candidates"]:
            proposal["status"] = "rejected"


class Memo:
    def __init__(self, store: Store, model, notify):
        self.store = store
        self.model = model
        self.notify = notify
        self.summarizing = False

    async def input(self, text: str) -> dict:
        tasks = open_tasks(self.store.state)
        result = await self.model(
            text=text, items=tasks, sources=[], today=date.today().isoformat(),
            model=self.store.state["settings"]["model"],
        )

        def apply(state):
            current = active_tasks(state, tasks)
            added, pending = 0, []
            for operation in result.operations[:25]:
                proposal = to_proposal(operation, current, [])
                if not proposal:
                    continue
                if proposal["kind"] == "complete":
                    pending.append(queue(state, proposal))
                else:
                    add_item(state, proposal)
                    added += 1
            message = "" if added or pending else result.message or "没有找到可更新的记录。"
            return {"added": added, "pending": list(dict.fromkeys(pending)), "message": message}

        return self.store.change(apply)

    def review(self, proposal_id: str, action: str, candidate: str | None = None):
        def apply(state):
            proposal = next((entry for entry in state["proposals"] if entry["id"] == proposal_id), None)
            if proposal is None:
                raise Conflict("这条建议已不存在。")
            status = "accepted" if action == "accept" else "rejected"
            if proposal["status"] == status:
                return
            if proposal["status"] != "pending":
                raise Conflict("这条建议已经处理。")
            if action == "accept":
                if proposal["kind"] == "complete":
                    task = next((item for item in open_tasks(state) if item["id"] == candidate), None)
                    if task is None or task["id"] not in proposal["candidates"]:
                        raise Conflict("请先选择要完成的待办。")
                    task["done"] = True
                    invalidate_candidate(state, task["id"], proposal_id)
                elif not any(not item["done"] and matches(item, proposal) for item in state["items"]):
                    add_item(state, proposal, proposal_id)
            proposal["status"] = status

        self.store.change(apply)

    def edit(self, item_id: str, text: str, due: str | None):
        def apply(state):
            item = next((entry for entry in state["items"] if entry["id"] == item_id), None)
            if item is None:
                raise Conflict("这条记录已不存在。")
            if item["text"] != text:
                invalidate_candidate(state, item_id)
            item["text"] = text
            item["due"] = due if item["kind"] == "task" else None

        self.store.change(apply)

    def is_authorized(self, source: dict) -> bool:
        return any(
            project["path"] == source["project"] and project["allowModel"]
            for project in self.store.state["settings"]["projects"]
        )

    async def summarize(self, *, explicit_only: bool = False) -> int:
        if self.summarizing:
            raise Conflict("正在汇总，请稍候。")
        self.summarizing = True
        count = 0
        try:
            sources = [source for source in self.store.unprocessed() if self.is_authorized(source)]
            explicit = [source for source in sources if source.get("kind") == "user_memo"]
            normal = [] if explicit_only else [source for source in sources if source.get("kind") != "user_memo"]
            groups = [(explicit, True), (normal, False)]
            batches = (
                (group[offset:offset + 6], save_new)
                for group, save_new in groups for offset in range(0, len(group), 6)
            )
            for queued, save_new in batches:
                batch = [source for source in queued if self.is_authorized(source)]
                if not batch:
                    continue
                tasks = open_tasks(self.store.state)
                result = await self.model(
                    text="", items=tasks, sources=batch, today=date.today().isoformat(),
                    model=self.store.state["settings"]["model"],
                )
                if any(not self.is_authorized(source) for source in batch):
                    raise RuntimeError("项目授权已变更，本批汇总已中止。")

                def apply(state):
                    added = 0
                    current = active_tasks(state, tasks)
                    for operation in result.operations[:50]:
                        proposal = to_proposal(operation, current, batch)
                        if not proposal:
                            continue
                        if proposal["kind"] != "complete" and any(
                            not item["done"] and matches(item, proposal) for item in state["items"]
                        ):
                            continue
                        if save_new and proposal["kind"] != "complete":
                            add_item(state, proposal)
                        elif queue(state, proposal) == proposal["id"]:
                            added += 1
                    state["processed"].extend(source["id"] for source in batch)
                    return added

                count += self.store.change(apply)
            self.store.change(lambda state: state["schedule"].pop("error", None))
            return count
        except Exception as error:
            message = str(error) if isinstance(error, RuntimeError) else "汇总失败，请重试。"
            self.store.change(lambda state: state["schedule"].update(error=message))
            raise
        finally:
            self.summarizing = False
            if count:
                self.notify(f"Codex 汇总新增 {count} 条待确认建议。")

    def reminder(self, now: datetime, slot: str):
        today = now.date().isoformat()
        tasks = [task for task in open_tasks(self.store.state) if task["due"] and task["due"] <= today]
        pending = sum(proposal["status"] == "pending" for proposal in self.store.state["proposals"])
        names = "、".join(re.sub(r"\s+", " ", task["text"])[:48] for task in tasks[:3])
        message = f"到期或逾期 {len(tasks)} 项，待确认 {pending} 项。{names}"
        self.store.change(lambda state: state["schedule"].update(notice=message, reminder=slot))
        if tasks or pending:
            self.notify(message)

    def view(self) -> dict:
        state = self.store.state
        sources = self.store.unprocessed()
        authorized = sum(self.is_authorized(source) for source in sources)
        proposals = []
        for proposal in state["proposals"]:
            if proposal["status"] != "pending":
                continue
            evidence = []
            for source_id in proposal["evidence"]:
                source = self.store.source(source_id)
                if source:
                    evidence.append({
                        "project": Path(source["project"]).name, "session": source["session"],
                        "turn": source["turn"], "receivedAt": source["receivedAt"],
                        "excerpt": source["text"][:1200], "kind": source.get("kind", "assistant"),
                    })
            proposals.append({**proposal, "sources": evidence})
        return {
            "items": state["items"], "proposals": proposals, "settings": state["settings"],
            "schedule": state["schedule"], "waiting": authorized, "localOnly": len(sources) - authorized,
            "summarizing": self.summarizing, "markdownPath": str(self.store.markdown_path),
            "exportError": self.store.export_error,
        }


def notify_mac(message: str):
    if sys.platform != "darwin":
        return
    script = 'on run argv\ndisplay notification (item 1 of argv) with title "Memo"\nend run'
    try:
        subprocess.Popen(["/usr/bin/osascript", "-e", script, message], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        logger.warning("无法启动 macOS 通知。")


def latest_slot(now: datetime, clock: str) -> datetime:
    slot = datetime.combine(now.date(), time.fromisoformat(clock))
    return slot - timedelta(days=1) if slot > now else slot


async def run_schedule(memo: Memo, now: datetime | None = None):
    now = now or datetime.now()
    state = memo.store.state
    created = datetime.fromisoformat(state["schedule"]["createdAt"]).astimezone().replace(tzinfo=None)
    slots = sorted(
        (latest_slot(now, state["settings"][kind + "Time"]), kind)
        for kind in ("reminder", "summary")
    )
    for slot, kind in slots:
        day = slot.date().isoformat()
        if slot < created or day <= memo.store.state["schedule"].get(kind, ""):
            continue
        if kind == "reminder":
            memo.reminder(now, day)
        elif not memo.summarizing:
            try:
                await memo.summarize()
            except Exception as error:
                logger.warning("汇总失败：%s", type(error).__name__)
            memo.store.change(lambda current: current["schedule"].update(summary=day))


async def schedule_loop(memo: Memo):
    retry_at = 0.0
    loop = asyncio.get_running_loop()
    while True:
        try:
            await run_schedule(memo)
            ready = any(
                source.get("kind") == "user_memo" and memo.is_authorized(source)
                for source in memo.store.unprocessed()
            )
            if ready and not memo.summarizing and loop.time() >= retry_at:
                try:
                    await memo.summarize(explicit_only=True)
                except Exception as error:
                    retry_at = loop.time() + 300
                    logger.warning("Codex 记录处理失败：%s", type(error).__name__)
        except Exception:
            logger.exception("定时任务失败")
        await asyncio.sleep(15)
