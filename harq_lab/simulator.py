"""Single-server radio, independent HARQ state, deterministic event ordering."""

import heapq
import math
from collections import Counter, deque
from collections.abc import Callable
from dataclasses import dataclass

import numpy as np

from .channel import RadioChannel
from .config import Algorithm, SimulationConfig
from .policies import Decision, Policy, buffer_bytes


class SimulationCancelled(Exception):
    pass


@dataclass
class Packet:
    id: int
    process: int
    birth: float
    decision: Decision
    attempts: int = 0
    snr_sum: float = 0
    information: float = 0
    delivered: bool = False
    round: int = 0
    burst_left: int = 0


class Simulator:
    def __init__(
        self, config: SimulationConfig, algorithm: Algorithm, cancelled: Callable[[], bool] = lambda: False
    ):
        self.c, self.algorithm, self.cancelled = config, algorithm, cancelled
        self.channel, self.policy = RadioChannel(config), Policy(config, algorithm)
        self.now = 0.0
        self.queue = []
        self.sequence = 0
        self.active: dict[int, Packet] = {}
        self.ready = deque()
        self.radio_busy = False
        self.next_packet = 0
        self.trace = []
        self.trace_omitted = False
        self.samples = []
        self.latencies = []
        self.delivered_attempts = []
        self.count = Counter()
        self.airtime = 0.0
        self.symbols = 0.0
        self.peak_memory = 0.0
        self.decisions = Counter()

    def event(self, time: float, callback, *args):
        self.sequence += 1
        heapq.heappush(self.queue, (time, self.sequence, callback, args))

    def log(self, kind: str, p: Packet | None = None, **values):
        if len(self.trace) < self.c.trace_limit:
            self.trace.append(
                {
                    "time_ms": round(self.now, 5),
                    "event": kind,
                    "packet": p.id if p else None,
                    "process": p.process if p else None,
                    "attempt": p.attempts if p else None,
                    **values,
                }
            )
        else:
            self.trace_omitted = True

    def memory(self):
        return sum(buffer_bytes(self.c, p.decision.mode) for p in self.active.values())

    def create_packet(self, decision: Decision) -> Packet:
        used = {p.process for p in self.active.values()}
        process = next(i for i in range(self.c.harq_processes) if i not in used)
        p = Packet(self.next_packet, process, self.now, decision)
        self.next_packet += 1
        self.active[p.id] = p
        self.count["started"] += 1
        self.decisions[f"{decision.mode}/burst={decision.burst}/limit={decision.attempts}"] += 1
        # A reception exactly at the deadline is on time. Expiry is just after that boundary.
        self.event(math.nextafter(self.now + self.c.deadline_ms, math.inf), self.deadline, p)
        self.peak_memory = max(self.peak_memory, self.memory())
        self.log("NEW", p, mode=decision.mode, burst=decision.burst)
        return p

    def dispatch(self):
        if self.radio_busy or self.now >= self.c.simulation_time_ms:
            return
        while self.ready and self.ready[0].id not in self.active:
            self.ready.popleft()
        if self.ready:
            p = self.ready.popleft()
        else:
            decision = self.policy.decide()
            if len(self.active) >= decision.processes:
                return
            if self.memory() + buffer_bytes(self.c, decision.mode) > self.c.memory_mb * 1024**2:
                return
            p = self.create_packet(decision)
        if not p.burst_left:
            p.round += 1
            p.burst_left = min(p.decision.burst, p.decision.attempts - p.attempts)
        p.burst_left -= 1
        p.attempts += 1
        epoch = p.round
        fraction = self.c.ir_fraction if p.decision.mode == "ir" and p.attempts > 1 else 1
        duration = self.c.slot_ms * fraction
        symbols = self.c.symbols_per_block * fraction
        actual = min(duration, self.c.simulation_time_ms - self.now)
        self.airtime += actual
        self.symbols += symbols * actual / duration
        self.count["transmissions"] += 1
        if p.attempts > 1:
            self.count["retransmissions"] += 1
        self.radio_busy = True
        gamma = self.channel.snr(self.now)
        self.log(
            "TX_START",
            p,
            duration_ms=duration,
            mode=p.decision.mode,
            snr_db=10 * math.log10(max(1e-15, gamma)),
            round=epoch,
        )
        final_in_burst = p.burst_left == 0
        attempt = p.attempts
        self.event(self.now + duration, self.tx_end, p, attempt)
        self.event(
            self.now + duration + self.c.rtt_ms / 2,
            self.receive,
            p,
            epoch,
            gamma,
            symbols,
            final_in_burst,
            attempt,
        )
        if final_in_burst:
            self.event(self.now + duration + self.c.rtt_ms + self.c.timeout_margin_ms, self.timeout, p, epoch)

    def tx_end(self, p: Packet, attempt: int):
        self.radio_busy = False
        self.log("TX_END", p, attempt=attempt)
        if p.id in self.active and p.burst_left:
            self.ready.appendleft(p)
        self.dispatch()

    def receive(self, p: Packet, epoch: int, gamma: float, symbols: float, final: bool, attempt: int):
        if p.id not in self.active:
            return
        if not p.delivered:
            p.snr_sum += gamma
            p.information += symbols * math.log2(1 + gamma)
            fail_p = self.channel.failure_probability(p.decision.mode, p.snr_sum, p.information, gamma)
            failed = self.channel.decode_rng.random() < fail_p
            self.count["decoded"] += 1
            self.count["decode_errors"] += int(failed)
            if not failed:
                p.delivered = True
                self.count["delivered"] += 1
                self.latencies.append(self.now - p.birth)
                # Attempts already launched by this instant can include proactive copies.
                self.delivered_attempts.append(p.attempts)
            self.log(
                "RX_NACK" if failed else "RX_ACK", p, failure_probability=fail_p, attempt=attempt, round=epoch
            )
        else:
            self.count["duplicates"] += 1
            self.log("RX_DUPLICATE", p, attempt=attempt, round=epoch)
        if final:
            received = self.channel.feedback_rng.random() >= self.c.feedback_loss
            self.event(self.now + self.c.rtt_ms / 2, self.feedback, p, epoch, p.delivered, gamma, received)

    def finish(self, p: Packet, failed: bool):
        if p.id not in self.active:
            return
        if failed and not p.delivered:
            self.count["dropped"] += 1
            self.log("DROP", p)
        del self.active[p.id]
        self.dispatch()

    def feedback(self, p: Packet, epoch: int, ack: bool, gamma: float, received: bool):
        if p.id not in self.active or p.round != epoch:
            return
        if not received:
            self.count["feedback_lost"] += 1
            self.log("FEEDBACK_LOST", p)
            return
        self.policy.observe(10 * math.log10(max(1e-15, gamma)), not ack)
        self.log("ACK" if ack else "NACK", p)
        if ack:
            self.finish(p, False)
        elif p.attempts >= p.decision.attempts:
            self.finish(p, True)
        else:
            # Invalidate the outstanding timeout even when radio is currently occupied.
            p.round += 1
            self.ready.append(p)
            self.dispatch()

    def timeout(self, p: Packet, epoch: int):
        if p.id not in self.active or p.round != epoch:
            return
        self.count["timeouts"] += 1
        self.log("TIMEOUT", p)
        if p.attempts >= p.decision.attempts:
            self.finish(p, True)
        else:
            p.round += 1
            self.ready.append(p)
            self.dispatch()

    def deadline(self, p: Packet):
        if p.id in self.active:
            if not p.delivered:
                self.count["deadline_drops"] += 1
            self.log("DEADLINE", p)
            self.finish(p, not p.delivered)

    def sample(self):
        self.samples.append(
            {
                "time_ms": self.now,
                "delivered": self.count["delivered"],
                "goodput_kbps": self.count["delivered"] * self.c.block_size_bits / max(self.now, 1),
                "active": len(self.active),
                "memory_kb": self.memory() / 1024,
                "snr_est_db": self.policy.snr_est,
            }
        )

    def run(self) -> dict:
        self.dispatch()
        for t in np.linspace(0, self.c.simulation_time_ms, 101):
            self.event(float(t), self.sample)
        iterations = 0
        while self.queue:
            t, _, callback, args = heapq.heappop(self.queue)
            if t > self.c.simulation_time_ms:
                break
            self.now = t
            callback(*args)
            iterations += 1
            if iterations % 512 == 0 and self.cancelled():
                raise SimulationCancelled()
        if self.cancelled():
            raise SimulationCancelled()
        c, n = self.c, self.count
        censored = n["started"] - n["delivered"] - n["dropped"]
        resolved = n["delivered"] + n["dropped"]
        metrics = {
            **{
                key: n[key]
                for key in (
                    "started",
                    "delivered",
                    "dropped",
                    "transmissions",
                    "retransmissions",
                    "decoded",
                    "decode_errors",
                    "timeouts",
                    "feedback_lost",
                    "duplicates",
                    "deadline_drops",
                )
            },
            "censored": censored,
            "goodput_kbps": n["delivered"] * c.block_size_bits / c.simulation_time_ms,
            "delivery_ratio": n["delivered"] / n["started"] if n["started"] else None,
            "resolved_loss_rate": n["dropped"] / resolved if resolved else None,
            "bler": n["decode_errors"] / n["decoded"] if n["decoded"] else None,
            "utilization": self.airtime / c.simulation_time_ms,
            "mean_latency_ms": float(np.mean(self.latencies)) if self.latencies else None,
            "p95_latency_ms": float(np.percentile(self.latencies, 95)) if self.latencies else None,
            "mean_attempts_delivered": float(np.mean(self.delivered_attempts))
            if self.delivered_attempts
            else None,
            "mean_attempts_started": n["transmissions"] / n["started"] if n["started"] else None,
            "symbols_per_delivered_bit": self.symbols / (n["delivered"] * c.block_size_bits)
            if n["delivered"]
            else None,
            "peak_memory_kb": self.peak_memory / 1024,
            "tx_symbols": self.symbols,
            "feedback_only_reference_utilization": min(
                1,
                (1 if self.algorithm == "stop_wait" else c.harq_processes)
                * c.slot_ms
                / (c.rtt_ms + c.slot_ms),
            ),
        }
        return {
            "algorithm": self.algorithm,
            "config": c.model_dump(),
            "metrics": metrics,
            "trace": self.trace,
            "trace_truncated": self.trace_omitted,
            "series": self.samples,
            "latencies_ms": self.latencies[:20000],
            "latencies_truncated": len(self.latencies) > 20000,
            "decisions": dict(self.decisions),
            "final_estimate": {"snr_db": self.policy.snr_est, "observations": self.policy.observations},
            "model_version": "1.0.0",
        }


def simulate(config: SimulationConfig, algorithm: Algorithm = "adaptive", **kwargs) -> dict:
    return Simulator(config, algorithm, **kwargs).run()
