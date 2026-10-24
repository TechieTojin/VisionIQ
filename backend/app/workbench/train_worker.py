"""Training worker process: `python -m app.workbench.train_worker --run-dir DIR`.

Reads ONLY `DIR/config.json` (written and validated by the API) and trains
with Ultralytics on CPU. Progress is written to `DIR/status.json` after each
epoch; Ultralytics itself writes `DIR/train/results.csv` and
`DIR/train/weights/{best,last}.pt`. Nothing here is downloaded: the base
weights and dataset are local files.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path


def write_status(run_dir: Path, **fields) -> None:
    tmp = run_dir / "status.json.tmp"
    tmp.write_text(json.dumps({**fields, "updated_at": time.time()}), encoding="utf-8")
    tmp.replace(run_dir / "status.json")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True)
    args = parser.parse_args(argv)
    run_dir = Path(args.run_dir).resolve()
    config = json.loads((run_dir / "config.json").read_text(encoding="utf-8"))

    write_status(run_dir, epoch=0, epochs=config["epochs"], message="Loading base model…")
    from ultralytics import YOLO

    model = YOLO(config["base_weights"])

    def on_epoch_end(trainer):
        metrics = {k: float(v) for k, v in (getattr(trainer, "metrics", None) or {}).items()
                   if isinstance(v, int | float)}
        write_status(run_dir, epoch=int(trainer.epoch) + 1, epochs=config["epochs"],
                     message=f"Epoch {int(trainer.epoch) + 1}/{config['epochs']}", metrics=metrics)

    model.add_callback("on_fit_epoch_end", on_epoch_end)
    model.train(
        data=config["data"],
        epochs=config["epochs"],
        imgsz=config["imgsz"],
        batch=config["batch"],
        patience=config["patience"],
        seed=config["seed"],
        device="cpu",
        workers=0,
        project=str(run_dir),
        name="train",
        exist_ok=True,
        plots=False,
        amp=False,
        cache=False,
        verbose=False,
    )
    write_status(run_dir, epoch=config["epochs"], epochs=config["epochs"], message="Finished.", done=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
