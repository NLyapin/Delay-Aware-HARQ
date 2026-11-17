"""Wall-clock, three-process I/Q testbed. The propagation medium is software, not RF.

DATA and feedback share the same sample transport and acquisition chain. The channel
never inspects HARQ headers, CRC outcomes or decoded bits. OS socket buffers, bounded
application queues and native Python DSP execution determine actual host timing.
"""

import heapq
import multiprocessing as mp
import os
import select
import socket
import struct
import sys
import time
from collections import Counter, deque

import numpy as np

from harq_lab.simulator import SimulationCancelled

from .config import HardwareConfig
from .engine import PhysicalReceiver, transmit
from .waveform import FrameSynchronizer

LENGTH = struct.Struct("!I")
MAX_SAMPLES = 262144


def runtime_info(cpu, epoch):
    data = {
        "pid": os.getpid(),
        "cpu_s": time.process_time() - cpu,
        "elapsed_s": time.monotonic() - epoch.value,
    }
    try:
        import resource

        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        data["peak_rss_mb"] = rss / (1024**2 if sys.platform == "darwin" else 1024)
    except ImportError:
        pass
    return data


def pack_samples(iq):
    samples = np.asarray(iq, dtype="<c8")
    if samples.ndim != 1 or not 0 < len(samples) <= MAX_SAMPLES or not np.isfinite(samples).all():
        raise ValueError("Invalid realtime IQ block")
    payload = samples.tobytes()
    return LENGTH.pack(len(payload)) + payload


def unpack_samples(buffer):
    blocks = []
    offset = 0
    while len(buffer) - offset >= LENGTH.size:
        size = LENGTH.unpack_from(buffer, offset)[0]
        if not 0 < size <= MAX_SAMPLES * 8 or size % 8:
            raise ValueError("Invalid realtime IQ record length")
        if len(buffer) - offset < size + LENGTH.size:
            break
        offset += LENGTH.size
        blocks.append(np.frombuffer(buffer[offset : offset + size], dtype="<c8").copy())
        offset += size
    if offset:
        del buffer[:offset]
    return blocks


class IQStreamRadio:
    def __init__(self, c, sock):
        self.config, self.sock = c, sock
        self.sock.settimeout(0.2)
        self.sync = FrameSynchronizer(c.samples_per_symbol, c.sample_rate, c.rx_buffer_size)
        self.pending = bytearray()
        self.samples = 0
        self.processing_s = 0.0
        self.max_processing_ms = 0.0
        self.preview = np.array([], dtype=np.complex64)

    def send(self, iq):
        self.sock.sendall(pack_samples(iq))

    def receive(self, timeout=0.01):
        if not select.select([self.sock], [], [], timeout)[0]:
            return []
        data = self.sock.recv(65536)
        if not data:
            raise RuntimeError("Realtime sample channel closed unexpectedly")
        self.pending.extend(data)
        frames = []
        for block in unpack_samples(self.pending):
            self.samples += len(block)
            self.preview = np.concatenate([self.preview, block])[-4096:]
            started = time.perf_counter()
            frames.extend(self.sync.feed(block))
            duration = time.perf_counter() - started
            self.processing_s += duration
            self.max_processing_ms = max(self.max_processing_ms, duration * 1000)
        return frames

    def diagnostics(self):
        data = self.preview
        spectrum = []
        if len(data):
            power = np.fft.fftshift(np.fft.fft(data * np.hanning(len(data))))
            spectrum = (20 * np.log10(np.maximum(abs(power) / len(data), 1e-10))).tolist()
        return {
            "rx_samples": self.samples,
            "acquisition_cpu_wall_s": self.processing_s,
            "max_acquisition_call_ms": self.max_processing_ms,
            "sync_overflow_samples": self.sync.dropped_samples,
            "peak_sync_samples": self.sync.peak_pending_samples,
            "rejected_headers": self.sync.rejected_headers,
            "signal": {
                "sample_rate": self.config.sample_rate,
                "iq": [[float(z.real), float(z.imag)] for z in data[:512]],
                "spectrum_db": spectrum,
                **self.sync.last_diagnostics,
            },
        }


class SampleChannel:
    """Sample impairments, never a Bernoulli packet success/loss oracle."""

    def __init__(self, c, seed):
        self.c = c
        self.rng = np.random.default_rng(seed)
        self.phase = self.rng.uniform(-np.pi, np.pi)
        self.sample_index = 0

    def apply(self, iq):
        c = self.c
        data = np.asarray(iq, dtype=np.complex128)
        if c.echo_delay_samples:
            delay = c.echo_delay_samples
            echo = np.zeros(len(data) + delay, dtype=np.complex128)
            echo[: len(data)] += data
            echo[delay:] += data * 10 ** (c.echo_gain_db / 20) * np.exp(0.6j)
            data = echo
        if c.clock_offset_ppm:
            positions = np.arange(0, len(data) - 1, 1 + c.clock_offset_ppm * 1e-6)
            axis = np.arange(len(data))
            data = np.interp(positions, axis, data.real) + 1j * np.interp(positions, axis, data.imag)
        axis = self.sample_index + np.arange(len(data))
        data *= np.exp(1j * (self.phase + 2 * np.pi * c.carrier_offset_hz * axis / c.sample_rate))
        self.sample_index += len(data)
        sigma = np.sqrt(c.samples_per_symbol / (2 * 10 ** (c.snr_db / 10)))
        data += sigma * (self.rng.standard_normal(len(data)) + 1j * self.rng.standard_normal(len(data)))
        return data.astype(np.complex64)


