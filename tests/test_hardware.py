import shutil
import subprocess
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from harq_lab.api import create_app
from harq_lab.hardware.board import IQReassembler, pack_iq
from harq_lab.hardware.config import HardwareConfig
from harq_lab.hardware.engine import PhysicalReceiver, run_hardware, transmit
from harq_lab.hardware.remote import AgentRequest
from harq_lab.hardware.service import create_agent
from harq_lab.hardware.waveform import FrameSynchronizer, RFFrame, make_waveform, redundancy_mask
from harq_lab.phy import crc_frame, encode


def waveform(**changes):
    return make_waveform(
        b"payload-0123456789", packet=1, process=0, session=1234, attempt=1, mode=1, sps=8, **changes
    )


def test_waveform_recovers_header_and_soft_bits_across_arbitrary_buffers():
    iq = waveform()
    parser = FrameSynchronizer(8, 1000000)
    frames = []
    for chunk in np.array_split(iq, 7):
        frames.extend(parser.feed(chunk))
    assert len(frames) == 1
    f = frames[0]
    assert (f.packet, f.process, f.session, f.attempt) == (1, 0, 1234, 1)
    assert f.llr.shape == (int(redundancy_mask(18, 1, 1).sum()),)
    assert parser.feed(np.zeros(1000, dtype=np.complex64)) == []


def test_carrier_phase_and_frequency_recovery():
    iq = waveform()
    iq = iq * np.exp(1j * (0.8 + 2 * np.pi * 1500 * np.arange(len(iq)) / 1e6))
    frames = FrameSynchronizer(8, 1000000).feed(iq)
    assert len(frames) == 1 and frames[0].session == 1234


def test_corrupted_header_does_not_create_ackable_frame():
    iq = waveform()
    # Flip three replicas of a header bit, after preamble and guard interval.
    start = (8 + 64 + 20 * 3) * 8
    iq[start : start + 3 * 8] *= -1
    parser = FrameSynchronizer(8, 1000000)
    assert parser.feed(iq) == []
    assert parser.rejected_headers > 0


@pytest.mark.parametrize("algorithm", ["stop_wait", "parallel", "chase", "ir"])
def test_real_iq_roundtrip_for_supported_harq_algorithms(algorithm):
    r = run_hardware(HardwareConfig(algorithm=algorithm, snr_db=20, packets=3, duration_s=5))
    assert r["source"] == "software_iq_physical_reference"
    assert r["metrics"]["acknowledged"] == 3
    assert r["receiver_metrics"]["delivered"] == 3
    assert r["metrics"].get("unacknowledged", 0) == 0
    assert r["hardware_verified_by_developer"] is False


def test_physical_receiver_combines_ir_and_suppresses_duplicate_delivery():
    class Radio:
        def __init__(self):
            self.sent = []

        def receive(self, timeout):
            return []

        def send(self, iq):
            self.sent.append(iq)

    radio = Radio()
    receiver = PhysicalReceiver(HardwareConfig(), radio)
    payload = b"12345678"
    coded = encode(crc_frame(payload))
    llr = (1 - 2 * coded) * 100.0
    first = RFFrame(0, 2, 1, 5, 0, len(payload), 7, llr[redundancy_mask(len(payload), 2, 1)])
    receiver.accept(first)
    receiver.accept(first)
    receiver.step()
    assert receiver.count["delivered"] == 1
    assert receiver.count["duplicates"] == 1
    assert len(radio.sent) == 2
    for iq in radio.sent:
        ack = FrameSynchronizer(8, 1000000).feed(iq)[0]
        assert ack.kind == 1 and ack.packet == 5


def test_stale_session_feedback_is_ignored():
    class Radio:
        def __init__(self):
            self.frames = []

        def send(self, iq):
            f = FrameSynchronizer(8, 1000000).feed(iq)[0]
            args = [1, f.mode, f.attempt, f.packet, f.process, 0]
            self.frames.extend(
                [RFFrame(*args, f.session ^ 1, np.array([])), RFFrame(*args, f.session, np.array([]))]
            )

        def receive(self, timeout):
            if self.frames:
                return [self.frames.pop(0)]
            return []

    r = transmit(HardwareConfig(packets=1), Radio())
    assert r["metrics"]["stale_frames"] == 1
    assert r["metrics"]["acknowledged"] == 1


def test_board_datagrams_reassemble_out_of_order_and_reject_crc_and_replay():
    iq = np.arange(2000, dtype=np.float32).astype(np.complex64)
    datagrams = pack_iq(iq, kind=2, session=7, sequence=9, sample_rate=1000000)
    parser = IQReassembler(1000000)
    result = None
    for packet in reversed(datagrams):
        value = parser.accept(packet)
        if value is not None:
            result = value
    np.testing.assert_array_equal(result, iq)
    assert parser.accept(datagrams[0]) is None
    bad = bytearray(datagrams[0])
    bad[-6] ^= 1
    with pytest.raises(ValueError, match="CRC32"):
        parser.accept(bytes(bad))


@pytest.mark.parametrize(
    "kwargs",
    [
        {"backend": "pluto_pair", "uri": "ip:a", "peer_uri": "ip:a", "allow_tx": True},
        {"backend": "pluto_pair", "allow_tx": False},
        {"backend": "board_udp", "action": "receive", "allow_tx": False},
        {"backend": "pluto", "action": "link_test"},
    ],
)
def test_hardware_configuration_never_silently_falls_back(kwargs):
    with pytest.raises(ValidationError):
        HardwareConfig(**kwargs)


def test_remote_agent_cannot_target_an_arbitrary_network_host():
    with pytest.raises(ValidationError):
        AgentRequest(base_url="http://example.com:8766", token="x" * 32, operation="capabilities")


def test_agent_auth_and_hardware_api_job(tmp_path, monkeypatch):
    monkeypatch.setenv("HARQ_AGENT_TOKEN", "x" * 32)
    agent = create_agent()
    with TestClient(agent) as client:
        assert client.get("/api/hardware/capabilities").status_code == 401
        assert (
            client.get("/api/hardware/capabilities", headers={"X-HARQ-Agent-Token": "x" * 32}).status_code
            == 200
        )
    app = create_app(tmp_path / "hardware.sqlite3")
    with TestClient(app) as client:
        response = client.post(
            "/api/hardware/jobs", json={"config": {"packets": 2, "snr_db": 20, "duration_s": 5}}
        )
        assert response.status_code == 202, response.text
        id = response.json()["id"]
        for _ in range(200):
            job = client.get("/api/hardware/jobs/" + id).json()
            if job["status"] in ("completed", "failed"):
                break
            time.sleep(0.02)
        assert job["status"] == "completed", job
        assert job["result"]["metrics"]["acknowledged"] == 2


@pytest.mark.skipif(shutil.which("iverilog") is None, reason="iverilog is not installed")
def test_fpga_timeout_reference(tmp_path):
    output = tmp_path / "timer.vvp"
    subprocess.run(
        ["iverilog", "-g2012", "-o", str(output), "fpga/harq_timer.sv", "fpga/tb_harq_timer.sv"], check=True
    )
    result = subprocess.run(["vvp", str(output)], capture_output=True, text=True, check=True, timeout=5)
    assert "PASS" in result.stdout
