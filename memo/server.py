import asyncio
import json
import logging
import os
import re
import shlex
import sys
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Literal
from uuid import UUID

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from .model import claude
from .provider import model_provider
from .service import Conflict, Memo, notify_mac, schedule_loop, valid_due
from .store import Store, default_data_dir

ROOT = Path(__file__).resolve().parent.parent
HOST = "127.0.0.1"
logger = logging.getLogger(__name__)
ASSETS = {
    "/": ("index.html", "text/html"),
    "/app.js": ("app.js", "text/javascript"),
    "/style.css": ("style.css", "text/css"),
}
CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"


class BadRequest(Exception):
    pass


class Payload(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, strict=True)


class Project(Payload):
    path: str = Field(min_length=1, max_length=4096)
    allowModel: bool


class Settings(Payload):
    model: str = Field(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9._:-]+$")
    reminderTime: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    summaryTime: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    projects: list[Project] = Field(max_length=40)

    @field_validator("projects")
    @classmethod
    def real_directories(cls, entries):
        paths = set()
        for entry in entries:
            path = Path(entry.path)
            try:
                if not path.is_absolute():
                    raise ValueError
                path = path.resolve(strict=True)
                if not path.is_dir():
                    raise ValueError
            except (OSError, ValueError, RuntimeError) as error:
                raise BadRequest("项目路径需要是本机已存在的绝对目录：" + entry.path) from error
            if path in paths:
                raise BadRequest("项目目录重复：" + entry.path)
            paths.add(path)
            entry.path = str(path)
        return entries


class Input(Payload):
    text: str = Field(min_length=1, max_length=4000)


class Edit(Payload):
    text: str = Field(min_length=1, max_length=2000)
    due: str | None

    @field_validator("due")
    @classmethod
    def valid_date(cls, value):
        if value is not None and valid_due(value) is None:
            raise ValueError("到期日期无效")
        return value


class Review(Payload):
    action: Literal["accept", "reject"]
    candidate: UUID | None = None


async def parse(request: Request, schema: type[Payload]):
    if request.headers.get("content-type", "").split(";", 1)[0].strip() != "application/json":
        raise BadRequest("需要 JSON 请求。")
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > 256_000:
            raise BadRequest("请求内容过长。")
        body.extend(chunk)
    try:
        json.loads(body)
    except (ValueError, RecursionError) as error:
        raise BadRequest("JSON 格式有误。") from error
    return schema.model_validate_json(body)


def hook_config(directory: Path) -> dict:
    command = "cd " + shlex.quote(str(ROOT)) + " && MEMO_DATA_DIR=" + shlex.quote(str(directory)) + " " + shlex.join([
        sys.executable, "-m", "memo.capture",
    ])
    return {"hooks": {
        event: [{"hooks": [{"type": "command", "command": command}]}]
        for event in ("UserPromptSubmit", "Stop")
    }}


def create_app(memo: Memo, port: int, *, background: bool = False) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app):
        task = asyncio.create_task(schedule_loop(memo)) if background else None
        try:
            yield
        finally:
            if task:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    authority = f"{HOST}:{port}"

    def error(status: int, message: str):
        return JSONResponse({"error": message}, status_code=status)

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        if request.headers.get("host") != authority:
            response = error(403, "请通过本机地址访问 Memo。")
        elif request.method != "GET" and (
            request.headers.get("origin") != f"http://{authority}" or request.headers.get("x-memo-request") != "1"
        ):
            response = error(403, "请求来源无效。")
        else:
            try:
                response = await call_next(request)
            except BadRequest as exc:
                response = error(400, str(exc))
            except ValidationError:
                response = error(400, "输入格式有误，请检查内容、时间和模型名称。")
            except Conflict as exc:
                response = error(409, str(exc))
            except Exception as exc:
                if isinstance(exc, RuntimeError) and re.match(r"^(Claude|请在项目|项目授权)", str(exc)):
                    response = error(500, str(exc))
                else:
                    logger.exception("保存或处理失败")
                    response = error(500, "保存或处理失败，请检查本地服务日志。")
        response.headers.update({
            "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": CSP,
        })
        return response

    @app.get("/api/state")
    async def state():
        provider = model_provider()
        return {
            **memo.view(), "provider": provider,
            "configured": bool(os.getenv(provider["keyName"], "").strip()),
            "hookConfig": hook_config(memo.store.directory),
        }

    @app.post("/api/input")
    async def capture_input(request: Request):
        payload = await parse(request, Input)
        return await memo.input(payload.text)

    @app.post("/api/summary")
    async def summary():
        return {"count": await memo.summarize()}

    @app.put("/api/settings")
    async def settings(request: Request):
        payload = await parse(request, Settings)
        memo.store.change(lambda state: state.update(settings=payload.model_dump()))
        return {}

    @app.post("/api/proposals/{proposal_id}")
    async def review(proposal_id: str, request: Request):
        payload = await parse(request, Review)
        memo.review(proposal_id, payload.action, str(payload.candidate) if payload.candidate else None)
        return {}

    @app.put("/api/items/{item_id}")
    async def edit(item_id: str, request: Request):
        payload = await parse(request, Edit)
        memo.edit(item_id, payload.text, payload.due)
        return {}

    @app.get("/{path:path}")
    async def asset(path: str):
        entry = ASSETS.get("/" + path)
        if entry is None:
            return error(404, "找不到这个页面。")
        filename, content_type = entry
        return FileResponse(ROOT / "public" / filename, media_type=content_type)

    return app


def main():
    load_dotenv(ROOT / ".env")
    port = int(os.getenv("MEMO_PORT", "4317"))
    if not 1 <= port <= 65535:
        raise ValueError("MEMO_PORT 无效。")
    memo = Memo(Store(default_data_dir()), claude, notify_mac)
    uvicorn.run(create_app(memo, port, background=True), host=HOST, port=port, access_log=False, proxy_headers=False)


if __name__ == "__main__":
    main()
