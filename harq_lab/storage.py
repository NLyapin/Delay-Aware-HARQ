import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4


class Repository:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        with self.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, created TEXT NOT NULL,
                status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '',
                request TEXT NOT NULL, result TEXT)""")
            db.execute(
                "UPDATE jobs SET status='interrupted', message='Сервер был перезапущен' "
                "WHERE status IN ('queued','running')"
            )

    def connect(self):
        db = sqlite3.connect(self.path, timeout=20)
        db.row_factory = sqlite3.Row
        return db

    def create(self, request: dict) -> str:
        id = uuid4().hex
        with self.connect() as db:
            db.execute(
                "INSERT INTO jobs (id,name,created,status,request) VALUES (?,?,?,?,?)",
                (
                    id,
                    request["name"],
                    datetime.now(UTC).isoformat(),
                    "queued",
                    json.dumps(request, ensure_ascii=False),
                ),
            )
        return id

    def update(self, id: str, **values):
        allowed = {"status", "progress", "message", "result"}
        if not values.keys() <= allowed:
            raise ValueError("Invalid database fields")
        if "result" in values:
            values["result"] = json.dumps(values["result"], ensure_ascii=False, allow_nan=False)
        with self.connect() as db:
            db.execute(
                f"UPDATE jobs SET {','.join(k + '=?' for k in values)} WHERE id=?", [*values.values(), id]
            )

    def list(self):
        with self.connect() as db:
            return [
                dict(r)
                for r in db.execute(
                    "SELECT id,name,created,status,progress,message FROM jobs ORDER BY created DESC LIMIT 100"
                )
            ]

    def get(self, id: str):
        with self.connect() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (id,)).fetchone()
        if row is None:
            return None
        result = dict(row)
        result["request"] = json.loads(result["request"])
        result["result"] = json.loads(result["result"]) if result["result"] else None
        return result
