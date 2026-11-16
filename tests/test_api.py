import time

from fastapi.testclient import TestClient

from harq_lab.api import create_app


def test_real_job_lifecycle_and_persistence(tmp_path):
    path = tmp_path / "history.sqlite3"
    app = create_app(path)
    with TestClient(app) as client:
        assert client.get("/api/health").status_code == 200
        assert client.get("/api/bootstrap").json()["defaults"]["rtt_ms"] == 500
        response = client.post(
            "/api/jobs",
            json={
                "name": "Test",
                "config": {"simulation_time_ms": 500},
                "algorithms": ["chase"],
                "repetitions": 2,
            },
        )
        assert response.status_code == 202
        id = response.json()["id"]
        for _ in range(100):
            job = client.get(f"/api/jobs/{id}").json()
            if job["status"] in ("completed", "failed"):
                break
            time.sleep(0.02)
        assert job["status"] == "completed", job
        assert job["result"]["summary"][0]["metrics"]["goodput_kbps"]["n"] == 2
        for format in ("csv", "json", "md"):
            assert client.get(f"/api/jobs/{id}/export/{format}").status_code == 200
        assert client.get(f"/api/jobs/{id}/export/exe").status_code == 400
        assert client.get("/api/jobs/nonexistent").status_code == 404
        assert client.post("/api/jobs", json={"config": {"slot_ms": -1}}).status_code == 422
        assert client.post("/api/jobs", json={}, headers={"origin": "https://evil.test"}).status_code == 403
    app.state.worker.shutdown()
    again = create_app(path)
    assert again.state.repo.get(id)["result"] == job["result"]
    again.state.worker.shutdown()


def test_api_auth(tmp_path, monkeypatch):
    monkeypatch.setenv("HARQ_API_TOKEN", "test-secret")
    app = create_app(tmp_path / "auth.sqlite3")
    with TestClient(app) as client:
        assert client.get("/api/health").status_code == 401
        assert client.get("/api/health", headers={"X-HARQ-Token": "test-secret"}).status_code == 200
    app.state.worker.shutdown()


def test_api_accepts_user_720_run_request_and_exposes_limits(tmp_path, monkeypatch):
    from harq_lab.experiments import EXPERIMENT_LIMITS

    def record_request(request, progress, cancelled):
        return {"accepted_runs": len(request.values) * len(request.algorithms) * request.repetitions}

    monkeypatch.setattr("harq_lab.api.run_experiment", record_request)
    app = create_app(tmp_path / "large.sqlite3")
    with TestClient(app) as client:
        assert client.get("/api/bootstrap").json()["limits"] == EXPERIMENT_LIMITS
        response = client.post(
            "/api/jobs", json={"axis": "snr_db", "values": [-6, -4, -2, 0, 2, 4, 6, 8], "repetitions": 18}
        )
        assert response.status_code == 202, response.text
        id = response.json()["id"]
        for _ in range(100):
            job = client.get(f"/api/jobs/{id}").json()
            if job["status"] == "completed":
                break
            time.sleep(0.01)
        assert job["result"]["accepted_runs"] == 720
