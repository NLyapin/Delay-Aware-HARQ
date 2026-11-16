"""Versioned RF frame: PN preamble, triplicated CRC32 header, punctured conv-code payload.

Simple rectangular-pulse BPSK is a laboratory reference, not a production modem.
"""

import struct
import zlib
from dataclasses import dataclass

import numpy as np
from scipy.signal import correlate

from harq_lab.phy import crc_frame, encode

HEADER = struct.Struct("!4sBBBBIIHHI")
HEADER_BYTES = HEADER.size + 4
HEADER_SYMBOLS = HEADER_BYTES * 8 * 3
PN = 1 - 2 * np.random.default_rng(193).integers(0, 2, 32)
PREAMBLE = np.tile(PN, 2)
MODES = {"type1": 0, "cc": 1, "ir": 2}


@dataclass(frozen=True)
class RFFrame:
    kind: int  # 0 DATA, 1 ACK, 2 NACK
    mode: int
    attempt: int
    packet: int
    process: int
    payload_bytes: int
    session: int
    llr: np.ndarray
    snr_db: float = 0


def redundancy_mask(payload_bytes: int, mode: int, attempt: int) -> np.ndarray:
    n = ((payload_bytes + 2) * 8 + 2) * 2
    first = np.resize(np.array([True, True, True, False]), n)
    if mode != 2:
        return first
    if attempt == 1:
        return first
    if attempt == 2:
        return ~first
    return np.ones(n, dtype=bool)


def make_waveform(
    payload: bytes,
    *,
    packet: int,
    process: int,
    session: int,
    attempt: int,
    mode: int,
    sps: int,
    kind: int = 0,
) -> np.ndarray:
    if kind not in (0, 1, 2) or mode not in (0, 1, 2) or not 1 <= attempt <= 8:
        raise ValueError("Invalid RF frame fields")
    if not 4 <= sps <= 32 or len(payload) > 256 or (kind == 0 and len(payload) < 8):
        raise ValueError("Invalid payload or samples per symbol")
    coded = (
        encode(crc_frame(payload))[redundancy_mask(len(payload), mode, attempt)]
        if kind == 0
        else np.array([], dtype=np.int8)
    )
    data = HEADER.pack(b"HQR1", 1, kind, mode, attempt, packet, process, len(payload), len(coded), session)
    header = data + struct.pack("!I", zlib.crc32(data))
    bits = np.concatenate([np.repeat(np.unpackbits(np.frombuffer(header, dtype=np.uint8)), 3), coded])
    symbols = np.concatenate([PREAMBLE, 1 - 2 * bits.astype(np.float64)])
    # Guard intervals prevent a frame touching the edge of a DMA buffer.
    return np.concatenate([np.zeros(8 * sps), np.repeat(symbols, sps), np.zeros(8 * sps)]).astype(
        np.complex64
    )


