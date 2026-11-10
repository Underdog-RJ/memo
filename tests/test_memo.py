import asyncio
import hashlib
import json
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from memo.capture import capture, source_id_for
from memo.model import Answer, Operation
from memo.server import create_app
from memo.service import Conflict, Memo, latest_slot, run_schedule
from memo.store import Store


def op(kind, text, *, due=None, candidates=(), evidence=()):
    return Operation(kind=kind, text=text, due=due, candidates=list(candidates), evidence=list(evidence))


def answer(*operations):
    return Answer(operations=list(operations), message="")


def codex_event(project, turn, name="Stop", text="登录超时已修复。还需要验证支付回调。"):
    return {
        "hook_event_name": name, "cwd": str(project), "session_id": "test-session", "turn_id": turn,
        "prompt" if name == "UserPromptSubmit" else "last_assistant_message": text,
    }


def test_manual_input_and_confirmation(tmp_path):
    async def model(**request):
        if request["text"] == "新增":
            return answer(op("task", "修复登录超时"), op("task", "检查登录审计"))
        return answer(
            op("task", "验证支付回调", due="2026-11-11"),
            op("complete", "登录那块搞定了", candidates=["invented", *(item["id"] for item in request["items"])]),
        )

    memo = Memo(Store(tmp_path), model, lambda _: None)
    asyncio.run(memo.input("新增"))
    result = asyncio.run(memo.input("登录那块搞定了，明天看一下支付回调"))
    assert result["added"] == 1
    proposal = memo.view()["proposals"][0]
    assert len(proposal["candidates"]) == 2
    with pytest.raises(Conflict):
        memo.review(proposal["id"], "accept", "invented")
    assert not any(item["done"] for item in memo.view()["items"])
    task = next(item for item in memo.view()["items"] if item["text"] == "修复登录超时")
    memo.review(proposal["id"], "accept", task["id"])
    memo.review(proposal["id"], "accept", task["id"])
    restarted = Store(tmp_path)
    assert "- [x] 修复登录超时" in restarted.markdown_path.read_text()
    assert any(item["id"] == task["id"] and item["done"] for item in restarted.state["items"])


def test_capture_authorization_retry_and_dedup(tmp_path, monkeypatch):
    monkeypatch.setenv("MEMO_DATA_DIR", str(tmp_path))
    fail = True

    async def model(**request):
        nonlocal fail
        if fail:
            fail = False
            raise RuntimeError("模型离线")
        return answer(
            op("task", "验证支付回调", evidence=[source["id"] for source in request["sources"]]),
            op("task", "无来源的建议", evidence=["invented"]),
        )

    memo = Memo(Store(tmp_path), model, lambda _: None)
    capture(codex_event(tmp_path, "unselected"))
    assert not memo.store.unprocessed()
    memo.store.change(lambda state: state["settings"].update(projects=[{"path": str(tmp_path), "allowModel": False}]))
    capture(codex_event(tmp_path, "one"))
    with pytest.raises(FileExistsError):
        capture(codex_event(tmp_path, "one"))
    assert memo.view()["localOnly"] == 1
    assert asyncio.run(memo.summarize()) == 0
    memo.store.change(lambda state: state["settings"]["projects"][0].update(allowModel=True))
    with pytest.raises(RuntimeError, match="模型离线"):
        asyncio.run(memo.summarize())
    assert memo.view()["waiting"] == 1
    assert asyncio.run(memo.summarize()) == 1
    capture(codex_event(tmp_path, "two"))
    assert asyncio.run(memo.summarize()) == 0
    proposal = memo.view()["proposals"][0]
    assert len(proposal["sources"]) == 2
    assert not memo.view()["items"]
    memo.review(proposal["id"], "accept")
    assert memo.view()["items"][0]["text"] == "验证支付回调"


