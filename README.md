<div align="center">

# VisionIQ

### Cloud-Native AI-Powered Retail Shelf Intelligence

**VisionIQ turns shelf photographs into reviewable, evidence-backed detection analytics.**
It runs real YOLO object detection, keeps every scan for comparison and trend analysis, and wraps the
model in a full ML-engineering workbench: human annotation, versioned datasets, evaluation, benchmarking,
drift monitoring and a guarded training workflow. It is honest about the limits of its model by design.

[![Backend CI](https://github.com/TechieTojin/VisionIQ/actions/workflows/backend-ci.yml/badge.svg)](https://github.com/TechieTojin/VisionIQ/actions/workflows/backend-ci.yml)
[![Frontend CI](https://github.com/TechieTojin/VisionIQ/actions/workflows/frontend-ci.yml/badge.svg)](https://github.com/TechieTojin/VisionIQ/actions/workflows/frontend-ci.yml)
[![Infrastructure CI](https://github.com/TechieTojin/VisionIQ/actions/workflows/infra-ci.yml/badge.svg)](https://github.com/TechieTojin/VisionIQ/actions/workflows/infra-ci.yml)
<br/>
![Python](https://img.shields.io/badge/Python-3.10%20x64-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.159-009688?logo=fastapi&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![YOLOv8](https://img.shields.io/badge/Ultralytics-YOLOv8n%20(CPU)-111F68)
![Terraform](https://img.shields.io/badge/Terraform-validated%2C%20not%20applied-7B42BC?logo=terraform&logoColor=white)
![Status](https://img.shields.io/badge/status-runs%20locally%20%C2%B7%20not%20deployed-lightgrey)

[Overview](#-project-overview) ·
[Screenshots](#-screenshots) ·
[Features](#-key-features) ·
[Architecture](#-architecture) ·
[Quick start](#-local-installation) ·
[API](#-api) ·
[Testing](#-testing-and-quality-assurance) ·
[Limitations](#-known-limitations) ·
[Roadmap](#-roadmap)

<br/>

<img src="docs/screenshots/01-command-center.webp" alt="VisionIQ Retail Command Center showing scan KPIs, detections over time, detected categories and inspection alerts" width="100%"/>

<sub>The Retail Command Center, captured from the running application. Every figure is computed from stored scans.</sub>

</div>

---

## 📌 Project overview

### The problem

Retail teams photograph shelves constantly: for audits, merchandising checks and store visits. Turning
those photos into something measurable is hard:

- **Shelves are visually dense.** Many near-identical objects overlap, occlude each other and sit at different depths.
- **Capture conditions vary wildly.** Low light, glare, blur and odd angles silently degrade any model.
- **Product identity is a different problem from object detection.** Telling *a bottle* from *this brand's 500 ml bottle* needs a retail-trained model or a product-embedding index.
- **Model scores invite over-interpretation.** A confidence score is not a probability, and a detection count is not a stock count.

### What VisionIQ does

VisionIQ is a full-stack platform that takes a shelf photo through the following steps:

1. **Validates** it by decoding the real pixels, not by trusting the file extension.
2. **Detects** objects with a local CPU YOLOv8n model.
3. **Derives** analytics: category mix, confidence profile, spatial heatmap, shelf-zone breakdown and image-quality diagnostics.
4. **Persists** the scan so it can be compared, trended, alerted on, reported and reviewed later.

Around that pipeline sits an **ML-engineering workbench**. In it you can do the following:

- Correct the model's boxes by hand.
- Freeze reviewed images into versioned datasets.
- Score models against those human labels.
- Benchmark configurations.
- Watch for distribution drift.
- Prepare a retail-specific fine-tuning run, which never starts without explicit confirmation.

### What it can and cannot tell you

> [!IMPORTANT]
> The default model is a **generic COCO-80 detector**. It recognises object classes such as `bottle`,
> `cup` or `person`, **not products**. VisionIQ therefore reports **model detections, never inventory**:
>
> - SKU identity is reported as `unsupported`.
> - Shelf gaps are never inferred from missing boxes.
> - Occupancy is labelled `estimated`.
> - "No model available" is a different state from "the shelf is empty".
>
> Every screen, alert, answer and PDF uses this vocabulary.

### What it demonstrates

| Area | How it shows up |
|---|---|
| Full-stack engineering | Typed FastAPI backend plus a React 19 / TypeScript SPA, with one analytics module shared by every screen and the PDF |
| Computer vision | Real YOLO inference, box-normalisation conventions, confidence analysis, a spatial density heatmap and an image-quality inspector |
| MLOps lifecycle | Annotation with provenance, immutable dataset versions, leakage-safe splits, COCO-style evaluation, benchmarking, drift statistics and training orchestration |
| Cloud architecture | A modular AWS design (S3, SQS, ECS Fargate, DynamoDB, Cognito, API Gateway, Lambda, CloudFront) as Terraform, with contract tests across the Lambda/backend seam |
| Responsible AI | Explicit `unsupported` / `estimated` / `insufficient` states instead of plausible-looking numbers |

---

## 🖼 Screenshots

All screenshots were captured from the **real running application**, at a 1440×900 viewport, against a
local backend performing real YOLOv8n inference.

- **Source images.** The images analysed are the public Ultralytics `bus.jpg` sample, variants of it derived for testing (low light, blur, low contrast and so on), and the project's synthetic shelf image.
- **Annotations.** The review edits were made for the demonstration, so the evaluation numbers shown illustrate the workflow and are **not** a model-accuracy claim.

| Analyse a scan: boxes, categories and confidence | Before / after comparison |
|---|---|
| <img src="docs/screenshots/02-analyze-detections.webp" alt="Scan view with bounding boxes and detection list"/> | <img src="docs/screenshots/07-compare.webp" alt="Before/after comparison of two scans"/> |
| **Detection heatmap overlay** | **Confidence filter at 50% (inference is not re-run)** |
| <img src="docs/screenshots/05-heatmap.webp" alt="Detected-object concentration heatmap"/> | <img src="docs/screenshots/03-confidence-filter.webp" alt="Confidence threshold raised to 50 percent"/> |
| **Ask VisionIQ: computed answers, declined questions** | **Annotation Studio with provenance tracking** |
| <img src="docs/screenshots/09-ask-visioniq.webp" alt="Ask VisionIQ answering and declining questions"/> | <img src="docs/screenshots/13-annotation-studio.webp" alt="Annotation Studio editor"/> |
| **Evaluation Center (workflow demo labels)** | **Drift Monitor, reporting insufficient data honestly** |
| <img src="docs/screenshots/15-evaluation.webp" alt="Evaluation results with mAP, per-class metrics and confusion matrix"/> | <img src="docs/screenshots/17-drift-monitor.webp" alt="Drift monitor showing insufficient-sample states"/> |

<details>
<summary><b>More screenshots</b>: timeline, batch, alerts, quality, datasets, benchmark, training, zones, reports, PDF</summary>

<br/>

| Scan Timeline | Batch processing |
|---|---|
| <img src="docs/screenshots/08-timeline.webp" alt="Scan timeline"/> | <img src="docs/screenshots/10-batch.webp" alt="Batch processing queue"/> |
| **Smart Inspection Alerts** | **Image Quality Inspector** |
| <img src="docs/screenshots/11-smart-alerts.webp" alt="Smart alerts"/> | <img src="docs/screenshots/12-image-quality.webp" alt="Image quality inspector"/> |
| **Dataset Manager** | **Model Benchmark Lab** |
| <img src="docs/screenshots/14-datasets.webp" alt="Dataset manager"/> | <img src="docs/screenshots/16-benchmark-lab.webp" alt="Benchmark run"/> |
| **Training workflow: validated plan, nothing started** | **Shelf zones overlay** |
| <img src="docs/screenshots/18-training.webp" alt="Training workflow"/> | <img src="docs/screenshots/06-shelf-zones.webp" alt="Shelf zones overlay"/> |
| **Inspection reports** | **Generated PDF (page 1)** |
| <img src="docs/screenshots/19-reports.webp" alt="Reports page"/> | <img src="docs/screenshots/20-pdf-report.webp" alt="First page of a generated PDF inspection report" width="70%"/> |

<p align="center"><img src="docs/screenshots/04-confidence-explorer.webp" alt="Confidence explorer panel" width="55%"/><br/><sub>Confidence Explorer panel</sub></p>

The Benchmark Lab timings were measured on a low-memory CPU laptop under load. They are real
measurements for that machine, not representative performance figures.

</details>

---

## ✨ Key features

The 18 features are grouped as they appear in the application's navigation. Unless stated otherwise,
every number on screen is derived from stored scan records by one shared analytics module
(`frontend/src/lib/analytics.ts`), so the dashboard, timeline, comparison and PDF can never disagree.

### Retail Intelligence

| # | Feature | What it actually does | Data source |
|---|---|---|---|
| 1 | **AI Retail Command Center** | KPIs for any time range: scans, successful analyses, model detections, mean confidence, scans to review, failed or model-less scans and open alerts. Also a detections-over-time chart, category mix and inspection alerts. | Scan history (`/api/analyses`), alert summary |
| 2 | **Interactive Confidence Explorer** | A live threshold slider over the model's *existing* detections: boxes, counts, histogram and per-category averages update instantly. It cannot recover objects below the inference floor, and says so. | The scan's stored detections |
| 3 | **Before / After Comparison** | Two scans side by side or as a wipe, with a common threshold, detection and confidence deltas, and per-category changes. Changes are labelled "model detections, not verified stock movement". | `/api/analyses/{a}/compare/{b}` plus both records |
| 4 | **Shelf Detection Heatmap** | A deterministic kernel-density map of *where boxes were detected* (one Gaussian per box, sized to the box), with adjustable opacity. Explicitly not customer attention or sales activity. | Detection boxes, in original-image pixels |
| 5 | **Model Diagnostics** | Confidence histogram, box-size distribution, area share, a sortable detection table, model and runtime details, and low-confidence flags. | Detection records plus model metadata |
| 6 | **Shelf Zone Analytics** | Default top / middle / bottom zones or custom rectangles. Each detection counts in exactly one zone: the first zone containing its box centre. | Detections plus zones stored as image fractions |
| 7 | **Scan Timeline** | Every scan, newest first, grouped by day in the viewer's timezone, with range, date, category, outcome and text filters. Filters can be pre-set from the URL. | Scan history |
| 8 | **PDF Inspection Reports** | Single-scan or comparison reports built **in the browser** with a small hand-written PDF 1.4 writer (no `eval`, no heavy dependency). They include the annotated image, summaries, zones, warnings and disclaimers. | The same analytics functions as the UI |
| 9 | **Ask VisionIQ** | Natural-language questions over your scans, answered by a **deterministic rule-based engine, not an LLM**. Answers are computed and link to their evidence. Questions about stock, sales or SKUs are declined with the reason. | Stored scans, via the shared analytics module |
| 10 | **Batch Image Processing** | Up to 50 images (10 MB each), validated before upload and processed **one at a time** to protect memory. Supports cancelling queued items, retrying failures, CSV export (protected against formula injection) and saved batch history. | `/api/images/detect`, `/api/saved/batch` |
| 11 | **Smart Inspection Alerts** | User-defined rules: scan status, low confidence, category count, count change, zone count, image quality and drift. Evaluation is idempotent, and alerts can be acknowledged or resolved with notes. Wording describes what the model *observed*. | Alert rules evaluated against scans |
| 12 | **Image Quality Inspector** | Fixed-formula checks for sharpness (Laplacian variance), brightness, contrast, clipping and resolution, explained in plain language. Warnings never block analysis. | Image pixels, computed on the backend |

### Computer Vision & ML Engineering

| # | Feature | What it actually does | Data source |
|---|---|---|---|
| 13 | **Annotation Studio** | Move, resize, draw, relabel and delete boxes with mouse or keyboard, with undo / redo and YOLO-format export. Provenance (`model`, `edited`, `human`) is computed by the server. Saves use optimistic concurrency, so a stale tab gets a conflict instead of overwriting newer work. Model predictions are never modified. | Annotation documents, kept separate from predictions |
| 14 | **Dataset Manager** | Named image collections frozen into **immutable versions** with a seeded train / val / test split. Exact-duplicate images can never straddle splits. Each version gets a readiness check, a YOLO zip export and content-addressed blob storage. | Owned scans plus reviewed annotations |
| 15 | **Model Benchmark Lab** | Measures load time, first inference and warm latency statistics per configuration, alongside output counts. One weights file at different settings is labelled a *configuration* comparison, not a model comparison. | Real wall-clock measurements on this machine |
| 16 | **Model Evaluation Center** | COCO-style 101-point AP, mAP@0.5 and mAP@0.5:0.95, precision / recall / F1, a confusion matrix and a mistake viewer. Refuses **circular** labels and flags **biased** ones. | Frozen dataset versions, human-reviewed boxes only |
| 17 | **Model Drift Monitoring** | Compares two time windows with PSI and Jensen–Shannon distance on the category mix, and Kolmogorov–Smirnov tests on confidence, detections per scan and image quality. Enforces minimum sample sizes and checks model compatibility. | Real scans in each window |
| 18 | **Retail-Specific Training Workflow** | Experiment management around Ultralytics: readiness check, resource estimate, two explicit confirmations, a separate low-priority worker process, real cancellation, per-epoch metrics and explicit registration. **No retail model has been trained yet.** | Dataset versions plus local base weights |

> [!NOTE]
> Features 11–18 are **local-only**. They use the FastAPI backend's SQLite workbench store and have no
> Lambda equivalent. In cloud or demo mode the frontend marks those pages as unavailable rather than
> pretending they work.

---

## 🏗 Architecture

```mermaid
flowchart LR
  subgraph Browser["Browser: React 19 + TypeScript SPA"]
    UI["Pages: Command Center, Analyze, Compare,<br/>Timeline, Ask, Batch, Workbench"]
    AN["lib/analytics<br/>shared derived metrics"]
    PDF["lib/pdf<br/>in-browser PDF writer"]
    UI --- AN
    AN --- PDF
  end

  subgraph Local["Runs locally (implemented and tested)"]
    API["FastAPI<br/>routes: images, analyses, workbench"]
    SVC["analysis_service.analyse()<br/>validate, detect, aggregate, insights"]
    YOLO["YOLOv8n<br/>Ultralytics, CPU"]
    DB[("SQLite<br/>scan history")]
    FS[("Local image storage<br/>uploads/{owner}/{id}.ext")]
    WB[("Workbench store, SQLite<br/>annotations, datasets, alerts, runs")]
    JOBS["Single-slot job runner<br/>benchmark, evaluation"]
    TRAIN["Training worker<br/>separate low-priority process"]
    API --> SVC --> YOLO
    SVC --> DB
    SVC --> FS
    API --> WB
    API --> JOBS --> YOLO
    JOBS --> TRAIN
  end

  subgraph Cloud["AWS: Terraform only, NOT deployed"]
    CF["CloudFront + S3<br/>SPA delivery"]
    COG["Cognito<br/>code flow + PKCE"]
    APIGW["API Gateway<br/>JWT authorizer"]
    LAMBDA["Lambda<br/>presign, jobs CRUD"]
    S3[("S3 uploads")]
    SQS[["SQS + DLQ"]]
    ECS["ECS Fargate worker<br/>same analyse()"]
    DDB[("DynamoDB")]
    APIGW --> LAMBDA --> SQS --> ECS
    LAMBDA --> DDB
    ECS --> S3
    ECS --> DDB
  end

  UI -- "/api via Vite proxy" --> API
  UI -. "cloud mode (code only)" .-> APIGW
  UI -. "sign-in (code only)" .-> COG
```

**Three transports, one contract.** The frontend's `AnalysisClient` has three implementations:

- **Local:** one synchronous `POST /api/images/detect`.
- **Cloud:** presign, then an S3 PUT, then create a job, then poll.
- **Demo:** replays recorded results from a static fixture.

All three render the same `AnalysisRecord`. The local and cloud paths call the same
`analysis_service.analyse()`, so results are identical.

**Pluggable by configuration, not code.** Each concern is a `Protocol` with an environment-selected factory:

| Concern | Implementations | Selected by |
|---|---|---|
| Detection | `yolo`, `sagemaker`, `null` | `VISIONIQ_DETECTION_PROVIDER` |
| Scan persistence | `sqlite`, `dynamodb` | `VISIONIQ_REPOSITORY` |
| Image storage | `local`, `s3` | `VISIONIQ_STORAGE` |
| Insights | `rules` (default), `bedrock` (opt-in) | `VISIONIQ_INSIGHTS_PROVIDER` |
| Authentication | `none`, `apigateway`, `jwt` | `VISIONIQ_AUTH_MODE` |

More detail: [`docs/architecture/overview.md`](docs/architecture/overview.md).

---

## 🔬 AI inference pipeline

```mermaid
sequenceDiagram
  autonumber
  participant U as Browser
  participant A as FastAPI /api/images/detect
  participant V as Validator
  participant M as YOLOv8n (CPU)
  participant R as Retail aggregation
  participant S as SQLite + image storage
  U->>A: multipart upload (JPEG, PNG or WebP, at most 10 MB)
  A->>V: decode the real pixels
  V-->>A: metadata, or 400 invalid_image
  A->>M: inference at the configured threshold
  M-->>A: boxes (xyxy, absolute original-image pixels)
  A->>R: categories, confidence stats, occupancy (estimated)
  R-->>A: retail block (SKU unsupported, gaps unsupported)
  A->>S: persist record and image under uploads/{owner}/{id}.ext
  A-->>U: full AnalysisRecord
  Note over U: client-side: threshold filtering, heatmap,<br/>zones, diagnostics, PDF export
```

1. **Upload.** Via the Analyze page or Batch queue, as JPEG, PNG or WebP up to 10 MB.
2. **Input validation.** The image is fully decoded with Pillow. Truncated or disguised files are rejected with `400 invalid_image`.
3. **YOLO inference.** Ultralytics YOLOv8n on CPU, at the configured confidence floor (default 25%).
4. **Detection normalisation.** Boxes are `xyxy` with a top-left origin, in **absolute pixels of the original image**, with `0 ≤ x1 < x2 ≤ width`. Providers that resize must scale back.
5. **Confidence filtering.** The stored record keeps everything above the floor; the UI filters live above it without re-running inference.
6. **Annotated visualisation.** Boxes render in an SVG whose `viewBox` is the original image size, so overlays stay pixel-aligned at any screen size.
7. **Analytics and persistence.** Category counts, confidence statistics and an occupancy *estimate* are computed. The record is stored in SQLite and the image in owner-scoped storage, and quality is inspected after analysis.
8. **Inspection reporting.** PDFs are generated in the browser from the same analytics functions.

**COCO limitations.** A generic detector sees `bottle`, not *a brand*. It misses heavily occluded items,
can double-count overlapping ones, and is uncertain on dense, repetitive shelves. That is why VisionIQ
never turns counts into stock levels, and why the workbench exists: to build the labelled data a
retail-specific model would need.

---

## 🔁 ML engineering workflow

```mermaid
flowchart LR
  A["Image collection<br/>stored scans"] --> B["Human annotation<br/>Annotation Studio"]
  B -->|"status = reviewed"| C["Dataset versioning<br/>immutable snapshot"]
  C --> D["Train / val / test split<br/>seeded, grouped by image hash"]
  D --> E["Evaluation<br/>reviewed labels only"]
  D -->|"explicit confirmation"| F["Optional training<br/>separate process"]
  F -->|"explicit registration"| G["Benchmarking<br/>latency and outputs"]
  E --> G
  G --> H["Monitoring<br/>drift and alerts"]
  H -.->|"new scans"| A
```

**Safeguards that keep unreviewed predictions from becoming ground truth:**

- **Predictions are immutable.** An annotation starts as a *copy* of selected predictions. The scan's own detections are never modified.
- **The server computes provenance.** `model`, `edited` and `human` are worked out on the server by comparing against the stored prediction, not trusted from the client.
- **Only `reviewed` counts.** An image without a reviewed annotation is recorded in a dataset version as `excluded`.
- **Circular evaluation is refused.** If the evaluated model produced the pre-annotations and the reviewer accepted every one unchanged, the run will not start. A mostly-unedited label set runs but is flagged as **biased**.
- **No leakage.** Exact-duplicate images are grouped by hash, so they always land in the same split.
- **Versions are frozen.** Later edits create a new version. Earlier versions, and any evaluation that used them, stay reproducible.
- **Training is opt-in and isolated.** It requires a ready dataset, `confirm` **and** `acknowledge_resources`. It runs in a separate process at below-normal priority, with a fixed argument list and no shell. Only one heavy job runs at a time (a second one gets `409 busy`).
- **Trained is not deployed.** A finished run must be registered explicitly, and it never replaces the production detector.

---

## 🧰 Technology stack

| Layer | Technology | Purpose |
|---|---|---|
| Frontend | React 19, TypeScript (strict), Vite 8 | SPA with a dependency-free hash router and hand-written CSS (no UI framework) |
| Charts and PDF | Hand-written SVG charts and PDF 1.4 writer | No `eval` and no heavy runtime dependencies, so the strict CSP holds |
| Backend API | FastAPI 0.159, Pydantic v2, Uvicorn | Typed endpoints; response models are the canonical API contract |
| Inference | Ultralytics 8.4 (YOLOv8n), PyTorch CPU | Local object detection, benchmarking, evaluation and training worker |
| Imaging | Pillow | Decode validation and image-quality metrics |
| Persistence | SQLite (local), DynamoDB adapter (cloud) | Scan history behind one repository `Protocol` |
| Workbench store | SQLite JSON document store | Owner-scoped annotations, datasets, alerts and runs, with revision-based concurrency |
| Storage | Local filesystem, S3 adapter | Owner-prefixed image keys; presigned PUT in cloud mode |
| Auth | PyJWT[crypto] (RS256 / JWKS), Cognito code flow + PKCE | Verified `sub` is the only tenant key; the SPA keeps tokens in memory only |
| Cloud SDK | boto3 | S3, SQS and DynamoDB adapters (optional at runtime) |
| Testing | pytest, httpx, Vitest, Testing Library, jsdom | Backend and frontend suites; inference is always mocked in tests |
| Quality | Ruff, ESLint, `tsc --noEmit` | Linting and type checking (`py310` target enforced) |
| Infrastructure as code | Terraform (AWS provider ~> 5.0), 11 modules | Network, storage, database, queue, worker, API, auth, frontend, security, observability, budget |
| CI | GitHub Actions | Backend (Python 3.10 and 3.11), frontend, Terraform validate, worker image build and scan (no push); deploy is manual-only |

---

## 💻 Local installation

### Prerequisites

- **Windows, macOS or Linux.** The commands below are Windows-friendly.
- **64-bit Python 3.10 or 3.11.** 64-bit is mandatory: PyTorch and `cryptography` publish no 32-bit Windows wheels.
- **Node.js 20.19+ or 22.12+** with npm (Vite 8's requirement). Development used Node 24.
- **About 2 GB of free disk space** for CPU PyTorch.
- **No AWS account** and no credentials of any kind.

### 1. Clone

```bash
git clone https://github.com/TechieTojin/VisionIQ.git
cd VisionIQ
```

### 2. Backend environment

```bash
cd backend
py -3.10 -m venv .venv          # or: python3.10 -m venv .venv
.venv\Scripts\activate          # macOS/Linux: source .venv/bin/activate

# CPU-only PyTorch first, to avoid pulling ~2 GB of CUDA libraries
python -m pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision
python -m pip install -r requirements-dev.txt -r requirements-ml.txt
```

`requirements.txt` alone runs the API and the whole test suite without inference.
`requirements-ml.txt` adds Ultralytics.

### 3. Frontend dependencies

```bash
cd frontend
npm install
cp .env.example .env.local      # optional; the defaults are VITE_API_MODE=local, VITE_AUTH_MODE=local
```

### 4. Environment variables

No configuration is required for local use. The defaults are:

| Variable | Default | Meaning |
|---|---|---|
| `VISIONIQ_AUTH_MODE` | `none` | Single local tenant `local`; use `jwt` to verify real tokens |
| `VISIONIQ_DETECTION_PROVIDER` | `yolo` | Use `null` to run with no model (reported as `unavailable`, never "empty") |
| `VISIONIQ_SQLITE_PATH` | `backend/data/visioniq.db` | Scan history |
| `VISIONIQ_STORAGE_DIR` | `backend/data/images` | Uploaded images |
| `VISIONIQ_WORKBENCH_DB` / `VISIONIQ_WORKBENCH_DIR` | `backend/data/…` | Workbench store and dataset blobs |

The full reference is in [`docs/deployment/local.md`](docs/deployment/local.md). All of `backend/data/` is git-ignored.

### 5. Start the backend

```bash
cd backend
.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8080
```

The YOLOv8n weights (about 6 MB) are fetched by Ultralytics on first use if `backend/models/yolov8n.pt`
is not already present.

### 6. Start the frontend

```bash
cd frontend
npm run dev
```

### 7. Open it

| URL | What |
|---|---|
| <http://localhost:5175> | The VisionIQ app (Vite proxies `/api` to `127.0.0.1:8080`) |
| <http://127.0.0.1:8080/docs> | Interactive OpenAPI documentation |
| <http://127.0.0.1:8080/health> | Health check |

---

## ▶️ Running locally

- **Local mode** (`VITE_API_MODE=local`). The browser calls `/api/...` on the same origin and Vite proxies it to FastAPI. Analysis is synchronous: one request returns the finished record.
- **Authentication.** By default it is off on both sides (`VISIONIQ_AUTH_MODE=none`, `VITE_AUTH_MODE=local`), and every record belongs to the pseudo-tenant `local`. To exercise real verification, set `VISIONIQ_AUTH_MODE=jwt` with `VISIONIQ_JWT_ISSUER` and `VISIONIQ_JWT_AUDIENCE`, and the frontend to `VITE_AUTH_MODE=cognito`. A *production* frontend build refuses `VITE_AUTH_MODE=local` and renders a configuration error, on purpose.
- **Storage.** Scans go to SQLite, images to `backend/data/images/uploads/local/`, and workbench state to `backend/data/workbench.db`.
- **Real inference.** YOLOv8n runs on CPU. On a modest laptop expect a few seconds per image warm, and longer on the first call while the model loads.

### First run in two minutes

1. Open **Analyze** and drop in a photo, for example Ultralytics' `bus.jpg` from `backend/.venv/Lib/site-packages/ultralytics/assets/`.
2. Inspect the boxes. Toggle **All labels**, **Heatmap** and **Zones**, and drag the **Confidence explorer** slider.
3. Analyse a second photo, then open **Compare**, or **Timeline** to see both.
4. Click **Export PDF** on a scan, or use **Reports**, to download an inspection report.
5. Optionally open **Annotation Studio**, correct a few boxes, mark the scan *Reviewed*, and add it to a dataset in **Datasets**.

To check real inference from the command line:

```bash
cd backend
.venv\Scripts\python.exe scripts\smoke_inference.py path\to\image.jpg
```

---

## 🎬 Demo mode

`VITE_API_MODE=demo` builds a **static, backend-free** version of the frontend:

```bash
cd frontend
VITE_API_MODE=demo npm run build && npm run preview     # PowerShell: $env:VITE_API_MODE='demo'; npm run build
```

- **Recorded from real model runs.** Every box, label and confidence in the demo was produced by an actual YOLOv8n run and captured verbatim by [`backend/scripts/generate_demo_fixtures.py`](backend/scripts/generate_demo_fixtures.py). One sample genuinely produced **zero detections** and is kept that way.
- **No live inference.** There is no model and no API. `DemoAnalysisClient.analyze()` throws rather than return a canned result for a user's file, and the upload control is replaced by a sample picker.
- **Limited scope.** New images cannot be analysed, singly or in a batch: the demo client refuses with an explicit message. Every local-only workbench page (alerts, quality, annotation, datasets, benchmark, evaluation, drift, training) shows a local-only notice instead.
- **Not a replacement** for running the full local backend.

The repository includes `vercel.json` for a static deployment of this build. The application is
**not currently deployed**: there is no public URL. See [`docs/deployment/vercel.md`](docs/deployment/vercel.md)
and [`docs/deployment/free-hosting.md`](docs/deployment/free-hosting.md), which explains why no free host can run CPU YOLO.

---

## 🔌 API

The full reference is in **[`docs/api/README.md`](docs/api/README.md)**, and a running backend serves interactive docs at `/docs`.

| Group | Endpoints (prefix `/api`) | Notes |
|---|---|---|
| Images | `POST /images/analyze` · `POST /images/detect` | `analyze` is validation-only; `detect` runs the full pipeline and persists |
| Scan history | `GET /analyses` · `GET` / `DELETE /analyses/{id}` · `GET /analyses/{id}/image` · `GET /analyses/{a}/compare/{b}` | Keyset pagination; cross-tenant ids are `404` |
| Cloud jobs | `POST /uploads/presign` · `POST /jobs` · `GET /jobs/{id}` · `POST /jobs/{id}/cancel` · `GET /system/status` | Same shapes in FastAPI and the Lambda control plane |
| Workbench (local only) | `/quality`, `/alerts`, `/annotations`, `/datasets`, `/models`, `/workbench/jobs`, `/benchmarks`, `/evaluations`, `/drift`, `/training`, `/saved` | Owner-scoped; heavy jobs share one slot (`409 busy`) |

Errors always use the envelope `{"success": false, "error": "<code>", "detail": "…"}`.

---

## ✅ Testing and quality assurance

```bash
# Backend: inference is mocked, no weights are downloaded, the real data stores are never touched
cd backend
.venv\Scripts\python.exe -m pytest -q
.venv\Scripts\python.exe -m ruff check . --config ruff.toml

# Frontend
cd frontend
npm run lint && npm run typecheck && npm test && npm run build

# Infrastructure: no AWS calls, no credentials, no apply
cd infrastructure/terraform
terraform fmt -check -recursive && terraform init -backend=false && terraform validate
```

**Results from the latest verified local run** (24 October 2026). These are a snapshot, not live badges:

| Check | Result |
|---|---|
| Backend — `pytest` | **322 passed**, 0 skipped |
| Backend — `ruff check` | clean |
| Frontend — `vitest` | **457 passed** across 25 files |
| Frontend — `eslint` / `tsc --noEmit` | clean |
| Production build / demo build | both succeed; the bundle has no `eval(`, no `new Function`, no inline `<script>` |
| Cross-component contract tests | `backend/tests/test_cloud_contracts.py` imports the real Lambda with boto3 mocked and checks key, SQS, DynamoDB and response shapes |

**Browser acceptance audit.** All 18 features were exercised through the real UI in headless Chromium at
five viewports (1440×900, 1280×800, 820×1180, 390×844 and 320×700), with every on-screen figure
cross-checked against the backend API:

- **186 test cases recorded:** 182 passed (177 in the browser, 4 automated-only, plus the demo build).
- **2 blocked:** a real training run, and real-world accuracy, which needs independent labels.
- **2 not run:** 1 not run live, 1 not applicable.
- **Covered:** journeys, visual layout, keyboard and screen-reader accessibility, error recovery, security probes (path traversal, malformed input, script-like text), and PDF rendering, which was rasterised and inspected page by page.
- **Dataset zip exports** were validated end to end.
- **Defects found during the audit** (11 application defects, 1 accessibility naming issue) were fixed with regression tests and re-verified.

This is a **local** QA scope on one machine. It does not cover every browser, every input, load testing,
or any deployed environment.

---

## 🔐 Security and reliability

| Protection | Implementation |
|---|---|
| Input validation | Full image decode; size and type limits; Pydantic-validated bodies, bounded list lengths and names |
| Tenant isolation | `owner_id` comes **only** from verified token claims, never a header, query or body. Every repository, storage and workbench call is owner-scoped; cross-tenant reads are `404` |
| Safe file paths | Storage keys are built server-side as `uploads/{owner}/{id}.{ext}` and checked with `assert_owned`; models load only by registry id from known directories, never a client path |
| Dataset export safety | Zip entries are named from server-generated scan ids and split names, never from uploaded filenames; images are read from a content-addressed blob store, so no client-supplied path reaches the filesystem |
| Training safeguards | Two explicit confirmations; validated parameters written to a server-chosen directory; fixed argv with no shell; low priority; real cancellation; explicit registration |
| CSV formula injection | Batch CSV export neutralises cells starting with `=`, `+`, `-`, `@` and similar characters |
| Bounded resources | One heavy job at a time (`409 busy`), sequential batch processing, a bounded predictor cache, an in-process rate limiter and capped history |
| Authentication | RS256 / JWKS verification with asymmetric algorithms only. Misconfiguration fails closed (`503`); caller faults are `401`. The SPA uses the Cognito code flow + PKCE (S256), keeps tokens **in memory only**, and never handles refresh tokens |
| Browser hardening | Strict CSP (`script-src 'self'`, `default-src 'none'`, `frame-ancestors 'none'`) defined once in `frontend/src/security/csp.ts` and mirrored in the CloudFront headers policy |
| Error handling | One error envelope; domain errors mapped to HTTP codes; correlation ids on every response and in JSON logs |

These controls are implemented and tested locally. VisionIQ has not had an independent security audit
or penetration test. See [`docs/security/threat-model.md`](docs/security/threat-model.md).

---

## ☁️ Cloud architecture

> [!WARNING]
> **The AWS architecture is implemented as code but is not currently deployed.** `terraform apply` has
> never been run. No AWS resources exist for this project, and every cloud claim here is about code and
> tests, not a running system.

| Service | Role in the design |
|---|---|
| **S3** | Private upload bucket (owner-prefixed keys, presigned PUT) and private SPA bucket behind Origin Access Control |
| **CloudFront** | SPA delivery, with a response-headers policy that mirrors the app's CSP |
| **Cognito** | Hosted-UI sign-in (authorization code + PKCE only); access tokens verified by the gateway and backend |
| **API Gateway + Lambda** | JWT-authorised control plane: presign, create / get / list / cancel / delete jobs |
| **SQS (+ DLQ)** | Job queue between the control plane and the inference worker |
| **ECS Fargate** | Long-running inference worker running the same `analyse()`. Fargate rather than Lambda, because the torch image is too large and CPU cold starts are too slow |
| **DynamoDB** | Job and analysis records, with promoted query attributes and a full `payload` |
| **Terraform** | 11 modules plus per-environment configuration; `fmt` and `validate` clean in CI |
| **GitHub Actions** | CI on push and PR (tests, lint, Terraform validate, worker image build and scan **without push**). `deploy.yml` is `workflow_dispatch`-only and approval-gated |

Cost notes and the runbook, never executed: [`docs/deployment/aws.md`](docs/deployment/aws.md) and [`docs/cost/README.md`](docs/cost/README.md).

---

## 📁 Project structure

```text
VisionIQ/
├── backend/
│   ├── app/
│   │   ├── main.py, config.py, security.py, observability.py
│   │   ├── auth/            JWT / JWKS verification, tenant resolution
│   │   ├── routes/          images, analyses, cloud, workbench (thin controllers)
│   │   ├── schemas/         Pydantic contracts
│   │   ├── services/        analysis pipeline, vision providers, retail, insights
│   │   ├── repositories/    sqlite | dynamodb
│   │   ├── storage/         local | s3
│   │   ├── cloud/           job state machine, SQS worker
│   │   └── workbench/       quality, alerts, annotations, datasets, models, jobs,
│   │                        benchmark, evaluation, metrics, drift, training, store
│   ├── scripts/             smoke_inference.py, generate_demo_fixtures.py
│   └── tests/               pytest suite (inference always mocked)
├── frontend/
│   └── src/
│       ├── pages/           one page per feature
│       ├── components/      analyze/, annotate/, charts/, ui/ and shared panels
│       ├── lib/             analytics, heatmap, zones, assistant, batch, pdf/, router
│       ├── api/             local / cloud / demo clients, workbench client
│       ├── auth/            Cognito code flow + PKCE, in-memory session
│       ├── demo/            recorded fixtures and demo client
│       └── security/csp.ts  single source of truth for the CSP
├── infrastructure/terraform/   AWS modules + Lambda control plane (never applied)
├── docs/                       architecture, api, deployment, security, cost, screenshots
└── .github/workflows/          CI + manual-only deploy
```

---

## ⚠️ Known limitations

- **Generic COCO detection is not retail SKU recognition.** The model sees object classes, not products or brands.
- **Detection counts are not verified stock counts.** Occluded, stacked or hidden items are missed, and overlapping boxes can double-count.
- **Shelf gaps and stockouts are not inferred.** That needs a planogram or empty-space annotations; the API reports `unsupported`.
- **Ask VisionIQ is deterministic.** It is a rule-based query engine over stored scans, not a hosted generative LLM.
- **No retail-specific model has been trained yet.** The training workflow is implemented and tested with a fake worker; no real training run has been performed.
- **No independently verified retail accuracy metric exists.** Evaluation runs so far used demonstration labels, not an independent, human-verified retail test set.
- **Many features depend on the local backend.** Features 11–18 have no cloud or demo equivalent.
- **CPU inference is slower than GPU inference.** Expect seconds per image on a laptop. Benchmark figures are machine-specific.
- **Static demo mode is limited.** It replays recorded results and cannot analyse new images.
- **The YOLOv8 licence matters.** Ultralytics YOLOv8 and its weights are AGPL-3.0, so serving them over a network carries source-disclosure obligations. See [`docs/architecture/models.md`](docs/architecture/models.md).

---

## 🗺 Roadmap

1. **Build a human-reviewed retail dataset.** Photograph real shelves and review the boxes in Annotation Studio with retail classes.
2. **Measure accuracy on independent ground truth.** Hold out a test split that the evaluated model never pre-annotated.
3. **Run a controlled fine-tuning experiment** with the existing training workflow, once the dataset is large enough to be meaningful.
4. **Compare the trained and baseline models** in the Evaluation Center and Benchmark Lab on the same frozen version.
5. **Consider deployment** only after those results exist, and only with explicit approval of the cost and the AGPL implications.

---

## 🤝 Contributing and license

Issues and pull requests are welcome. Before contributing, read [`CLAUDE.md`](CLAUDE.md), which documents
the project's conventions. The most important ones are:

- **Honesty.** Never fabricate detections, SKUs, stock levels or gaps; report `unsupported` instead.
- **Layering.** Routes stay thin, logic lives in services, and providers are selected by configuration.
- **Tenancy.** The owner id comes only from verified claims, and cross-tenant reads return `404`.
- **Contract tests.** A change to a cross-component shape updates every side and `backend/tests/test_cloud_contracts.py` in the same commit.
- **No Python 3.11-only constructs.** The floor is 3.10.
- **Run every quality gate** in [Testing](#-testing-and-quality-assurance) before opening a PR.

**License.** This repository does not currently include a license file, so no open-source license is
granted. Ask the author before reusing the code. Third-party components keep their own licenses; in
particular, Ultralytics YOLOv8 and its weights are AGPL-3.0.

---

## 🧭 Summary

VisionIQ is a complete, locally runnable retail-vision platform. It demonstrates:

- **Full-stack engineering:** a typed FastAPI backend and a React / TypeScript SPA sharing one analytics source of truth.
- **Computer vision:** real YOLO inference with pixel-accurate overlays, a heatmap, zones and image-quality diagnostics.
- **MLOps lifecycle design:** annotation, immutable datasets, evaluation, benchmarking, drift monitoring and guarded training.
- **Cloud-native architecture:** a modular AWS design in Terraform with contract tests across the service seam, deliberately not deployed.
- **Data integrity:** immutable predictions, frozen versions, leakage-safe splits, optimistic concurrency and owner isolation.
- **Security:** verified identity, fail-closed configuration, a strict CSP, safe paths and formula-safe exports.
- **Testing:** 779 automated tests in the latest run, plus a multi-viewport browser acceptance audit.
- **Responsible AI claims:** every number says what it is, and what it is not.
