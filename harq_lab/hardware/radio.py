"""Physical transport adapters. Software transport is explicitly labelled, never called RF."""

import queue
import threading
import time

import numpy as np

from .config import HardwareConfig
from .waveform import FrameSynchronizer, RFFrame


class SoftwareIQRadio:
    def __init__(self, c: HardwareConfig, seed: int):
        self.config = c
        self.incoming = queue.Queue(maxsize=256)
        self.peer = None
        self.rng = np.random.default_rng(seed)
        self.sync = FrameSynchronizer(c.samples_per_symbol, c.sample_rate)
        self.closed = False

    def send(self, iq: np.ndarray):
        if self.closed or self.peer is None:
            raise RuntimeError("IQ transport is closed or unpaired")
        # SNR is Es/N0 at the symbol rate. Integrating sps samples restores this budget.
        sigma = np.sqrt(self.config.samples_per_symbol / (2 * 10 ** (self.config.snr_db / 10)))
        noisy = iq + (self.rng.standard_normal(len(iq)) + 1j * self.rng.standard_normal(len(iq))) * sigma
        # Deterministic fractional carrier rotation, tested by the real acquisition chain.
        noisy = noisy * np.exp(1j * (0.23 + 2 * np.pi * 350 * np.arange(len(iq)) / self.config.sample_rate))
        self.peer.incoming.put(noisy.astype(np.complex64), timeout=1)

    def receive(self, timeout: float = 0.02) -> list[RFFrame]:
        try:
            samples = self.incoming.get(timeout=timeout)
        except queue.Empty:
            return []
        return self.sync.feed(samples)

    def close(self):
        self.closed = True


def software_pair(c: HardwareConfig):
    a, b = SoftwareIQRadio(c, c.seed), SoftwareIQRadio(c, c.seed + 1)
    a.peer, b.peer = b, a
    return a, b


class PlutoRadio:
    """One RX context and one TX context; all TX is bounded, non-cyclic and explicit."""

    def __init__(self, c: HardwareConfig):
        try:
            import adi
        except ImportError as error:
            raise RuntimeError(
                "Драйвер Pluto не установлен: uv sync --extra hardware; также нужна системная libiio"
            ) from error
        self.config = c
        self.rx = adi.Pluto(uri=c.uri)
        self.rx._ctx.set_timeout(1000)
        self.rx.sample_rate = c.sample_rate
        self.rx.rx_lo = c.center_hz
        self.rx.rx_rf_bandwidth = c.bandwidth_hz
        self.rx.gain_control_mode_chan0 = "manual"
        self.rx.rx_hardwaregain_chan0 = c.rx_gain_db
        self.rx.rx_buffer_size = c.rx_buffer_size
        self.rx.rx_enabled_channels = [0]
        self.tx = None
        if c.allow_tx:
            self.tx = adi.Pluto(uri=c.uri)
            self.tx._ctx.set_timeout(1000)
            self.tx.tx_lo = c.center_hz
            self.tx.tx_rf_bandwidth = c.bandwidth_hz
            self.tx.tx_hardwaregain_chan0 = c.tx_gain_db
            self.tx.tx_cyclic_buffer = False
            self.tx.tx_enabled_channels = [0]
        self.sync = FrameSynchronizer(c.samples_per_symbol, c.sample_rate)
        self.closed = False
        self.queue = queue.Queue(maxsize=32)
        self.error = None
        self.overruns = 0
        self.worker = threading.Thread(target=self._read, daemon=True)
        self.worker.start()

    def _read(self):
        while not self.closed:
            try:
                data = np.asarray(self.rx.rx(), dtype=np.complex64)
                self.queue.put(data, timeout=0.2)
            except queue.Full:
                self.overruns += 1
            except Exception as error:
                if not self.closed:
                    self.error = f"Ошибка IIO RX: {error}"
                break

    def receive_iq(self, timeout: float = 0.05):
        if self.error:
            raise RuntimeError(self.error)
        try:
            return self.queue.get(timeout=timeout)
        except queue.Empty:
            return None

    def receive(self, timeout: float = 0.05):
        data = self.receive_iq(timeout)
        return self.sync.feed(data) if data is not None else []

    def send(self, iq: np.ndarray):
        if not self.config.allow_tx or self.tx is None:
            raise RuntimeError("TX отключён; разрешение требуется также для ACK/NACK")
        if self.closed:
            raise RuntimeError("Радио закрыто")
        self.tx.tx_destroy_buffer()
        # AD936x raw signed sample scale; avoid clipping and use conservative default gain.
        self.tx.tx((np.asarray(iq) * 4096).astype(np.complex64))
        time.sleep(len(iq) / self.config.sample_rate)

    def close(self):
        self.closed = True
        self.worker.join(timeout=1.5)
        if self.worker.is_alive():
            raise RuntimeError(
                "Поток IIO RX не остановился за 1,5 с; перезапустите агент перед новым запуском"
            )
        self.rx.rx_destroy_buffer()
        if self.tx is not None:
            self.tx.tx_destroy_buffer()


def probe_pluto(uri: str) -> dict:
    """Read context only: do not configure RF or start a DAC buffer."""
    if not uri.startswith(("ip:", "usb:", "local:")) or len(uri) > 200:
        raise ValueError("Недопустимый IIO URI")
    try:
        import iio
    except ImportError as error:
        raise RuntimeError("Нужны Python bindings libiio и системная libiio; см. docs/HARDWARE.md") from error
    context = iio.Context(uri)
    context.set_timeout(1500)
    return {
        "uri": uri,
        "description": str(context.description),
        "devices": [{"id": d.id, "name": d.name} for d in context.devices],
        "tx_started": False,
    }
