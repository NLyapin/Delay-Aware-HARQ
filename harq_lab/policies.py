"""Causal delay-aware policy. Only delayed ACK/NACK/CSI updates transmitter estimates."""

import math
from dataclasses import dataclass

from .channel import bler
from .config import Algorithm, SimulationConfig


@dataclass(frozen=True)
class Decision:
    mode: str
    burst: int
    attempts: int
    processes: int
    predicted_loss: float = 0
    score: float = 0


def buffer_bytes(c: SimulationConfig, mode: str) -> float:
    multiplier = (1 + (c.max_transmissions - 1) * c.ir_fraction) if mode == "ir" else 1
    return c.symbols_per_block * c.llr_bits / 8 * multiplier


class Policy:
    def __init__(self, c: SimulationConfig, algorithm: Algorithm):
        self.c, self.algorithm = c, algorithm
        # Configured long-term prior, not instantaneous receiver CSI.
        self.snr_est = c.snr_db
        self.bler_est = bler(c.snr_db, c.bler_threshold_db, c.bler_slope)
        self.observations = 0

    def observe(self, snr_db: float, failed: bool):
        self.snr_est = 0.9 * self.snr_est + 0.1 * snr_db
        self.bler_est = 0.9 * self.bler_est + 0.1 * failed
        self.observations += 1

    def decide(self) -> Decision:
        c = self.c
        if self.algorithm != "adaptive":
            mode = {"chase": "cc", "ir": "ir"}.get(self.algorithm, "type1")
            count = 1 if self.algorithm == "stop_wait" else c.harq_processes
            count = min(count, int(c.memory_mb * 1024**2 // buffer_bytes(c, mode)))
            if count < 1:
                raise ValueError("Недостаточно памяти для выбранной стратегии")
            return Decision(mode, 1, c.max_transmissions, count)
        candidates = []
        gamma = 10 ** (self.snr_est / 10)
        for mode in ("cc", "ir"):
            count = min(
                c.harq_processes,
                math.ceil((c.rtt_ms + c.slot_ms) / c.slot_ms),
                int(c.memory_mb * 1024**2 // buffer_bytes(c, mode)),
            )
            if count < 1:
                continue
            for burst in range(1, min(c.proactive_limit, c.max_transmissions) + 1):
                duration = c.slot_ms * (burst if mode == "cc" else 1 + (burst - 1) * c.ir_fraction)
                # First receive time of the whole burst must fit the application deadline.
                if duration + c.rtt_ms / 2 > c.deadline_ms:
                    continue
                max_rounds = max(
                    1, math.floor((c.deadline_ms - c.rtt_ms / 2 - duration) / (c.rtt_ms + duration)) + 1
                )
                attempts = min(c.max_transmissions, max_rounds * burst)
                resource = attempts if mode == "cc" else 1 + (attempts - 1) * c.ir_fraction
                equivalent = attempts * gamma if mode == "cc" else (1 + gamma) ** resource - 1
                loss = bler(10 * math.log10(max(equivalent, 1e-15)), c.bler_threshold_db, c.bler_slope)
                first_equiv = (
                    burst * gamma if mode == "cc" else (1 + gamma) ** (1 + (burst - 1) * c.ir_fraction) - 1
                )
                first_loss = bler(10 * math.log10(max(first_equiv, 1e-15)), c.bler_threshold_db, c.bler_slope)
                # Approximate one further round; a heuristic score, not an optimal controller.
                expected_air = duration * (1 + first_loss)
                goodput = min(c.slot_ms / expected_air, count * c.slot_ms / (duration + c.rtt_ms)) * (
                    1 - loss
                )
                delay = (duration + c.rtt_ms / 2 + first_loss * (duration + c.rtt_ms)) / c.deadline_ms
                reliability_penalty = max(0, loss - c.target_loss)
                memory = count * buffer_bytes(c, mode) / (c.memory_mb * 1024**2)
                score = goodput - 0.15 * delay - 2 * reliability_penalty - 0.02 * memory
                candidates.append(Decision(mode, burst, attempts, count, loss, score))
        if not candidates:
            count = min(c.harq_processes, int(c.memory_mb * 1024**2 // buffer_bytes(c, "cc")))
            return Decision("cc", 1, 1, max(1, count))
        return max(candidates, key=lambda d: d.score)
