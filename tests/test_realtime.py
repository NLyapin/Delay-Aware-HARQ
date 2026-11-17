"""Real process/byte transport tests, not mocks of successful decoding."""

import multiprocessing as mp
import os
import threading
import time

import numpy as np
import pytest
from pydantic import ValidationError

from harq_lab.hardware.config import HardwareConfig
from harq_lab.hardware.engine import run_hardware
from harq_lab.hardware.realtime import SampleChannel, pack_samples, unpack_samples
from harq_lab.simulator import SimulationCancelled


def config(**changes):
    return HardwareConfig.model_validate(
        {
            "backend": "realtime_iq",
            "snr_db": 25,
            "packets": 3,
            "propagation_ms": 30,
            "ack_timeout_ms": 1500,
            "duration_s": 5,
            "iq_chunk_samples": 1024,
            "clock_offset_ppm": 20,
            "echo_delay_samples": 4,
            **changes,
        }
    )


def test_sample_stream_preserves_iq_across_byte_boundaries_and_rejects_bad_lengths():
    iq = (np.arange(100) + 0.3j).astype(np.complex64)
    wire = pack_samples(iq) + pack_samples(iq[::-1])
    buffer, decoded = bytearray(), []
    for pos in range(0, len(wire), 13):
        buffer.extend(wire[pos : pos + 13])
        decoded.extend(unpack_samples(buffer))
    assert not buffer
    np.testing.assert_array_equal(decoded[0], iq)
    np.testing.assert_array_equal(decoded[1], iq[::-1])
    with pytest.raises(ValueError):
        unpack_samples(bytearray(b"\xff\xff\xff\xff"))


def test_impairments_change_samples_reproducibly_without_packet_oracle():
    iq = np.ones(20000, dtype=np.complex64)
    c = config(snr_db=10, echo_delay_samples=8, clock_offset_ppm=200)
    first = SampleChannel(c, 42).apply(iq)
    second = SampleChannel(c, 42).apply(iq)
    np.testing.assert_array_equal(first, second)
    assert len(first) != len(iq)
    assert np.std(first.imag) > 0.1
    assert np.isfinite(first).all()


@pytest.mark.parametrize("algorithm", ["stop_wait", "parallel", "chase", "ir"])
def test_three_processes_decode_iq_and_return_actual_feedback_with_wallclock_delay(algorithm):
    r = run_hardware(config(algorithm=algorithm))
    assert r["source"] == "cpu_realtime_iq"
    assert r["metrics"]["acknowledged"] == 3
    assert r["receiver_metrics"]["delivered"] == 3
    assert len({role["pid"] for role in r["runtime"].values()}) == 3
    assert all(role["pid"] != os.getpid() for role in r["runtime"].values())
    assert r["receiver_transport"]["rx_samples"] > 0
    assert r["signal"]["symbols"] and r["signal"]["spectrum_db"]
    first_tx = next(e for e in r["trace"] if e["event"] == "TX_START")
    first_rx = next(e for e in r["receiver_trace"] if e["packet"] == first_tx["packet"])
    assert first_rx["time_ms"] - first_tx["time_ms"] >= 30
    first_ack = next(e for e in r["trace"] if e["event"] == "ACK")
    assert first_ack["rtt_host_ms"] >= 60
    assert r["channel_metrics"]["metrics"].get("overflow_samples", 0) == 0


def test_unacquirable_signal_really_times_out_without_fabricated_nack():
    r = run_hardware(config(packets=1, max_transmissions=2, snr_db=-15, propagation_ms=0, ack_timeout_ms=150))
    assert r["metrics"]["acknowledged"] == 0
    assert r["metrics"]["transmissions"] == 2
    assert r["metrics"]["timeouts"] == 2
    assert not r["receiver_metrics"].get("delivered", 0)
    assert r["metrics"]["nacks"] == 0
    events = r["trace"]
    assert events[1]["event"] == "TIMEOUT"
    assert events[1]["time_ms"] - events[0]["time_ms"] >= 150


def test_bounded_sample_queue_overflow_is_measured_and_breaks_delivery():
    r = run_hardware(
        config(
            packets=1,
            payload_bytes=128,
            max_transmissions=1,
            propagation_ms=30,
            iq_queue_samples=8192,
            ack_timeout_ms=200,
        )
    )
    assert r["channel_metrics"]["metrics"]["overflow_samples"] > 0
    assert r["channel_metrics"]["metrics"]["peak_queue_samples"] <= 8192
    assert r["metrics"]["acknowledged"] == 0
    assert r["metrics"]["timeouts"] == 1


def test_cancel_stops_and_reaps_all_children():
    existing = {p.pid for p in mp.active_children()}
    stop = threading.Event()
    timer = threading.Timer(0.8, stop.set)
    timer.start()
    began = time.monotonic()
    try:
        with pytest.raises(SimulationCancelled):
            run_hardware(config(packets=100, propagation_ms=500, duration_s=30), stop.is_set)
    finally:
        timer.cancel()
    assert time.monotonic() - began < 8
    assert not [p for p in mp.active_children() if p.pid not in existing]


def test_realtime_configuration_does_not_require_rf_permission_or_allow_capture():
    assert config().allow_tx is False
    with pytest.raises(ValidationError):
        config(action="capture")
