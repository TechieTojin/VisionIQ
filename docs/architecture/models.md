# The Computer Vision Model

Source of truth: `backend/app/services/vision/yolo_provider.py`,
`backend/app/schemas/detection.py`, `backend/app/schemas/retail.py`,
`backend/app/services/retail/sku.py`, `backend/requirements-ml.txt`.

---

## 1. What is running

| Property | Value |
|---|---|
| Framework | Ultralytics `8.4.183` (`backend/requirements-ml.txt`) |
| Weights | `yolov8n.pt` — YOLOv8 **nano**, the smallest of the family |
| Task | `object-detection` |
| Taxonomy | **COCO-80** — 80 generic everyday object classes |
| Device | `cpu` by default (`VISIONIQ_DEVICE`) |
| Inference size | letterboxed to 640 px (`VISIONIQ_IMAGE_SIZE`) |
| Confidence floor | 0.25 (`VISIONIQ_CONFIDENCE`) |
| Max detections | 300 (`VISIONIQ_MAX_DETECTIONS`) |

Weights are cached under `VISIONIQ_MODEL_DIR` (default `backend/models/`) and
are never committed. `YoloProvider.warmup()` prefers a file already in that
directory and otherwise lets Ultralytics resolve/download `yolov8n.pt`. In the
container image the weights are **baked in** at build time (see
`backend/Dockerfile`) so scaling out never triggers a download.

Concurrency is deliberately serialised: `yolo_provider.py` holds a module-level
`_INFERENCE_LOCK` around `model.predict`, because concurrent CPU inference on a
small box thrashes or OOMs.

---

## 2. Licensing — AGPL-3.0 (read this before shipping)

Verbatim from the `LICENSING NOTE` at the top of `yolo_provider.py`:

> Ultralytics YOLOv8 and its pretrained weights are distributed under AGPL-3.0.
> Using them in a network-served application means the AGPL's network-use clause
> applies: offering this service publicly obliges you to release your source
> under a compatible licence, or to obtain an Ultralytics Enterprise Licence.
> For commercial/closed deployment, swap this provider for a permissively
> licensed model (e.g. an Apache-2.0 RT-DETR or DETR export) or a SageMaker
> endpoint.

### Why this matters more than a normal GPL dependency

GPL-style obligations are usually triggered by *distribution* — you ship a
binary, you ship the source. The AGPL closes the "SaaS loophole" with its
**network-use clause**: letting users interact with the program **remotely over
a network** is treated like distribution. VisionIQ is exactly that — a hosted
HTTP API that runs YOLOv8 on the user's uploaded image and returns the result.
Nobody downloads anything, and the obligation still attaches.

Concretely, if you run this build publicly with `VISIONIQ_DETECTION_PROVIDER=yolo`:

- You must offer the **complete corresponding source** of the work to its users,
  under AGPL-3.0 or a compatible licence. In practice that is read as covering
  the service that embeds and invokes the model, not just the vendored library.
- "It's only an internal tool" is not automatically safe. Internal-only use with
  no outside users is generally fine; the moment external users, customers or a
  public demo can hit the endpoint, the clause is live.
- Fine-tuning `yolov8n.pt` does **not** launder the licence. The pretrained
  weights are themselves AGPL-3.0, so a derivative trained from them carries the
  same terms.
- Putting it behind API Gateway, a Lambda, or a Fargate container changes
  nothing. The obligation follows the code, not the deployment topology.

### Options for commercial / closed-source use

1. **Buy an Ultralytics Enterprise Licence.** The intended commercial route;
   removes the AGPL obligation for both library and weights. Zero code change.
2. **Swap the model for a permissively licensed detector.** Apache-2.0 /
   BSD-licensed options include RT-DETR and DETR exports, and several
   Apache-2.0 detection checkpoints on Hugging Face. Export to ONNX or
   TorchScript and implement `DetectionProvider` against it.
3. **Move inference behind a managed endpoint** —
   `VISIONIQ_DETECTION_PROVIDER=sagemaker`. Note this is *not* a licensing
   escape hatch on its own: if the endpoint itself serves AGPL YOLO weights, the
   obligation moves with it. It only helps if the endpoint hosts a permissively
   licensed or commercially licensed model.
4. **Train your own retail detector from scratch** on a permissive backbone.
   Also the only path that gets you real SKU capability (§5).
5. **Open-source VisionIQ under AGPL-3.0.** Entirely legitimate, and the
   cheapest option if the source was going public anyway.

Everything below the provider boundary is licence-agnostic by construction: the
schemas, aggregation, persistence and API do not depend on Ultralytics. Swapping
providers is a config change, not a rewrite.

> This is engineering guidance distilled from the licence text, not legal
> advice. Get a lawyer's read before a commercial launch.

---

## 3. What it CAN do

- Detect and localise instances of 80 generic COCO classes — including ones
  that show up on shelves: `bottle`, `cup`, `bowl`, `wine glass`, `banana`,
  `apple`, `orange`, `person`, `backpack`, `handbag`, `book`, `vase`, `clock`.
