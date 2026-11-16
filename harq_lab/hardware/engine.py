"""Portable host-clock HARQ over decoded RF frames. No BLER oracle in physical mode."""

import heapq
import secrets
import threading
import time
from collections import Counter

import numpy as np

from harq_lab.phy import crc_valid, viterbi
from harq_lab.simulator import SimulationCancelled

from .config import HardwareConfig
from .radio import PlutoRadio, software_pair
from .waveform import RFFrame, make_waveform, redundancy_mask


def mode_for(algorithm):
    return {"chase": 1, "ir": 2}.get(algorithm, 0)


class PhysicalReceiver:
    def __init__(self, c: HardwareConfig, radio):
        self.c, self.radio = c, radio
        self.buffers = {}
        self.delivered = set()
        self.feedback = []
        self.sequence = 0
        self.count = Counter()
        self.trace = []
        self.started = time.monotonic()

    def log(self, event, frame, **extra):
        if len(self.trace) < 4000:
            self.trace.append(
                {
                    "time_ms": (time.monotonic() - self.started) * 1000,
                    "event": event,
                    "packet": frame.packet,
                    "process": frame.process,
                    "attempt": frame.attempt,
                    **extra,
                }
            )

    def accept(self, f: RFFrame):
        if f.kind != 0:
            return
        self.count["data_frames"] += 1
        key = (f.session, f.packet, f.process)
        success = key in self.delivered
        if success:
            self.count["duplicates"] += 1
        else:
            identity = (f.mode, f.payload_bytes)
            previous = self.buffers.get(key)
            if previous is not None and previous[0] != identity:
                self.count["invalid_frames"] += 1
                return
            n = ((f.payload_bytes + 2) * 8 + 2) * 2
            llr = np.zeros(n) if previous is None or f.mode == 0 else previous[1]
            llr[redundancy_mask(f.payload_bytes, f.mode, f.attempt)] += f.llr
            success = crc_valid(viterbi(llr))
            self.count["decoded"] += 1
            if success:
                self.delivered.add(key)
                self.buffers.pop(key, None)
                self.count["delivered"] += 1
            else:
                self.buffers[key] = (identity, llr, time.monotonic())
                self.count["decode_errors"] += 1
        self.log("RX_ACK" if success else "RX_NACK", f, snr_db=f.snr_db)
        self.sequence += 1
        heapq.heappush(
            self.feedback, (time.monotonic() + self.c.feedback_delay_ms / 1000, self.sequence, f, success)
        )

    def step(self):
        for f in self.radio.receive(0.01):
            self.accept(f)
        while self.feedback and self.feedback[0][0] <= time.monotonic():
            _, _, frame, success = heapq.heappop(self.feedback)
            iq = make_waveform(
                b"",
                packet=frame.packet,
                process=frame.process,
                session=frame.session,
                attempt=frame.attempt,
                mode=frame.mode,
                sps=self.c.samples_per_symbol,
                kind=1 if success else 2,
            )
            self.radio.send(iq)
            self.count["feedback_sent"] += 1
        # Bound receiver resources, including abandoned packets and duplicate history.
        cutoff = time.monotonic() - self.c.duration_s
        self.buffers = {k: v for k, v in self.buffers.items() if v[2] >= cutoff}
        if len(self.buffers) > 512:
            raise RuntimeError("Переполнение мягкого буфера приёмника")
        if len(self.delivered) > 10000:
            raise RuntimeError("Переполнение окна подавления дубликатов")


