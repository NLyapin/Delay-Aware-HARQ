import json

import pytest
from pydantic import ValidationError

from harq_lab.config import SimulationConfig
from harq_lab.experiments import ExperimentRequest, interval, run_experiment
from harq_lab.reporting import csv_export, markdown_report


def test_intervals_use_seed_replicates():
    assert interval([3])["ci_low"] is None
    result = interval([1, 2, 3])
    assert result["mean"] == 2
    assert result["ci_low"] < 1 and result["ci_high"] > 3
    assert interval([5, 5])["ci_low"] == 5


def test_sweep_seeds_summary_and_exports():
    request = ExperimentRequest(
        config=SimulationConfig(simulation_time_ms=500),
        algorithms=["parallel", "adaptive"],
        axis="snr_db",
        values=[0, 3],
        repetitions=2,
    )
    progress = []
    r = run_experiment(request, lambda p, m: progress.append(p))
    assert len(r["runs"]) == 8 and len(r["summary"]) == 4
    assert len(r["paired"]) == 2
    assert all(s["metrics"]["goodput_kbps"]["n"] == 2 for s in r["summary"])
    assert progress[-1] == 1
    assert {s["config"]["seed"] for s in r["runs"]} == {42, 43}
    assert all(not s["trace"] for s in r["runs"])
    json.dumps(r, allow_nan=False)
    assert "algorithm,axis,axis_value,seed" in csv_export(r)
    assert "95%" in markdown_report(r)


@pytest.mark.parametrize(
    "changes",
    [
        {"axis": "rtt_ms"},
        {"values": [1]},
        {"axis": "max_transmissions", "values": [1.5]},
        {"axis": "snr_db", "values": [0, 0]},
        {"algorithms": ["ir", "ir"]},
    ],
)
def test_bad_grid(changes):
    with pytest.raises(ValidationError):
        ExperimentRequest(**changes)
