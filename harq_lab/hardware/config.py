from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class HardwareConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, allow_inf_nan=False)
    backend: Literal["software_iq", "pluto", "pluto_pair", "board_udp"] = "software_iq"
    action: Literal["link_test", "receive", "transmit", "capture"] = "link_test"
    uri: str = Field("ip:192.168.2.1", min_length=3, max_length=200)
    peer_uri: str = Field("ip:192.168.3.1", min_length=3, max_length=200)
    board_host: str = "127.0.0.1"
    board_port: int = Field(9120, ge=1024, le=65535)
    local_port: int = Field(9121, ge=1024, le=65535)
    sample_rate: int = Field(1_000_000, ge=520_834, le=10_000_000)
    center_hz: int = Field(2_400_000_000, ge=325_000_000, le=3_800_000_000)
    bandwidth_hz: int = Field(1_000_000, ge=200_000, le=10_000_000)
    rx_gain_db: float = Field(20, ge=-3, le=70)
    tx_gain_db: float = Field(-50, ge=-89.75, le=0)
    samples_per_symbol: int = Field(8, ge=4, le=32)
    rx_buffer_size: int = Field(32768, ge=4096, le=262144)
    payload_bytes: int = Field(32, ge=8, le=256)
    packets: int = Field(10, ge=1, le=200)
    processes: int = Field(4, ge=1, le=32)
    max_transmissions: int = Field(4, ge=1, le=8)
    algorithm: Literal["stop_wait", "parallel", "chase", "ir"] = "chase"
    ack_timeout_ms: float = Field(700, ge=50, le=5000)
    feedback_delay_ms: float = Field(0, ge=0, le=2000)
    duration_s: float = Field(15, ge=1, le=120)
    snr_db: float = Field(0, ge=-15, le=40)
    seed: int = Field(42, ge=0, le=2**32 - 1)
    allow_tx: bool = False

    @model_validator(mode="after")
    def validate_backend(self):
        if self.backend in ("pluto", "board_udp") and self.action == "link_test":
            raise ValueError(
                "Для Pluto выберите приёмник, передатчик или захват IQ; link_test: только software_iq"
            )
        if self.backend == "software_iq" and self.action != "link_test":
            raise ValueError("software_iq поддерживает только физический тест без оборудования")
        if self.backend != "software_iq" and self.action != "capture" and not self.allow_tx:
            raise ValueError("Разрешите TX: приёмник HARQ тоже передаёт ACK/NACK по радио")
        if self.backend == "pluto" and not self.uri.startswith(("ip:", "usb:", "local:")):
            raise ValueError("IIO URI должен начинаться с ip:, usb: или local:")
        if self.backend == "pluto_pair":
            if self.action != "link_test" or self.uri == self.peer_uri:
                raise ValueError("Стенд из двух Pluto: выберите link_test и два разных URI")
            if any(not uri.startswith(("ip:", "usb:", "local:")) for uri in (self.uri, self.peer_uri)):
                raise ValueError("Оба IIO URI должны начинаться с ip:, usb: или local:")
        if self.backend == "board_udp":
            from ipaddress import IPv4Address

            IPv4Address(self.board_host)
        if self.rx_buffer_size < self.samples_per_symbol * 1100:
            raise ValueError("Буфер RX слишком мал для заголовка и синхронизации")
        if self.backend in ("pluto", "pluto_pair") and self.bandwidth_hz > self.sample_rate:
            raise ValueError("Полоса RX/TX должна быть не больше частоты дискретизации")
        return self


class HardwareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    config: HardwareConfig = Field(default_factory=HardwareConfig)


def capabilities() -> dict:
    import importlib.util
    import platform

    return {
        "pluto_driver_installed": importlib.util.find_spec("adi") is not None,
        "platform": platform.system(),
        "machine": platform.machine(),
        "backends": ["software_iq", "pluto_pair", "pluto", "board_udp"],
        "algorithms": ["stop_wait", "parallel", "chase", "ir"],
        "feedback": "RF frames with protected header; not a simulated ACK in Pluto mode",
        "clock": "host monotonic; no ADC/DAC hardware timestamps in this adapter",
        "fpga": "reference HARQ timeout RTL; custom ADI HDL integration required, no bitstream supplied",
        "lx2160": "portable Linux/aarch64 agent, no DPAA2 acceleration claimed",
        "hardware_verified": False,
    }