def transmit(c: HardwareConfig, radio, cancelled=lambda: False):
    start = time.monotonic()
    session = secrets.randbits(32)
    rng = np.random.default_rng(c.seed)
    active = {}
    free = list(range(1 if c.algorithm == "stop_wait" else c.processes))
    count = Counter()
    latencies = []
    trace = []
    next_packet = 0
    last_error = None

    def log(event, p, **extra):
        if len(trace) < 4000:
            trace.append(
                {
                    "time_ms": (time.monotonic() - start) * 1000,
                    "event": event,
                    "packet": p["packet"],
                    "process": p["process"],
                    "attempt": p["attempt"],
                    **extra,
                }
            )

    def send(p):
        p["attempt"] += 1
        # Deadline starts after submitting this burst, avoiding a timeout while it is still queued.
        iq = make_waveform(
            p["payload"],
            packet=p["packet"],
            process=p["process"],
            session=session,
            attempt=p["attempt"],
            mode=mode_for(c.algorithm),
            sps=c.samples_per_symbol,
        )
        log("TX_START", p, iq_samples=len(iq))
        radio.send(iq)
        p["sent_at"] = time.monotonic()
        p["timeout"] = p["sent_at"] + c.ack_timeout_ms / 1000
        count["transmissions"] += 1
        count["tx_samples"] += len(iq)

    while (next_packet < c.packets or active) and time.monotonic() - start < c.duration_s:
        if cancelled():
            raise SimulationCancelled()
        while free and next_packet < c.packets:
            process = free.pop(0)
            p = {
                "packet": next_packet,
                "process": process,
                "attempt": 0,
                "birth": time.monotonic(),
                "payload": rng.bytes(c.payload_bytes),
            }
            next_packet += 1
            active[process] = p
            count["started"] += 1
            send(p)
        responses = {}
        for f in radio.receive(0.01):
            p = active.get(f.process)
            if (
                f.session != session
                or p is None
                or f.packet != p["packet"]
                or f.attempt != p["attempt"]
                or f.mode != mode_for(c.algorithm)
            ):
                count["stale_frames"] += 1
                continue
            if f.kind in (1, 2):
                responses[f.process] = f.kind
        for process, p in list(active.items()):
            kind = responses.get(process)
            if kind == 1:
                log("ACK", p, rtt_host_ms=(time.monotonic() - p["sent_at"]) * 1000)
                count["acknowledged"] += 1
                latencies.append((time.monotonic() - p["birth"]) * 1000)
                del active[process]
                free.append(process)
            elif kind == 2 or time.monotonic() >= p["timeout"]:
                event = "NACK" if kind == 2 else "TIMEOUT"
                log(event, p)
                count["nacks" if kind == 2 else "timeouts"] += 1
                if p["attempt"] >= c.max_transmissions:
                    count["unacknowledged"] += 1
                    log("UNACKNOWLEDGED", p)
                    del active[process]
                    free.append(process)
                else:
                    send(p)
    elapsed = time.monotonic() - start
    count["censored"] = len(active)
    return {
        "metrics": dict(count),
        "trace": trace,
        "elapsed_s": elapsed,
        "acked_goodput_kbps": count["acknowledged"] * c.payload_bytes * 8 / elapsed / 1000,
        "ack_p95_host_ms": float(np.percentile(latencies, 95)) if latencies else None,
        "session": session,
        "error": last_error,
        "measurement_note": "Host-clock TX-to-ACK latency; includes processing, DMA and both RF directions. "
        "Unacknowledged does not prove receiver loss. Payload delivery is confirmed at RX.",
    }


def run_hardware(c: HardwareConfig, cancelled=lambda: False) -> dict:
    started = time.monotonic()
    if c.backend == "software_iq":
        tx, rx = software_pair(c)
        receiver = PhysicalReceiver(c, rx)
        stop = threading.Event()
        errors = []

        def receive_worker():
            try:
                while not stop.is_set():
                    receiver.step()
            except Exception as error:
                errors.append(str(error))
                stop.set()

        worker = threading.Thread(target=receive_worker, daemon=True)
        worker.start()
        try:
            result = transmit(c, tx, lambda: cancelled() or bool(errors))
        finally:
            stop.set()
            worker.join(timeout=2)
            tx.close()
            rx.close()
        if errors:
            raise RuntimeError(errors[0])
        result["receiver_metrics"] = dict(receiver.count)
        result["receiver_trace"] = receiver.trace
        result["source"] = "software_iq_physical_reference"
    else:
        radio = PlutoRadio(c)
        try:
            if c.action == "transmit":
                result = transmit(c, radio, cancelled)
            elif c.action == "receive":
                receiver = PhysicalReceiver(c, radio)
                while time.monotonic() - started < c.duration_s:
                    if cancelled():
                        raise SimulationCancelled()
                    receiver.step()
                result = {
                    "metrics": dict(receiver.count),
                    "trace": receiver.trace,
                    "elapsed_s": time.monotonic() - started,
                }
            else:
                data = None
                while data is None and time.monotonic() - started < min(c.duration_s, 5):
                    if cancelled():
                        raise SimulationCancelled()
                    data = radio.receive_iq()
                if data is None:
                    raise RuntimeError("IIO не вернул IQ в течение 5 с")
                fft = np.fft.fftshift(np.fft.fft(data[:4096]))
                result = {
                    "metrics": {
                        "iq_samples": len(data),
                        "mean_power_dbfs": float(
                            10 * np.log10(max(np.mean(abs(data) ** 2) / (2048**2), 1e-15))
                        ),
                    },
                    "spectrum_db": (20 * np.log10(np.maximum(abs(fft) / len(fft) / 2048, 1e-12))).tolist(),
                    "iq_preview": [[float(z.real), float(z.imag)] for z in data[:500]],
                    "elapsed_s": time.monotonic() - started,
                    "tx_started": False,
                }
            result["source"] = "pluto_iio_hardware"
            result["rx_overruns"] = radio.overruns
        finally:
            radio.close()
    result["config"] = c.model_dump()
    result["hardware_verified_by_developer"] = False
    result["elapsed_total_s"] = time.monotonic() - started
    return result
