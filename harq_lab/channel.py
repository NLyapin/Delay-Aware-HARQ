"""Time-indexed fading: all algorithms see the same exogenous channel at equal times."""

import math

import numpy as np
from scipy.special import expit

from .config import SimulationConfig


def bler(snr_db: float, threshold_db: float = 0, slope: float = 1.3) -> float:
    return float(expit(-slope * (snr_db - threshold_db)))


class RadioChannel:
    def __init__(self, config: SimulationConfig):
        self.c = config
        # Separate streams for propagation, decoding, feedback; no hidden cross-coupling.
        streams = np.random.SeedSequence(config.seed).spawn(3)
        rng = np.random.default_rng(streams[0])
        self.decode_rng = np.random.default_rng(streams[1])
        self.feedback_rng = np.random.default_rng(streams[2])
        self.step = config.slot_ms * min(1, config.ir_fraction)
        count = math.ceil(config.simulation_time_ms / self.step) + 2
        self.gain = None
        if config.channel != "awgn":
            z = (rng.standard_normal(count) + 1j * rng.standard_normal(count)) / math.sqrt(2)
            if config.channel == "correlated":
                from scipy.signal import lfilter

                rho = math.exp(-self.step / config.coherence_ms)
                # Stationary initial sample; lfilter continuation computes complex AR(1).
                z[1:] = lfilter([math.sqrt(1 - rho**2)], [1, -rho], z[1:], zi=[rho * z[0]])[0]
            if config.channel == "shadowing":
                from scipy.signal import lfilter

                rho = math.exp(-self.step / config.coherence_ms)
                x = rng.standard_normal(count)
                x[1:] = lfilter([math.sqrt(1 - rho**2)], [1, -rho], x[1:], zi=[rho * x[0]])[0]
                # SNR parameter is the median for lognormal shadowing.
                self.gain = 10 ** (config.shadow_sigma_db * x / 10)
            else:
                self.gain = abs(z) ** 2

    def snr(self, time_ms: float) -> float:
        gain = 1 if self.gain is None else self.gain[min(int(time_ms / self.step), len(self.gain) - 1)]
        return 10 ** (self.c.snr_db / 10) * float(gain)

    def failure_probability(self, mode: str, snr_sum: float, information: float, last_snr: float) -> float:
        c = self.c
        if c.decoder == "perfect":
            return 0.0
        if mode == "ir":
            # Map accumulated mutual information to equivalent SNR for a full codeword.
            equivalent = math.expm1(min(50, information / c.symbols_per_block * math.log(2)))
        else:
            equivalent = snr_sum if mode == "cc" else last_snr
        if c.decoder == "ideal":
            return float(math.log2(1 + equivalent) < c.code_rate)
        return bler(10 * math.log10(max(1e-15, equivalent)), c.bler_threshold_db, c.bler_slope)
