from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Algorithm = Literal["stop_wait", "parallel", "chase", "ir", "adaptive"]
ALGORITHMS = ("stop_wait", "parallel", "chase", "ir", "adaptive")
LABELS = {
    "stop_wait": "Stop-and-Wait",
    "parallel": "Parallel Type-I",
    "chase": "Chase Combining",
    "ir": "Incremental Redundancy",
    "adaptive": "Adaptive DA-HARQ",
}


class SimulationConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, allow_inf_nan=False)
    rtt_ms: float = Field(500, ge=0, le=10000, description="Propagation + processing, excluding airtime")
    slot_ms: float = Field(1, ge=0.1, le=100)
    snr_db: float = Field(1, ge=-30, le=40)
    block_size_bits: int = Field(1024, ge=64, le=65536)
    code_rate: float = Field(0.5, ge=0.1, le=1)
    harq_processes: int = Field(16, ge=1, le=4096)
    max_transmissions: int = Field(4, ge=1, le=8)
    simulation_time_ms: float = Field(10000, ge=100, le=1_000_000)
    seed: int = Field(42, ge=0, le=2**32 - 1)
    channel: Literal["awgn", "rayleigh", "correlated", "shadowing"] = "awgn"
    coherence_ms: float = Field(20, ge=0.1, le=100000)
    shadow_sigma_db: float = Field(4, ge=0, le=15)
    bler_threshold_db: float = Field(0, ge=-20, le=20)
    bler_slope: float = Field(1.3, ge=0.1, le=10)
    decoder: Literal["waterfall", "ideal", "perfect"] = "waterfall"
    ir_fraction: float = Field(0.5, ge=0.1, le=1)
    feedback_loss: float = Field(0, ge=0, le=1)
    timeout_margin_ms: float = Field(5, ge=0.01, le=1000)
    deadline_ms: float = Field(3000, ge=1, le=100000)
    memory_mb: float = Field(64, ge=0.01, le=4096)
    llr_bits: int = Field(8, ge=1, le=32)
    target_loss: float = Field(0.01, ge=0.00001, le=0.5)
    proactive_limit: int = Field(3, ge=1, le=4)
    trace_limit: int = Field(1500, ge=0, le=20000)

    @model_validator(mode="after")
    def resource_limit(self):
        if self.simulation_time_ms / (self.slot_ms * min(1, self.ir_fraction)) > 2_000_000:
            raise ValueError("Слишком большой прогон: не более 2 млн потенциальных передач")
        if self.memory_mb * 1024**2 < self.block_size_bits / self.code_rate * self.llr_bits / 8:
            raise ValueError("Памяти недостаточно даже для одного мягкого буфера")
        return self

    @property
    def symbols_per_block(self) -> float:
        return self.block_size_bits / self.code_rate

    @property
    def symbol_rate(self) -> float:
        return self.symbols_per_block / (self.slot_ms / 1000)


PRESETS = {
    "terrestrial": {"rtt_ms": 4, "harq_processes": 8, "deadline_ms": 100, "snr_db": 1},
    "leo": {"rtt_ms": 30, "harq_processes": 32, "deadline_ms": 250, "snr_db": 1},
    "geo": {"rtt_ms": 500, "harq_processes": 16, "deadline_ms": 3000, "snr_db": 1},
    "fading": {
        "rtt_ms": 500,
        "harq_processes": 32,
        "deadline_ms": 2500,
        "snr_db": 2,
        "channel": "correlated",
        "coherence_ms": 100,
    },
}
