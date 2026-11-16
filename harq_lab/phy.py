"""Small real PHY cross-check, independent of the abstract network simulator.

CRC-16/CCITT-FALSE, (7,5) octal K=3 convolutional code, puncturing,
BPSK/AWGN and soft Viterbi. This is deliberately NOT an NR LDPC chain.
"""

import binascii

import numpy as np


def crc_frame(payload: bytes) -> np.ndarray:
    crc = binascii.crc_hqx(payload, 0xFFFF)
    return np.unpackbits(np.frombuffer(payload + crc.to_bytes(2, "big"), dtype=np.uint8))


def crc_valid(bits: np.ndarray) -> bool:
    if len(bits) < 24 or len(bits) % 8:
        return False
    data = np.packbits(bits).tobytes()
    return binascii.crc_hqx(data[:-2], 0xFFFF) == int.from_bytes(data[-2:], "big")


def encode(bits: np.ndarray) -> np.ndarray:
    state, out = 0, []
    for bit in [*bits, 0, 0]:
        reg = (state << 1) | int(bit)
        out.extend(((reg & 0o7).bit_count() % 2, (reg & 0o5).bit_count() % 2))
        state = reg & 3
    return np.array(out, dtype=np.int8)


STATES = np.arange(4)
PREDECESSORS = np.array([[s >> 1, (s >> 1) | 2] for s in STATES])
SIGNS = np.array(
    [
        [
            [1 - 2 * ((((int(p) << 1) | (int(s) & 1)) & g).bit_count() % 2) for g in (0o7, 0o5)]
            for p in PREDECESSORS[s]
        ]
        for s in STATES
    ]
)


def viterbi(llr: np.ndarray) -> np.ndarray:
    if len(llr) % 2:
        raise ValueError("Mother-code LLR length must be even")
    metrics = np.array([0.0, np.inf, np.inf, np.inf])
    history = np.empty((len(llr) // 2, 4), dtype=np.int8)
    for i, observation in enumerate(llr.reshape(-1, 2)):
        candidates = metrics[PREDECESSORS] - np.sum(SIGNS * observation, axis=2)
        choice = np.argmin(candidates, axis=1)
        history[i] = PREDECESSORS[STATES, choice]
        metrics = candidates[STATES, choice]
        metrics -= np.min(metrics)
    state, bits = 0, np.empty(len(history), dtype=np.uint8)
    for i in range(len(history) - 1, -1, -1):
        bits[i] = state & 1
        state = int(history[i, state])
    return bits[:-2]


def phy_experiment(
    snr_db: float = -1, blocks: int = 100, payload_bytes: int = 32, max_transmissions: int = 4, seed: int = 42
) -> dict:
    if not (
        -30 <= snr_db <= 40
        and 1 <= blocks <= 10000
        and 1 <= payload_bytes <= 1024
        and 1 <= max_transmissions <= 8
    ):
        raise ValueError("Invalid PHY experiment parameters")
    payload_rng, noise_rng = [np.random.default_rng(s) for s in np.random.SeedSequence(seed).spawn(2)]
    payloads = [payload_rng.bytes(payload_bytes) for _ in range(blocks)]
    noise_variance = 1 / (2 * 10 ** (snr_db / 10))  # Es/N0, BPSK unit symbol energy.
    rows = []
    for mode in ("type1", "cc", "ir"):
        delivered = errors = undetected = symbols_sent = attempts_total = 0
        for payload in payloads:
            frame = crc_frame(payload)
            coded = encode(frame)
            first_mask = np.resize([True, True, True, False], len(coded))
            llr = np.zeros(len(coded))
            success = False
            for attempt in range(max_transmissions):
                if mode == "ir" and attempt == 1:
                    mask = ~first_mask
                elif mode == "ir" and attempt >= 2:
                    mask = np.ones(len(coded), dtype=bool)
                else:
                    mask = first_mask
                observed = 1 - 2 * coded[mask] + noise_rng.normal(0, np.sqrt(noise_variance), mask.sum())
                if mode == "type1":
                    llr.fill(0)
                llr[mask] += 2 * observed / noise_variance
                decoded = viterbi(llr)
                symbols_sent += int(mask.sum())
                attempts_total += 1
                if crc_valid(decoded):
                    success = True
                    delivered += 1
                    undetected += int(not np.array_equal(decoded, frame))
                    break
            errors += int(not success)
        rows.append(
            {
                "mode": mode,
                "blocks": blocks,
                "delivered": delivered,
                "bler_after_harq": errors / blocks,
                "undetected_errors": undetected,
                "mean_attempts": attempts_total / blocks,
                "symbols_sent": symbols_sent,
                "symbols_per_delivered_payload_bit": symbols_sent / (delivered * payload_bytes * 8)
                if delivered
                else None,
            }
        )
    return {
        "snr_db": snr_db,
        "snr_definition": "Es/N0",
        "seed": seed,
        "payload_bytes": payload_bytes,
        "max_transmissions": max_transmissions,
        "rows": rows,
        "model": "CRC16/CCITT-FALSE + punctured convolutional K=3 (7,5) + soft Viterbi + BPSK/AWGN",
        "note": "Standalone physical cross-check; not NR LDPC and not a calibration of abstract BLER curves. "
        "IR lengths vary; compare symbols as well as attempts. Noise draws are independent across modes.",
    }
