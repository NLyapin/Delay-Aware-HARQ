import numpy as np
import pytest

from harq_lab.phy import crc_frame, crc_valid, encode, phy_experiment, viterbi


def test_crc_known_ccitt_vector():
    bits = crc_frame(b"123456789")
    assert np.packbits(bits[-16:]).tobytes() == bytes.fromhex("29b1")
    assert crc_valid(bits)
    bits[0] ^= 1
    assert not crc_valid(bits)


def test_convolutional_known_sequence_and_soft_decoder():
    # Input 1,0,1,1 + tail 0,0 -> pairs 11 10 00 01 01 11.
    bits = np.array([1, 0, 1, 1], dtype=np.uint8)
    expected = np.array([1, 1, 1, 0, 0, 0, 0, 1, 0, 1, 1, 1])
    assert np.array_equal(encode(bits), expected)
    assert np.array_equal(viterbi(20 * (1 - 2 * expected)), bits)


def test_real_phy_noiseless_limit():
    r = phy_experiment(snr_db=30, blocks=5)
    assert all(row["bler_after_harq"] == 0 for row in r["rows"])
    assert all(row["undetected_errors"] == 0 for row in r["rows"])
    assert all(row["mean_attempts"] == 1 for row in r["rows"])


def test_phy_invalid_parameters():
    with pytest.raises(ValueError):
        phy_experiment(blocks=0)