- Return a per-instance confidence score and an axis-aligned bounding box in
  original-image pixel coordinates.
- Run in roughly a second to a few seconds on CPU for a typical shelf photo,
  with no GPU and no network call.
- Support counting, per-category confidence statistics, a crude occupancy
  estimate, and count deltas between two scans of the same shelf.

## 4. What it CANNOT do

- **It cannot identify retail SKUs.** This is the single most important
  limitation in the product. A COCO model emits `bottle`; it cannot tell a 500 ml
  cola from a 500 ml lemonade, or Brand A's shampoo from Brand B's. From
  `backend/app/services/retail/sku.py`:

  > A COCO-trained model emits categories like `bottle` — it cannot tell a 500ml
  > cola from a 500ml lemonade. Conflating the two would be fabricating inventory
  > data, so the default implementation reports UNSUPPORTED.

- **It cannot read price tags, labels, or barcodes.** No OCR in the pipeline.
- **It cannot detect shelf gaps or empty facings.** That needs a planogram
  reference or a model trained on empty-space annotations.
- **It cannot report stock levels.** Detected-object counts are not inventory.
- **It cannot see packaged goods it was never trained on.** Boxed cereal,
  blister packs, cosmetics, most packaged FMCG have no COCO class at all, and
  will simply not be detected — which looks identical to "shelf is empty" unless
  the caller reads the status and caveats.
- Occluded, stacked, small-in-frame, or low-light items are routinely missed;
  `yolov8n` is the *nano* variant, chosen for CPU speed, not accuracy.

The API surfaces this rather than hiding it. `analysis_service.run_detection()`
unconditionally appends this warning whenever the taxonomy is COCO-80:

```
"Generic COCO-80 model: labels are object categories, not retail SKUs."
```

and `retail/intelligence.py` attaches `GENERIC_TAXONOMY_CAVEAT` to every result:

```
"Labels come from a generic COCO-80 taxonomy, not a retail product catalogue.
 Counts reflect detected objects, not verified stock levels."
```

---

## 5. Bounding box convention

Copied verbatim from the header of `backend/app/schemas/detection.py`:

```
BOUNDING BOX CONVENTION (documented contract, used everywhere):
    Format      : xyxy
    Origin      : top-left of the image, x grows right, y grows down
    Units       : absolute pixels in the ORIGINAL (pre-resize) image space
    Constraints : 0 <= x1 < x2 <= image_width, 0 <= y1 < y2 <= image_height

Providers that infer on a resized copy MUST rescale back to original space
before returning. Normalised 0..1 values are also provided for convenience.
```

`BoundingBox` exposes computed `width`, `height` and `area` (all rounded to 2
decimals; `area` is clamped at 0 for degenerate boxes).

Both providers clamp defensively into `[0, img_w] × [0, img_h]` and **drop**
degenerate boxes where `x2 <= x1` or `y2 <= y1`, rather than emitting a
zero-area detection. Ultralytics already maps boxes back to source-image size;
the clamp is belt-and-braces.

---

## 6. The honesty design

### `InferenceStatus` (`schemas/detection.py`)

> "Outcome of a detection attempt. Never silently fabricate results."

| Value | Meaning | Set when |
|---|---|---|
| `ok` | Model ran and returned at least one detection | normal path |
| `unavailable` | **Provider is not installed/configured in this environment** | `ProviderUnavailable` raised (no torch, 32-bit interpreter, `null` provider, missing SageMaker endpoint, weights failed to load) |
| `empty` | Model ran but produced nothing above the confidence threshold | `detect()` returned `[]` |
| `failed` | Model loaded but inference itself failed | `InferenceFailed` raised |
| `timeout` | Defined in the enum for provider use | not currently assigned by `run_detection()`; an over-budget run is reported as a **warning** on an otherwise `ok` result |

### Why `unavailable` is not "the shelf is empty"

Both states produce `detection_count: 0`. They mean opposite things, so the code
separates them explicitly. `build_intelligence()` emits, for `unavailable`:

> "No detection model ran for this image; all counts are zero because nothing
> was analysed, not because the shelf is empty."

and for `empty`:

> "The model found no objects above the 25% confidence threshold. Lowering the
> threshold may surface more."

`RuleBasedInsights` short-circuits on `unavailable` to a summary that says no
observations can be made, with the suggested action *"Enable a detection
provider to analyse shelf contents."* — it does not narrate a zero count as a
finding. `BedrockInsights` also short-circuits on `unavailable` to the rule
provider, so no money is spent narrating nothing.

### Why shelf gaps and SKU matching report `unsupported`

`Reliability` has three values — `measured` (counted directly from detections),
`estimated` (heuristic, indicative only), `unsupported` (**capability does not
exist yet**). Nothing is allowed to be silently promoted.

