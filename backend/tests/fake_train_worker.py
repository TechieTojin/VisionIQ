"""Stand-in training worker for tests: same files as the real one, no torch.

Behaviour is chosen by the run's config.json `epochs` value:
  epochs == 13  -> exit with an error (failure path)
  epochs == 77  -> sleep for a long time (cancellation path)
  otherwise     -> write results.csv, status.json and weights, exit 0
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--run-dir", required=True)
    run_dir = Path(p.parse_args().run_dir)
    cfg = json.loads((run_dir / "config.json").read_text())
    assert Path(cfg["data"]).is_file(), "data.yaml must exist"
    if cfg["epochs"] == 13:
        print("simulated failure", file=sys.stderr)
        return 3
    if cfg["epochs"] == 77:
        time.sleep(60)
        return 0
    train = run_dir / "train"
    (train / "weights").mkdir(parents=True, exist_ok=True)
    rows = ["epoch,train/box_loss,metrics/mAP50(B),metrics/mAP50-95(B)"]
    for e in range(cfg["epochs"]):
        rows.append(f"{e + 1},{1.5 - 0.1 * e:.3f},{0.1 * (e + 1):.3f},{0.05 * (e + 1):.3f}")
    (train / "results.csv").write_text("\n".join(rows) + "\n")
    (train / "weights" / "best.pt").write_bytes(b"fake-best")
    (train / "weights" / "last.pt").write_bytes(b"fake-last")
    (run_dir / "status.json").write_text(json.dumps({"epoch": cfg["epochs"], "message": "Finished.", "done": True}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
