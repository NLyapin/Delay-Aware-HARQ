"""Bounded physical jobs and a reusable authenticated agent for Linux/aarch64."""

import secrets
import threading
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response

from harq_lab.simulator import SimulationCancelled

from .config import HardwareConfig, HardwareRequest, capabilities
from .engine import run_hardware
from .radio import probe_pluto


class HardwareService:
    def __init__(self):
        self.jobs = {}
        self.flags = {}
        self.lock = threading.RLock()
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="physical-link")

    def start(self, c: HardwareConfig):
        with self.lock:
            if self.flags:
                raise ValueError("Физический стенд занят; завершите или отмените текущий запуск")
            id = secrets.token_hex(16)
            flag = threading.Event()
            self.flags[id] = flag
            self.jobs[id] = {
                "id": id,
                "status": "queued",
                "config": c.model_dump(),
                "result": None,
                "error": None,
            }
            # Keep a bounded history; results can be exported explicitly by the client.
            if len(self.jobs) > 20:
                self.jobs.pop(next(iter(self.jobs)))
        self.worker.submit(self._execute, id, c, flag)
        return id

    def _execute(self, id, c, flag):
        with self.lock:
            self.jobs[id]["status"] = "running"
        try:
            result = run_hardware(c, flag.is_set)
            with self.lock:
                self.jobs[id].update(status="cancelled" if flag.is_set() else "completed", result=result)
        except SimulationCancelled:
            with self.lock:
                self.jobs[id]["status"] = "cancelled"
        except Exception as error:
            with self.lock:
                self.jobs[id].update(status="failed", error=str(error))
        finally:
            with self.lock:
                self.flags.pop(id, None)

    def get(self, id):
        with self.lock:
            return dict(self.jobs[id]) if id in self.jobs else None

    def cancel(self, id):
        with self.lock:
            if id not in self.jobs:
                raise KeyError(id)
            if id in self.flags:
                self.flags[id].set()

    def close(self):
        with self.lock:
            for flag in self.flags.values():
                flag.set()
        self.worker.shutdown(wait=True)


def register_hardware_routes(app: FastAPI, service: HardwareService):
    from .remote import AgentRequest, call_agent

    @app.post("/api/hardware/remote")
    def remote(request: AgentRequest):
        try:
            return call_agent(request)
        except (ValueError, RuntimeError) as error:
            raise HTTPException(503, str(error)) from error

    @app.get("/api/hardware/capabilities")
    def info():
        return capabilities()

    @app.post("/api/hardware/probe")
    def probe(request: HardwareRequest):
        try:
            return probe_pluto(request.config.uri)
        except Exception as error:
            raise HTTPException(503, str(error)) from error

    @app.post("/api/hardware/jobs", status_code=202)
    def start(request: HardwareRequest):
        try:
            return {"id": service.start(request.config)}
        except ValueError as error:
            raise HTTPException(409, str(error)) from error

    @app.get("/api/hardware/jobs/{id}")
    def get(id: str):
        job = service.get(id)
        if job is None:
            raise HTTPException(404, "Аппаратный запуск не найден")
        return job

    @app.post("/api/hardware/jobs/{id}/cancel")
    def cancel(id: str):
        try:
            service.cancel(id)
        except KeyError as error:
            raise HTTPException(404, "Аппаратный запуск не найден") from error
        return {"ok": True}


def create_agent() -> FastAPI:
    """Serve on loopback; connect from another machine with an SSH tunnel, not a public port."""
    import os
    from contextlib import asynccontextmanager

    token = os.environ.get("HARQ_AGENT_TOKEN", "")
    if len(token) < 24:
        raise RuntimeError("Задайте HARQ_AGENT_TOKEN длиной не менее 24 символов")
    service = HardwareService()

    @asynccontextmanager
    async def lifespan(app):
        yield
        service.close()

    app = FastAPI(title="HARQ physical agent", version="1.0.0", lifespan=lifespan)

    @app.middleware("http")
    async def authenticate(request: Request, call_next):
        if not secrets.compare_digest(request.headers.get("X-HARQ-Agent-Token", ""), token):
            return Response("Unauthorized", status_code=401)
        return await call_next(request)

    register_hardware_routes(app, service)
    return app
