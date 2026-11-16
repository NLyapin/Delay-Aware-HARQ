"""Versioned little-endian complex64 I/Q UDP interface for a board RF/DMA service.

This implements the host side of a new project contract, NOT a vendor LX2160A driver.
The peer RF/DMA service must implement the same framing on the selected board.
"""

import secrets
import socket
import struct
import time
import zlib

import numpy as np

from .config import HardwareConfig
from .waveform import FrameSynchronizer

DATAGRAM = struct.Struct("!4sBBHIIHHI")
SAMPLES_PER_FRAGMENT = 128


def pack_iq(iq: np.ndarray, *, kind: int, session: int, sequence: int, sample_rate: int):
    data = np.asarray(iq, dtype="<c8").tobytes()
    size = SAMPLES_PER_FRAGMENT * 8
    count = (len(data) + size - 1) // size
    if not 1 <= count <= 4096 or kind not in (1, 2):
        raise ValueError("Invalid board IQ frame")
    out = []
    for index in range(count):
        chunk = data[index * size : (index + 1) * size]
        header = DATAGRAM.pack(b"HIQ1", 1, kind, len(chunk), session, sequence, index, count, sample_rate)
        body = header + chunk
        out.append(body + struct.pack("!I", zlib.crc32(body)))
    return out


class IQReassembler:
    def __init__(self, sample_rate: int):
        self.sample_rate = sample_rate
        self.pending = {}
        self.completed = set()

    def accept(self, data: bytes, expected_kind: int = 2):
        if len(data) < DATAGRAM.size + 4:
            raise ValueError("Short board datagram")
        body, crc = data[:-4], data[-4:]
        if zlib.crc32(body) != struct.unpack("!I", crc)[0]:
            raise ValueError("Board CRC32 mismatch")
        magic, version, kind, size, session, sequence, index, count, rate = DATAGRAM.unpack(
            body[: DATAGRAM.size]
        )
        if (
            magic != b"HIQ1"
            or version != 1
            or kind != expected_kind
            or rate != self.sample_rate
            or not 1 <= count <= 4096
            or not 0 <= index < count
            or size % 8
            or size > 1024
            or size != len(body) - DATAGRAM.size
        ):
            raise ValueError("Invalid board datagram header")
        now = time.monotonic()
        self.pending = {k: v for k, v in self.pending.items() if now - v[0] < 2}
        key = (session, sequence)
        if key in self.completed:
            return None
        if key not in self.pending:
            if len(self.pending) >= 8:
                raise ValueError("Board reassembly queue is full")
            self.pending[key] = (now, count, {})
        _, expected, fragments = self.pending[key]
        if expected != count:
            raise ValueError("Conflicting fragment count")
        chunk = body[DATAGRAM.size :]
        if index in fragments and fragments[index] != chunk:
            raise ValueError("Conflicting duplicate fragment")
        fragments[index] = chunk
        if len(fragments) != count:
            return None
        iq = np.frombuffer(b"".join(fragments[i] for i in range(count)), dtype="<c8").copy()
        if not np.isfinite(iq).all():
            raise ValueError("Non-finite IQ")
        del self.pending[key]
        self.completed.add(key)
        if len(self.completed) > 10000:
            raise RuntimeError("Board duplicate history limit reached; restart the session")
        return iq


class BoardRadio:
    def __init__(self, c: HardwareConfig):
        self.config = c
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.socket.bind(("0.0.0.0", c.local_port))
        self.socket.settimeout(0.05)
        self.peer = (c.board_host, c.board_port)
        self.session = secrets.randbits(32)
        self.sequence = 0
        self.reassembler = IQReassembler(c.sample_rate)
        self.sync = FrameSynchronizer(c.samples_per_symbol, c.sample_rate)
        self.overruns = 0

    def send(self, iq):
        if not self.config.allow_tx:
            raise RuntimeError("TX выключен")
        self.sequence += 1
        for packet in pack_iq(
            iq, kind=1, session=self.session, sequence=self.sequence, sample_rate=self.config.sample_rate
        ):
            self.socket.sendto(packet, self.peer)

    def receive_iq(self, timeout=0.05):
        self.socket.settimeout(timeout)
        try:
            data, source = self.socket.recvfrom(2048)
        except TimeoutError:
            return None
        if source != self.peer:
            return None
        try:
            return self.reassembler.accept(data)
        except ValueError:
            self.overruns += 1
            return None

    def receive(self, timeout=0.05):
        data = self.receive_iq(timeout)
        return self.sync.feed(data) if data is not None else []

    def close(self):
        self.socket.close()
