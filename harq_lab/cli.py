import argparse
import json
from pathlib import Path

from .config import ALGORITHMS, SimulationConfig
from .experiments import ExperimentRequest, run_experiment
from .reporting import save_artifacts
from .simulator import simulate


def main():
    parser = argparse.ArgumentParser(description="HARQ Lab: delay-aware retransmission research")
    sub = parser.add_subparsers(dest="command", required=True)
    server = sub.add_parser("serve", help="Start loopback API and browser UI")
    server.add_argument("--port", type=int, default=8765)
    run = sub.add_parser("simulate", help="One reproducible simulation")
    run.add_argument("--config", type=Path)
    run.add_argument("--algorithm", choices=ALGORITHMS, default="adaptive")
    run.add_argument("--output", type=Path, default=Path("results/simulation.json"))
    experiment = sub.add_parser("experiment", help="Run a JSON experiment and export figures")
    experiment.add_argument("config", type=Path)
    experiment.add_argument("--output", type=Path, default=Path("results/experiment"))
    phy = sub.add_parser("phy", help="Real CRC/convolutional/BPSK/Viterbi cross-check")
    phy.add_argument("--snr", type=float, default=-1)
    phy.add_argument("--blocks", type=int, default=100)
    phy.add_argument("--seed", type=int, default=42)
    phy.add_argument("--output", type=Path, default=Path("results/phy.json"))
    hardware = sub.add_parser("hardware", help="Physical IQ or Pluto HARQ; requires a hardware JSON config")
    hardware.add_argument("config", type=Path)
    hardware.add_argument("--output", type=Path, default=Path("results/hardware.json"))
    agent = sub.add_parser("device-agent", help="Authenticated Linux/aarch64 hardware agent (loopback)")
    agent.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    if args.command == "serve":
        import uvicorn

        uvicorn.run(
            "harq_lab.api:create_app", factory=True, host="127.0.0.1", port=args.port, log_level="warning"
        )
    elif args.command == "device-agent":
        import uvicorn

        uvicorn.run("harq_lab.hardware.service:create_agent", factory=True, host="127.0.0.1", port=args.port)
    elif args.command == "hardware":
        from .hardware.config import HardwareConfig
        from .hardware.engine import run_hardware

        c = HardwareConfig.model_validate_json(args.config.read_text())
        result = run_hardware(c)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(result["metrics"], ensure_ascii=False, indent=2))
        print(f"Saved: {args.output}")
    elif args.command == "simulate":
        config = (
            SimulationConfig.model_validate_json(args.config.read_text())
            if args.config
            else SimulationConfig()
        )
        result = simulate(config, args.algorithm)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(result["metrics"], ensure_ascii=False, indent=2))
        print(f"Saved: {args.output}")
    elif args.command == "phy":
        from .phy import phy_experiment

        result = phy_experiment(snr_db=args.snr, blocks=args.blocks, seed=args.seed)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps(result, indent=2))
    else:
        request = ExperimentRequest.model_validate_json(args.config.read_text())
        result = run_experiment(request, lambda p, message: print(f"{p:6.1%} {message}"))
        save_artifacts(result, args.output)
        print(f"Saved JSON, CSV, Markdown, PNG, SVG: {args.output}")


if __name__ == "__main__":
    main()