def test_codex_prompt_records_without_web_input(tmp_path, monkeypatch):
    monkeypatch.setenv("MEMO_DATA_DIR", str(tmp_path))

    async def model(**request):
        source = request["sources"][0]
        assert source["kind"] == "user_memo"
        if request["items"]:
            return answer(op("complete", "支付回调完成", candidates=[request["items"][0]["id"]], evidence=[source["id"]]))
        return answer(op("task", "验证支付回调", evidence=[source["id"]]))

    memo = Memo(Store(tmp_path), model, lambda _: None)
    memo.store.change(lambda state: state["settings"].update(projects=[{"path": str(tmp_path), "allowModel": True}]))
    capture(codex_event(tmp_path, "ordinary", "UserPromptSubmit", "帮我看看支付回调"))
    assert not memo.store.unprocessed()
    capture(codex_event(tmp_path, "record", "UserPromptSubmit", "帮我记一下：验证支付回调"))
    capture(codex_event(tmp_path, "record"))
    assert len(memo.store.unprocessed()) == 1
    asyncio.run(memo.summarize(explicit_only=True))
    assert memo.view()["items"][0]["text"] == "验证支付回调"
    assert not memo.view()["proposals"]
    capture(codex_event(tmp_path, "done", "UserPromptSubmit", "帮我记一下：支付回调做完了"))
    asyncio.run(memo.summarize(explicit_only=True))
    assert not memo.view()["items"][0]["done"]
    assert memo.view()["proposals"][0]["kind"] == "complete"


def test_previous_json_and_hook_ids_are_compatible(tmp_path):
    source_id = hashlib.sha256(b'["test-session","old"]').hexdigest()
    (tmp_path / "codex").mkdir()
    state = {
        "settings": {"model": "deepseek-flash", "reminderTime": "09:00", "summaryTime": "21:00", "projects": []},
        "items": [{"id": "previous", "kind": "note", "text": "已有笔记", "due": None, "done": False, "createdAt": "2026-11-10T01:00:00.000Z"}],
        "proposals": [], "processed": [], "schedule": {"createdAt": "2026-11-10T01:00:00.000Z"},
    }
    (tmp_path / "state.json").write_text(json.dumps(state))
    (tmp_path / "codex" / (source_id + ".json")).write_text(json.dumps({
        "id": source_id, "project": "/demo", "session": "test-session", "turn": "old",
        "receivedAt": "2026-11-10T01:00:00.000Z", "text": "已有 Codex 回复",
    }))
    store = Store(tmp_path)
    assert source_id_for("test-session", "old", "assistant") == source_id
    assert store.state == state
    assert store.unprocessed()[0]["text"] == "已有 Codex 回复"
    assert "已有笔记" in store.markdown_path.read_text()


def test_schedule_catches_up_once(tmp_path):
    notices = []

    async def model(**request):
        return answer(op("task", "到期待办", due="2026-11-10"))

    memo = Memo(Store(tmp_path), model, notices.append)
    memo.store.change(lambda state: state["schedule"].update(createdAt=datetime(2026, 11, 10, 8).astimezone().isoformat()))
    asyncio.run(memo.input("记一笔"))
    wake = datetime(2026, 11, 11, 8)
    assert latest_slot(wake, "21:00") == datetime(2026, 11, 10, 21)
    asyncio.run(run_schedule(memo, wake))
    asyncio.run(run_schedule(memo, wake))
    assert len(notices) == 1
    assert memo.store.state["schedule"]["summary"] == "2026-11-10"
    assert memo.store.state["schedule"]["reminder"] == "2026-11-10"


def test_http_routes_and_cross_origin_writes(tmp_path):
    async def model(**request):
        return answer(op("note", "网页笔记"))

    memo = Memo(Store(tmp_path), model, lambda _: None)
    url = "http://127.0.0.1:4317"
    with TestClient(create_app(memo, 4317), base_url=url) as client:
        assert "我的备忘录" in client.get("/").text
        headers = {"Origin": url, "X-Memo-Request": "1"}
        assert client.post("/api/input", json={"text": "记一下"}, headers={**headers, "Origin": "http://example.com"}).status_code == 403
        assert client.post("/api/input", json={"text": "  "}, headers=headers).status_code == 400
        assert client.post("/api/input", json={"text": "记一下"}, headers=headers).status_code == 200
        assert client.get("/api/state").json()["items"][0]["text"] == "网页笔记"
        assert set(client.get("/api/state").json()["hookConfig"]["hooks"]) == {"UserPromptSubmit", "Stop"}
