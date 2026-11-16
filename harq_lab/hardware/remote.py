"""Explicit client for an authenticated agent reached through a local SSH tunnel."""

import json
import re
from typing import Literal
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .config import HardwareConfig


class AgentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base_url: str = "http://127.0.0.1:8766"
    token: str = Field(min_length=24, max_length=256, repr=False)
    operation: Literal["capabilities", "probe", "start", "status", "cancel"]
    job_id: str | None = None
    config: HardwareConfig | None = None

    @field_validator("base_url")
    @classmethod
    def loopback_only(cls, value):
        u = urlsplit(value)
        if (
            u.scheme != "http"
            or u.hostname not in ("127.0.0.1", "::1")
            or u.username
            or u.password
            or u.path not in ("", "/")
            or u.query
            or u.fragment
            or not u.port
        ):
            raise ValueError("Укажите HTTP loopback-адрес SSH-туннеля, например http://127.0.0.1:8766")
        return value.rstrip("/")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Перенаправления аппаратного агента запрещены")


def call_agent(request: AgentRequest):
    op = request.operation
    if op in ("status", "cancel") and not re.fullmatch("[a-f0-9]{32}", request.job_id or ""):
        raise ValueError("Некорректный идентификатор аппаратного запуска")
    if op in ("probe", "start") and request.config is None:
        raise ValueError("Не задана аппаратная конфигурация")
    paths = {
        "capabilities": "capabilities",
        "probe": "probe",
        "start": "jobs",
        "status": f"jobs/{request.job_id}",
        "cancel": f"jobs/{request.job_id}/cancel",
    }
    data = (
        None
        if op in ("capabilities", "status")
        else json.dumps({"config": request.config.model_dump()} if request.config else {}).encode()
    )
    req = Request(
        f"{request.base_url}/api/hardware/{paths[op]}",
        data=data,
        headers={"X-HARQ-Agent-Token": request.token, "Content-Type": "application/json"},
    )
    try:
        with build_opener(NoRedirect).open(req, timeout=10) as response:
            return json.loads(response.read(20_000_000))
    except HTTPError as error:
        detail = error.read(4096).decode("utf-8", errors="replace")
        raise RuntimeError(f"Аппаратный агент: HTTP {error.code}: {detail}") from error
    except (URLError, TimeoutError) as error:
        raise RuntimeError("Агент недоступен. Проверьте SSH-туннель, адрес и запущенный сервис") from error
