import math

import numpy as np
import pytest
from pydantic import ValidationError

from harq_lab.channel import RadioChannel, bler
from harq_lab.config import ALGORITHMS, SimulationConfig
from harq_lab.policies import Policy
from harq_lab.simulator import SimulationCancelled, simulate


def cfg(**changes):
    return SimulationConfig(**{"simulation_time_ms": 5000, "trace_limit": 1000, **changes})


@pytest.mark.parametrize("algorithm", ALGORITHMS)
def test_packet_conservation_and_resource_bounds(algorithm):
    c = cfg(channel="correlated", feedback_loss=0.15, deadline_ms=1800)
    result = simulate(c, algorithm)
    m = result["metrics"]
    assert m["started"] == m["delivered"] + m["dropped"] + m["censored"]
    assert 0 <= m["utilization"] <= 1 + 1e-12
    assert m["peak_memory_kb"] <= c.memory_mb * 1024
    assert m["transmissions"] <= m["started"] * c.max_transmissions
    assert m["goodput_kbps"] <= c.block_size_bits / c.slot_ms + 1e-9
    assert m["decode_errors"] <= m["decoded"]
    assert all(0 <= t <= c.deadline_ms for t in result["latencies_ms"])
    assert [e["time_ms"] for e in result["trace"]] == sorted(e["time_ms"] for e in result["trace"])


@pytest.mark.parametrize("processes,rtt", [(1, 500), (16, 500), (32, 30), (8, 4), (512, 500)])
def test_ideal_utilization_matches_analytic(processes, rtt):
    c = cfg(decoder="perfect", harq_processes=processes, rtt_ms=rtt, simulation_time_ms=20000, trace_limit=0)
    m = simulate(c, "parallel")["metrics"]
    expected = min(1, processes * c.slot_ms / (rtt + c.slot_ms))
    # Finite window contains an extra unfinished final cycle.
    assert abs(m["utilization"] - expected) <= processes * c.slot_ms / c.simulation_time_ms + 1e-10
    assert m["dropped"] == 0


def test_stop_wait_timing_exact():
    r = simulate(cfg(decoder="perfect", rtt_ms=10), "stop_wait")
    trace = r["trace"]
    starts = [e["time_ms"] for e in trace if e["event"] == "TX_START"]
    assert starts[:3] == [0, 11, 22]
    assert r["latencies_ms"][0] == 6
    assert next(e["time_ms"] for e in trace if e["event"] == "ACK") == 11


def test_feedback_is_causal():
    r = simulate(cfg(simulation_time_ms=200, rtt_ms=500, deadline_ms=2000), "adaptive")
    assert r["final_estimate"]["observations"] == 0
    assert not any(e["event"] in ("ACK", "NACK") for e in r["trace"])


def test_proactive_trace_preserves_the_original_transmission_attempt():
    r = simulate(cfg(), "adaptive")
    starts = [e for e in r["trace"] if e["event"] == "TX_START" and e["packet"] == 0]
    received = [e for e in r["trace"] if e["event"].startswith("RX_") and e["packet"] == 0]
    assert len(starts) > 1
    assert received[0]["attempt"] == 1
    assert [e["attempt"] for e in received] == [e["attempt"] for e in starts[: len(received)]]


def test_loss_of_all_ack_does_not_duplicate_deliveries():
    r = simulate(
        cfg(
            decoder="perfect",
            feedback_loss=1,
            rtt_ms=10,
            harq_processes=1,
            max_transmissions=4,
            simulation_time_ms=100,
        ),
        "chase",
    )
    m = r["metrics"]
    assert m["timeouts"] > 0 and m["duplicates"] > 0
    assert m["dropped"] == 0
    assert m["delivered"] == len(r["latencies_ms"])
    assert m["delivered"] < m["transmissions"]


def test_deadline_before_first_reception():
    m = simulate(cfg(deadline_ms=100, rtt_ms=500), "chase")["metrics"]
    assert m["delivered"] == 0 and m["deadline_drops"] > 0
    assert m["mean_latency_ms"] is None


