"""Loopback API with one bounded research worker and persistent experiment history."""

import os
import secrets
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from .config import ALGORITHMS, LABELS, PRESETS, SimulationConfig
from .experiments import ExperimentRequest, run_experiment
from .reporting import csv_export, markdown_report
from .simulator import SimulationCancelled
from .storage import Repository


def create_app(db_path: Path | None = None) -> FastAPI:
    repo = Repository(db_path or Path(os.environ.get("HARQ_DB", "results/harq.sqlite3")))
    worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="harq-research")
    flags: dict[str, threading.Event] = {}
    lock = threading.Lock()
    token = os.environ.get("HARQ_API_TOKEN", "")

    @asynccontextmanager
    async def lifespan(app):
        yield
        with lock:
            for flag in flags.values():
                flag.set()
        worker.shutdown(wait=True)

    app = FastAPI(title="HARQ Lab", version="1.0.0", lifespan=lifespan)

    @app.middleware("http")
    async def guard(request: Request, call_next):
        if request.url.path.startswith("/api/"):
            if token and not secrets.compare_digest(request.headers.get("X-HARQ-Token", ""), token):
                return Response("Unauthorized", status_code=401)
            if request.method != "GET":
                origin = request.headers.get("origin")
                if origin and origin != str(request.base_url).rstrip("/"):
                    return Response("Cross-origin request rejected", status_code=403)
        return await call_next(request)

    @app.get("/api/health")
    def health():
        return {"status": "ok", "version": "1.0.0"}

    @app.get("/api/bootstrap")
    def bootstrap():
        return {
            "defaults": SimulationConfig().model_dump(),
            "presets": PRESETS,
            "algorithms": [{"id": a, "label": LABELS[a]} for a in ALGORITHMS],
            "schema": SimulationConfig.model_json_schema(),
        }

    @app.get("/api/jobs")
    def jobs():
        return repo.list()

    def execute(id: str, request: ExperimentRequest, flag: threading.Event):
        try:
            if flag.is_set():
                raise SimulationCancelled()
            repo.update(id, status="running", message="Подготовка модели")
            result = run_experiment(request, lambda p, m: repo.update(id, progress=p, message=m), flag.is_set)
            if flag.is_set():
                raise SimulationCancelled()
            repo.update(id, status="completed", progress=1, message="Эксперимент завершён", result=result)
        except SimulationCancelled:
            repo.update(id, status="cancelled", message="Остановлено пользователем")
        except Exception as error:
            repo.update(id, status="failed", message=str(error))
        finally:
            with lock:
                flags.pop(id, None)

    @app.post("/api/jobs", status_code=202)
    def create(request: ExperimentRequest):
        with lock:
            if len(flags) >= 8:
                raise HTTPException(429, "Очередь заполнена: не более 8 экспериментов")
            id = repo.create(request.model_dump())
            flag = flags[id] = threading.Event()
        worker.submit(execute, id, request, flag)
        return {"id": id}

    @app.get("/api/jobs/{id}")
    def detail(id: str):
        job = repo.get(id)
        if not job:
            raise HTTPException(404, "Эксперимент не найден")
        return job

    @app.post("/api/jobs/{id}/cancel")
    def cancel(id: str):
        if not repo.get(id):
            raise HTTPException(404, "Эксперимент не найден")
        with lock:
            if id in flags:
                flags[id].set()
        return {"ok": True}

    @app.get("/api/jobs/{id}/export/{format}")
    def export(id: str, format: str):
        job = repo.get(id)
        if not job:
            raise HTTPException(404, "Эксперимент не найден")
        if not job["result"]:
            raise HTTPException(409, "Результаты ещё не готовы")
        if format == "csv":
            return Response("\ufeff" + csv_export(job["result"]), media_type="text/csv; charset=utf-8")
        if format == "md":
            return Response(markdown_report(job["result"]), media_type="text/markdown; charset=utf-8")
        if format == "json":
            import json

            return Response(
                json.dumps(job["result"], ensure_ascii=False, allow_nan=False), media_type="application/json"
            )
        raise HTTPException(400, "Форматы: json, csv, md")

    frontend = Path(__file__).resolve().parents[1] / "desktop" / "renderer"
    if frontend.exists():
        app.mount("/", StaticFiles(directory=frontend, html=True), name="ui")
    app.state.repo, app.state.worker = repo, worker
    return app