class FrameSynchronizer:
    """Streaming coarse CFO search + PN correlation, phase recovery and soft BPSK."""

    def __init__(self, sps: int, sample_rate: int, max_buffer: int = 262144):
        self.sps, self.sample_rate, self.max_buffer = sps, sample_rate, max_buffer
        self.pending = np.array([], dtype=np.complex64)
        self.template = np.repeat(PREAMBLE, sps).astype(np.complex64)
        self.rejected_headers = 0

    def feed(self, iq: np.ndarray) -> list[RFFrame]:
        iq = np.asarray(iq, dtype=np.complex64)
        if iq.ndim != 1 or not np.isfinite(iq).all():
            raise ValueError("IQ must be a finite one-dimensional vector")
        self.pending = np.concatenate([self.pending, iq])[-self.max_buffer :]
        frames = []
        minimum = (len(PREAMBLE) + HEADER_SYMBOLS) * self.sps
        while len(self.pending) >= minimum:
            # Dense CFO acquisition bins avoid mistaking a preamble sidelobe for a header.
            best = None
            t = np.arange(len(self.pending)) / self.sample_rate
            bin_hz = self.sample_rate / (128 * self.sps)
            power = np.convolve(abs(self.pending) ** 2, np.ones(len(self.template)), mode="valid")
            for hz in (i * bin_hz for i in range(-6, 7)):
                corrected = self.pending * np.exp(-2j * np.pi * hz * t)
                corr = correlate(corrected, self.template, mode="valid", method="fft")
                norm = abs(corr) / np.sqrt(np.maximum(power * len(self.template), 1e-20))
                # Lock to the full preamble maximum, not an autocorrelation sidelobe.
                index = int(np.argmax(norm))
                if norm[index] >= 0.20 and (best is None or norm[index] > best[1]):
                    best = (index, float(norm[index]), corrected)
            if best is None:
                self.pending = self.pending[-minimum:]
                break
            index, _, corrected = best
            if len(corrected) - index < minimum:
                self.pending = self.pending[index:]
                break
            segment = corrected[index:]
            half = 32 * self.sps
            delta = np.angle(np.vdot(segment[:half], segment[half : 2 * half])) / half
            segment = segment * np.exp(-1j * delta * np.arange(len(segment)))
            phase = np.angle(np.vdot(self.template, segment[: len(self.template)]))
            segment = segment * np.exp(-1j * phase)
            symbols = segment[: len(segment) // self.sps * self.sps].reshape(-1, self.sps).mean(axis=1)
            # A finite preamble cannot estimate CFO accurately enough for a whole payload.
            # Continue tracking residual carrier with a training-aided BPSK Costas loop.
            tracked = np.empty_like(symbols)
            carrier = frequency = 0.0
            for i, symbol in enumerate(symbols):
                corrected_symbol = symbol * np.exp(-1j * carrier)
                decision = PREAMBLE[i] if i < len(PREAMBLE) else (1 if corrected_symbol.real >= 0 else -1)
                error = float(np.angle(corrected_symbol * decision))
                frequency += 0.001 * error
                carrier += frequency + 0.08 * error
                tracked[i] = corrected_symbol
            symbols = tracked
            training = symbols[: len(PREAMBLE)]
            amplitude = max(float(np.mean(training.real * PREAMBLE)), 1e-8)
            variance = max(float(np.mean(abs(training - amplitude * PREAMBLE) ** 2)), amplitude**2 * 1e-5)
            llr = 4 * symbols.real * amplitude / variance
            header_soft = llr[len(PREAMBLE) : len(PREAMBLE) + HEADER_SYMBOLS].reshape(-1, 3).sum(axis=1)
            raw = np.packbits((header_soft < 0).astype(np.uint8)).tobytes()
            data, crc = raw[:-4], raw[-4:]
            if zlib.crc32(data) != struct.unpack("!I", crc)[0]:
                self.rejected_headers += 1
                self.pending = self.pending[index + len(self.template) :]
                continue
            magic, version, kind, mode, attempt, packet, process, size, count, session = HEADER.unpack(data)
            expected = int(redundancy_mask(size, mode, attempt).sum()) if kind == 0 and size <= 256 else 0
            if (
                magic != b"HQR1"
                or version != 1
                or kind not in (0, 1, 2)
                or mode not in (0, 1, 2)
                or not 1 <= attempt <= 8
                or process >= 32
                or size > 256
                or (kind == 0 and (size < 8 or count != expected))
                or (kind != 0 and count != 0)
            ):
                self.rejected_headers += 1
                self.pending = self.pending[index + len(self.template) :]
                continue
            end = (len(PREAMBLE) + HEADER_SYMBOLS + count) * self.sps
            if len(segment) < end:
                self.pending = self.pending[index:]
                break
            body = llr[len(PREAMBLE) + HEADER_SYMBOLS : len(PREAMBLE) + HEADER_SYMBOLS + count].copy()
            snr = float(10 * np.log10(max(amplitude**2 / variance, 1e-12)))
            frames.append(RFFrame(kind, mode, attempt, packet, process, size, session, body, snr))
            self.pending = self.pending[index + end :]
        return frames