def test_reception_exactly_at_deadline_is_on_time():
    r = simulate(cfg(decoder="perfect", deadline_ms=251, rtt_ms=500), "stop_wait")
    assert r["metrics"]["delivered"] > 0
    assert r["latencies_ms"][0] == 251


def test_short_horizon_not_reported_as_loss():
    m = simulate(cfg(simulation_time_ms=100, rtt_ms=500, deadline_ms=3000), "parallel")["metrics"]
    assert m["delivered"] == m["dropped"] == 0
    assert m["censored"] == 16
    assert m["resolved_loss_rate"] is None


def test_one_attempt_all_algorithms_agree_when_same_scheduler():
    c = cfg(max_transmissions=1, harq_processes=8)
    runs = [simulate(c, a)["metrics"] for a in ("parallel", "chase", "ir", "adaptive")]
    for m in runs[1:]:
        assert m["delivered"] == runs[0]["delivered"]
        assert m["tx_symbols"] == runs[0]["tx_symbols"]


def test_seed_reproducibility():
    c = cfg(channel="rayleigh")
    assert simulate(c, "ir") == simulate(c, "ir")
    assert simulate(c, "ir")["metrics"] != simulate(cfg(channel="rayleigh", seed=43), "ir")["metrics"]


def test_memory_restricts_parallel_processes():
    c = cfg(memory_mb=0.01, harq_processes=512, decoder="perfect")
    m = simulate(c, "chase")["metrics"]
    assert m["peak_memory_kb"] <= 0.01 * 1024
    assert m["utilization"] < 0.03


def test_ir_airtime_is_accounted_and_radio_does_not_overlap():
    c = cfg(snr_db=-8, rtt_ms=10, ir_fraction=0.25, harq_processes=8)
    r = simulate(c, "ir")
    tx = [e for e in r["trace"] if e["event"] == "TX_START"]
    assert any(e["duration_ms"] == 0.25 for e in tx)
    assert all(
        b["time_ms"] >= a["time_ms"] + a["duration_ms"] - 1e-6 for a, b in zip(tx, tx[1:], strict=False)
    )


def test_cc_and_ir_accumulation_have_correct_limits():
    ch = RadioChannel(cfg())
    n = ch.c.symbols_per_block
    # At constant 0 dB, 3 CC copies -> 10log10(3)=4.771 dB.
    assert ch.failure_probability("cc", 3, 0, 1) == pytest.approx(bler(10 * math.log10(3)))
    # Three full IR chunks -> MI/n = 3 -> equivalent SNR = 7.
    assert ch.failure_probability("ir", 0, 3 * n, 1) == pytest.approx(bler(10 * math.log10(7)))


@pytest.mark.parametrize("channel", ["rayleigh", "correlated"])
def test_rayleigh_stationary_mean(channel):
    c = cfg(channel=channel, snr_db=0, simulation_time_ms=100000, coherence_ms=2)
    ch = RadioChannel(c)
    assert np.mean(ch.gain) == pytest.approx(1, abs=0.04)


def test_time_indexed_channel_shared_across_algorithms():
    c = cfg(channel="correlated")
    a, b = RadioChannel(c), RadioChannel(c)
    a.decode_rng.random(100)
    assert a.snr(123.5) == b.snr(123.5)


def test_adaptation_only_changes_on_feedback():
    p = Policy(cfg(), "adaptive")
    old = p.snr_est
    p.decide()
    assert p.snr_est == old
    p.observe(-10, True)
    assert p.snr_est < old and p.observations == 1


def test_cancel():
    with pytest.raises(SimulationCancelled):
        simulate(cfg(), "ir", cancelled=lambda: True)


@pytest.mark.parametrize(
    "changes",
    [
        {"slot_ms": 0},
        {"snr_db": float("nan")},
        {"max_transmissions": 0},
        {"extra": 1},
        {"simulation_time_ms": 1e6, "slot_ms": 0.1, "ir_fraction": 0.1},
    ],
)
def test_invalid_config(changes):
    with pytest.raises(ValidationError):
        cfg(**changes)
