"""Independent-seed replicates, Student-t CIs; no packet-wise pseudo-replication."""

import platform
from collections import defaultdict
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, model_validator
from scipy.stats import t

from .config import ALGORITHMS, Algorithm, SimulationConfig
from .simulator import SimulationCancelled, simulate

AXES = {"rtt_ms", "snr_db", "harq_processes", "max_transmissions", "memory_mb"}


class ExperimentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    name: str = Field("Исследование HARQ", min_length=1, max_length=120)
    config: SimulationConfig = Field(default_factory=SimulationConfig)
    algorithms: list[Algorithm] = Field(default_factory=lambda: list(ALGORITHMS), min_length=1, max_length=5)
    axis: Literal["rtt_ms", "snr_db", "harq_processes", "max_transmissions", "memory_mb"] | None = None
    values: list[float] = Field(default_factory=list, max_length=25)
    repetitions: int = Field(3, ge=1, le=30)

    @model_validator(mode="after")
    def validate_grid(self):
        if len(set(self.algorithms)) != len(self.algorithms):
            raise ValueError("Алгоритмы не должны повторяться")
        if bool(self.axis) != bool(self.values):
            raise ValueError("Для серии укажите и ось, и значения")
        if len(set(self.values)) != len(self.values):
            raise ValueError("Значения оси не должны повторяться")
        for value in self.values:
            SimulationConfig.model_validate({**self.config.model_dump(), self.axis: value})
        runs = len(self.algorithms) * max(1, len(self.values)) * self.repetitions
        if runs > 400:
            raise ValueError("Не более 400 прогонов на эксперимент")
        slots = self.config.simulation_time_ms / (self.config.slot_ms * self.config.ir_fraction)
        if slots * runs > 20_000_000:
            raise ValueError("Бюджет эксперимента превышает 20 млн потенциальных передач")
        if self.config.seed + self.repetitions > 2**32:
            raise ValueError("Переполнение диапазона seed")
        return self


def interval(values: list[float]) -> dict:
    n = len(values)
    mean = float(np.mean(values)) if n else None
    half = float(t.ppf(0.975, n - 1) * np.std(values, ddof=1) / np.sqrt(n)) if n > 1 else None
    return {
        "mean": mean,
        "ci_low": mean - half if half is not None else None,
        "ci_high": mean + half if half is not None else None,
        "n": n,
    }


def run_experiment(
    request: ExperimentRequest,
    progress: Callable = lambda *_: None,
    cancelled: Callable[[], bool] = lambda: False,
) -> dict:
    runs = []
    groups = defaultdict(list)
    total = len(request.algorithms) * max(1, len(request.values)) * request.repetitions
    for value in request.values if request.axis else [None]:
        for repetition in range(request.repetitions):
            for algorithm in request.algorithms:
                if cancelled():
                    raise SimulationCancelled()
                changes = {"seed": request.config.seed + repetition}
                if request.axis:
                    changes[request.axis] = value
                if request.axis or repetition > 0:
                    changes["trace_limit"] = 0
                config = SimulationConfig.model_validate({**request.config.model_dump(), **changes})
                result = simulate(config, algorithm, cancelled=cancelled)
                result["axis_value"], result["repetition"] = value, repetition
                if request.axis:
                    result.pop("series")
                    result.pop("latencies_ms")
                runs.append(result)
                groups[(algorithm, value)].append(result["metrics"])
                progress(len(runs) / total, f"{len(runs)}/{total} · {algorithm} · seed {config.seed}")
    summary = []
    for (algorithm, value), metrics in groups.items():
        summary.append(
            {
                "algorithm": algorithm,
                "axis_value": value,
                "metrics": {k: interval([m[k] for m in metrics if m[k] is not None]) for k in metrics[0]},
            }
        )
    # Paired differences at seed level; identical seeds do not imply identical TX schedules.
    paired = []
    if "parallel" in request.algorithms and "adaptive" in request.algorithms:
        for value in request.values if request.axis else [None]:
            baseline = [r for r in runs if r["algorithm"] == "parallel" and r["axis_value"] == value]
            adaptive = [r for r in runs if r["algorithm"] == "adaptive" and r["axis_value"] == value]
            delta = [
                a["metrics"]["goodput_kbps"] - b["metrics"]["goodput_kbps"]
                for a, b in zip(adaptive, baseline, strict=True)
            ]
            paired.append({"axis_value": value, "goodput_delta_kbps": interval(delta)})
    return {
        "request": request.model_dump(),
        "runs": runs,
        "summary": summary,
        "paired": paired,
        "metadata": {
            "created_utc": datetime.now(UTC).isoformat(),
            "python": platform.python_version(),
            "numpy": np.__version__,
            "platform": platform.platform(),
            "model_version": "1.0.0",
            "confidence": "two-sided Student t, 95%, independent seed replicates",
            "decoder": "abstract BLER / mutual-information model; not NR LDPC",
        },
    }
