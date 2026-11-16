#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
for experiment in geo_comparison rtt_sweep snr_sweep process_sweep retry_sweep correlated_fading ideal_validation memory_sweep; do
  uv run harq-lab experiment "configs/$experiment.json" --output "results/$experiment"
done
uv run harq-lab phy --snr -1 --blocks 100 --output results/phy-validation.json