def _role(kind, config, sock, start, stop, epoch, report):
    c = HardwareConfig.model_validate(config)
    radio = IQStreamRadio(c, sock)
    report.send({"role": kind, "ready": True, "pid": os.getpid()})
    try:
        start.wait()
        cpu = time.process_time()
        if kind == "tx":
            result = transmit(c, radio, stop.is_set, clock_origin=epoch.value)
        else:
            receiver = PhysicalReceiver(c, radio)
            receiver.started = epoch.value
            while not stop.is_set() and time.monotonic() - epoch.value < c.duration_s:
                try:
                    receiver.step()
                except (RuntimeError, OSError):
                    if not stop.is_set():
                        raise
                    break
            result = {"receiver_metrics": dict(receiver.count), "receiver_trace": receiver.trace}
        result["transport"] = radio.diagnostics()
        result["runtime"] = runtime_info(cpu, epoch)
        report.send({"role": kind, "result": result})
    except Exception as error:
        if not stop.is_set():
            report.send({"role": kind, "error": f"{type(error).__name__}: {error}"})
    finally:
        # Keep endpoints open until all participants have been asked to stop.
        # A fast TX must not close the sample channel while RX still sends its final ACK.
        stop.wait(c.duration_s + 1)
        sock.close()
        report.close()