- `ShelfGapAssessment` defaults to `reliability: unsupported`, `regions: []`,
  with the reason *"Shelf-gap detection requires a planogram reference or a
  model trained on empty-space annotations. Not enabled in this build."*
  `assess_shelf_gaps()` is a one-liner that returns that default — gaps are
  **not** inferred from object absence, because absence of detection is
  indistinguishable from absence of a trained class.
- `SkuAssessment` defaults to `status: unsupported`, `matched_skus: []`, reason
  *"The active model uses a generic COCO-80 taxonomy and cannot identify
  individual retail SKUs. A retail fine-tuned model is required."*
  `UnsupportedSkuMatcher` is the registered default.
- `OccupancyEstimate` is `estimated` when there are ≥ 3 detections, and
  `unsupported` below that ("Too few detections to estimate occupancy"). The
  note states the method and its bias: box areas are summed **without**
  de-duplicating overlap, so it over-reads on dense shelves and is capped at 1.0.

This is the whole product philosophy in one line: a missing capability is
reported as missing, never approximated into something that looks like data.

---

## 6a. Measured latency on this machine

Real measurements from a local run, CPU only, Windows, `backend/.venv`
(Python 3.10 64-bit, torch CPU wheels):

| Scenario | Measured |
|---|---|
| **First load (cold)** — process start → first result, **including downloading `yolov8n.pt`** | **~18 s** |
| **Warm CPU inference** — 810×1080 shelf image, model already loaded | **~7.5 s**, yielding **6 detections** |

Implications:

- The warm figure is well inside the default `VISIONIQ_INFERENCE_TIMEOUT` of
  60 s, so no over-budget warning is emitted, but it is far too slow to be
  pleasant as a synchronous browser request on this hardware — which is exactly
  why the cloud path is asynchronous (presign → job → poll) instead of a blocking
  POST.
- The ~10 s gap between cold and warm is weight download plus torch import. The
  worker calls `get_provider(settings).warmup()` **before** entering the SQS
  receive loop so no real job ever pays it, and the Dockerfile bakes the weights
  into the image so it is not even a network cost at scale-out.
- These numbers are specific to this machine and this image. Treat them as an
  order-of-magnitude guide, not a benchmark.

Reproduce with:

```powershell
cd backend
.venv\Scripts\python.exe scripts\smoke_inference.py path\to\shelf.jpg
```

The script prints `inference status`, `detections`, `inference time` and
`total pipeline` in ms, plus the first 10 boxes.

---

## 7. Plugging in a better model

### A retail fine-tuned YOLO / any local checkpoint

No code change if the checkpoint is Ultralytics-compatible:

```powershell
$env:VISIONIQ_MODEL_ID  = "retail_shelf_v1.pt"
$env:VISIONIQ_MODEL_DIR = "C:\models"       # file must be at C:\models\retail_shelf_v1.pt
```

`YoloProvider.warmup()` prefers `{model_dir}/{model_id}` when it exists.
`ModelInfo.taxonomy` is hardcoded to `"COCO-80"` in `YoloProvider.model_info`,
so a custom-taxonomy checkpoint should get its own provider class (or a patched
`model_info`) — otherwise the result will carry a COCO caveat that no longer
applies, and comparisons against COCO scans will be wrongly flagged comparable.

### A SageMaker endpoint

```powershell
$env:VISIONIQ_DETECTION_PROVIDER = "sagemaker"
$env:VISIONIQ_SAGEMAKER_ENDPOINT = "visioniq-retail-detector"
$env:AWS_REGION                  = "us-east-1"
```

The endpoint receives raw image bytes (`application/octet-stream`) and must
return exactly:

```json
{"detections": [
  {"label": "bottle", "class_id": 39, "confidence": 0.91,
   "box": [120.0, 340.5, 198.2, 512.0]}
]}
```

`box` is `[x1, y1, x2, y2]` in **absolute pixels of the original image**. The
provider validates strictly — a missing `detections` list raises
`InferenceFailed("...refusing to guess")`, and a malformed entry raises rather
than being coerced into a plausible detection. `model_info.taxonomy` becomes
`"endpoint-defined"`, which also suppresses the COCO-80 warning.

### A real SKU matcher

Implement the `SkuMatcher` Protocol (`app/services/retail/sku.py`) against a
product-embedding index or a retail fine-tuned detector, and register it:

```python
from app.services.retail.sku import set_sku_matcher
set_sku_matcher(MyCatalogueMatcher(index_path=...))
```

`match(detections, image_bytes) -> SkuAssessment`. Return
`status: matched` with populated `matched_skus` only once the matcher has been
evaluated — the comment on `set_sku_matcher` says exactly that: *"Register a
real matcher once one exists and has been evaluated."*

### A real shelf-gap detector

Replace `assess_shelf_gaps()` in `app/services/retail/intelligence.py` and
return `Reliability.MEASURED` (or `ESTIMATED`) with populated `regions`. Until
an evaluated algorithm exists, leaving it `unsupported` is the correct answer.