def _channel(config, sockets, start, stop, epoch, report):
    c = HardwareConfig.model_validate(config)
    channels = [SampleChannel(c, c.seed + 100), SampleChannel(c, c.seed + 200)]
    incoming = [bytearray(), bytearray()]
    scheduled, outgoing = [], [deque(), deque()]
    queued = [0, 0]
    line_free = [0.0, 0.0]
    arrival_free = [0.0, 0.0]
    count = Counter()
    sequence = 0
    lag_sum, lag_max = 0.0, 0.0
    for sock in sockets:
        sock.setblocking(False)
    report.send({"role": "channel", "ready": True, "pid": os.getpid()})
    try:
        start.wait()
        cpu = time.process_time()
        while not stop.is_set() and time.monotonic() - epoch.value < c.duration_s + 0.5:
            now = time.monotonic()
            while scheduled and scheduled[0][0] <= now:
                due, _, dest, chunk = heapq.heappop(scheduled)
                late = max(0, now - due) * 1000
                lag_sum += late
                lag_max = max(lag_max, late)
                count["released_chunks"] += 1
                outgoing[dest].append([memoryview(chunk), LENGTH.size])
            delay = min(0.01, max(0, scheduled[0][0] - now)) if scheduled else 0.01
            readable, writable, _ = select.select(
                sockets, [sockets[i] for i in range(2) if outgoing[i]], [], delay
            )
            for sock in readable:
                origin = sockets.index(sock)
                data = sock.recv(65536)
                if not data:
                    raise RuntimeError("A realtime endpoint disconnected")
                incoming[origin].extend(data)
                for block in unpack_samples(incoming[origin]):
                    dest = 1 - origin
                    count["submitted_bursts"] += 1
                    count["submitted_samples"] += len(block)
                    began = max(time.monotonic(), line_free[origin])
                    line_free[origin] = began + len(block) / c.sample_rate
                    noise = channels[origin].apply(block)
                    jitter = channels[origin].rng.uniform(0, c.jitter_ms / 1000)
                    arrival = max(began + c.propagation_ms / 1000 + jitter, arrival_free[origin])
                    arrival_free[origin] = arrival + len(noise) / c.sample_rate
                    for offset in range(0, len(noise), c.iq_chunk_samples):
                        chunk = pack_samples(noise[offset : offset + c.iq_chunk_samples])
                        # Bounded sample capacity includes propagation and socket backpressure.
                        # The serializer still consumes airtime when its output buffer overflows.
                        if queued[dest] + len(chunk) - LENGTH.size > c.iq_queue_samples * 8:
                            count["overflow_samples"] += (len(chunk) - LENGTH.size) // 8
                            continue
                        queued[dest] += len(chunk) - LENGTH.size
                        count["peak_queue_samples"] = max(count["peak_queue_samples"], queued[dest] // 8)
                        sequence += 1
                        due = arrival + min(offset + c.iq_chunk_samples, len(noise)) / c.sample_rate
                        heapq.heappush(scheduled, (due, sequence, dest, chunk))
            for sock in writable:
                dest = sockets.index(sock)
                chunk, header_left = outgoing[dest][0]
                try:
                    sent = sock.send(chunk)
                except BlockingIOError:
                    continue
                queued[dest] -= max(0, sent - header_left)
                if sent == len(chunk):
                    outgoing[dest].popleft()
                    count["delivered_chunks"] += 1
                else:
                    outgoing[dest][0] = [chunk[sent:], max(0, header_left - sent)]
    except Exception as error:
        if not stop.is_set():
            report.send({"role": "channel", "error": f"{type(error).__name__}: {error}"})
    finally:
        report.send(
            {
                "role": "channel",
                "result": {
                    "metrics": dict(count),
                    "scheduler_lag_mean_ms": lag_sum / max(1, count["released_chunks"]),
                    "scheduler_lag_max_ms": lag_max,
                    "pending_samples_at_stop": sum(queued) // 8,
                    "runtime": runtime_info(cpu, epoch),
                },
            }
        )
        for sock in sockets:
            sock.close()
        report.close()


def run_realtime(c: HardwareConfig, cancelled=lambda: False):
    """Spawn-safe for Electron, the CLI, API threads and a PyInstaller executable."""
    if cancelled():
        raise SimulationCancelled()
    began = time.monotonic()
    ctx = mp.get_context("spawn")
    start, stop = ctx.Event(), ctx.Event()
    epoch = ctx.Value("d", 0)
    tx_sock, tx_channel = socket.socketpair()
    rx_sock, rx_channel = socket.socketpair()
    pairs = [ctx.Pipe(duplex=False) for _ in range(3)]
    config = c.model_dump()
    workers = [
        ctx.Process(
            target=_role, args=("tx", config, tx_sock, start, stop, epoch, pairs[0][1]), name="HARQ-TX"
        ),
        ctx.Process(
            target=_role, args=("rx", config, rx_sock, start, stop, epoch, pairs[1][1]), name="HARQ-RX"
        ),
        ctx.Process(
            target=_channel,
            args=(config, [tx_channel, rx_channel], start, stop, epoch, pairs[2][1]),
            name="HARQ-IQ-channel",
        ),
    ]
    ready, results = {}, {}
    try:
        for worker in workers:
            worker.start()
        for sock in [tx_sock, tx_channel, rx_sock, rx_channel]:
            sock.close()
        for _, writer in pairs:
            writer.close()
        deadline = time.monotonic() + 20
        while len(ready) < 3:
            if cancelled():
                raise SimulationCancelled()
            for reader, _ in pairs:
                if reader.poll(0.01):
                    message = reader.recv()
                    if message.get("error"):
                        raise RuntimeError(message["error"])
                    ready[message["role"]] = message["pid"]
            if time.monotonic() > deadline or any(w.exitcode is not None for w in workers):
                raise RuntimeError("Realtime workers failed to initialize within 20 s")
        epoch.value = time.monotonic()
        start.set()
        deadline = epoch.value + c.duration_s + 8
        readers = [p[0] for p in pairs]
        reader_roles = dict(zip(readers, ["tx", "rx", "channel"], strict=True))
        while len(results) < 3:
            if cancelled():
                raise SimulationCancelled()
            for reader in list(readers):
                if not reader.poll(0.01):
                    continue
                try:
                    message = reader.recv()
                except EOFError:
                    if reader_roles[reader] not in results:
                        raise RuntimeError(
                            f"Realtime {reader_roles[reader]} exited without measurements"
                        ) from None
                    readers.remove(reader)
                    continue
                if message.get("error"):
                    raise RuntimeError(f"{message['role']}: {message['error']}")
                results[message["role"]] = message["result"]
                if message["role"] == "tx":
                    stop.set()
            if time.monotonic() > deadline:
                raise RuntimeError("Realtime workers exceeded the shutdown deadline")
        result = results["tx"]
        receiver = results["rx"]
        result["receiver_metrics"] = receiver["receiver_metrics"]
        result["receiver_trace"] = receiver["receiver_trace"]
        result["signal"] = receiver["transport"].pop("signal")
        result["runtime"] = {role: {**results[role]["runtime"], "pid": ready[role]} for role in ready}
        result["receiver_transport"] = receiver["transport"]
        result["channel_metrics"] = {k: v for k, v in results["channel"].items() if k != "runtime"}
        result.update(
            source="cpu_realtime_iq",
            config=config,
            hardware_verified_by_developer=False,
            elapsed_total_s=time.monotonic() - began,
            measurement_note="Стенд CPU реального времени: TX, RX и I/Q-канал в отдельных процессах. "
            "Задержки измерены по монотонным часам хоста, включают DSP и очереди ОС. "
            "Распространение, шум и искажения программные; RF/ADC/DAC отсутствуют. "
            "Это burst-I/Q, не непрерывный поток АЦП и не система жёсткого реального времени.",
        )
        return result
    finally:
        stop.set()
        start.set()
        for sock in [tx_sock, tx_channel, rx_sock, rx_channel]:
            sock.close()
        for worker in workers:
            if worker.pid is not None:
                worker.join(timeout=2)
                if worker.is_alive():
                    worker.terminate()
                    worker.join(timeout=2)
                    if worker.is_alive():
                        worker.kill()
                        worker.join()
        for reader, writer in pairs:
            reader.close()
            writer.close()
