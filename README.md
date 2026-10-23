# VisionIQ

**Retail shelf intelligence that reports what it can see, and says so when it
can't.** Upload a shelf photograph, run real object detection, review bounding
boxes and confidence scores, and compare scans over time.

![tests](https://img.shields.io/badge/tests-232%20backend%20%2F%20217%20frontend-brightgreen)
![python](https://img.shields.io/badge/python-3.10%20x64-blue)
![typescript](https://img.shields.io/badge/typescript-strict-blue)
![licence](https://img.shields.io/badge/model-AGPL--3.0-orange)

---

## Live demo

<!-- DEPLOY: replace with the Vercel URL once deployed -->
**→ `https://<your-deployment>.vercel.app`**

**Read this before you click.** The public demo **replays pre-recorded
results** and **cannot analyse an image you upload**. There is no file input on
the deployed page at all.

Everything it shows is real: each box, label and confidence came out of an
actual YOLOv8n run on a developer machine, captured verbatim by
[`backend/scripts/generate_demo_fixtures.py`](backend/scripts/generate_demo_fixtures.py)
and committed as static JSON. Nothing is invented. But they are *recordings*,
not live inference, and the deployment says so in a banner you cannot miss.

The reason is budget, not design: no genuinely free host can run CPU YOLO
inference reliably — PyTorch alone needs ~300–500 MB resident, and every free
tier surveyed caps out at 512 MB or 0.1 CPU. The full research, with sources,
is in [`docs/deployment/free-hosting.md`](docs/deployment/free-hosting.md).

**For live detection on your own photos, run it locally** — two commands, no
AWS account, no cloud anything. See [Running locally](#running-locally).

---

## What it does

- **Validates** uploads — JPEG/PNG/WebP, 10 MB cap, by decoding real pixels
  rather than sniffing a header
- **Detects** objects with a local CPU YOLOv8n model, or a SageMaker endpoint
- **Visualises** bounding boxes with live confidence filtering and
  per-detection selection
- **Aggregates** category counts, confidence statistics, and a coarse
  occupancy estimate
- **Narrates** findings deterministically from rules, or via Amazon Bedrock
  when explicitly enabled
- **Persists** every scan to SQLite (or DynamoDB) with search, pagination, and
  two-scan comparison

---

## What it deliberately does *not* do

The default model is a generic **COCO-80** detector. It sees `bottle`, `cup`,
`person` — not products. So VisionIQ **reports its limits rather than guessing
past them**:

| Capability | Status in the API | Why |
|---|---|---|
| SKU / product identity | `unsupported` | Needs a retail fine-tuned model or an embedding index. A COCO detector cannot distinguish two brands of the same bottle |
| Shelf-gap detection | `unsupported` | Needs a planogram reference or empty-space annotations. Neither exists here |
| Occupancy | `estimated` | A box-area heuristic. Overlapping boxes inflate it, and the API labels the number as an estimate rather than a measurement |
| Stock levels / low-stock alerts | not implemented | Would require all of the above. A fabricated alert is worse than no alert |

And the distinction that matters most:

> **`unavailable` is not "the shelf is empty."** When no model can be loaded,
> the result says *nothing was analysed*. When a model runs and finds nothing,
> the result says `empty`. These are different states, they are different
> fields, and conflating them would turn a broken deployment into a confident
> report of bare shelves.

This is enforced in code and covered by tests — including in the demo, where
one of the three samples genuinely produced **zero detections** and is kept
precisely so the demo does not only show flattering results.

---

## Architecture

Three execution modes, one API contract.

```
LOCAL — synchronous, no cloud, real inference
  browser ──► Vite proxy ──► FastAPI ──► YOLOv8n (CPU) ──► SQLite + filesystem
                              │
                              └─ POST /api/images/detect returns the finished
                                 AnalysisRecord in one round trip

DEMO — static, no backend at all  (this is what is deployed)
  browser ──► Vercel CDN ──► React bundle
                              │
                              ├─ samples.json  (recorded from a REAL local run)
                              └─ analyze() THROWS; the dropzone is replaced by
                                 a sample picker. No network calls are made.

AWS — asynchronous, queue-backed       ⚠ validated, never applied
  browser ──► Cognito hosted UI (code flow + PKCE) ──► access token (in memory)
          ──► API Gateway (JWT authorizer)
          ──► presigned PUT ──► S3   (private, uploads/{owner}/{id}.{ext})
          ──► POST /api/jobs ──► head_object verify ──► DynamoDB + SQS
          ──► ECS Fargate worker ──► inference ──► DynamoDB(completed)
          ──► browser polls GET /api/jobs/{id} until terminal

  SPA delivery: S3 (private, OAC) ──► CloudFront ──► response-headers policy
```

> **The AWS stack has never been deployed.** `terraform apply` has not been
> run; neither has `terraform plan`. There is no AWS account and there are no
> credentials on this machine. The infrastructure is written, reviewed,
> `fmt`-clean and `terraform validate`-passing, and it stays in the repository
> as an **architecture demonstration that is deliberately never applied** —
> because applying it would cost money, and the budget is $0. Every claim in
> this README about the cloud path is a claim about code and tests, never
> about a running system.

Every pluggable concern sits behind a `Protocol` with an env-selected factory:

| Concern | Options | Env var |
|---|---|---|
| Detection | `yolo`, `sagemaker`, `null` | `VISIONIQ_DETECTION_PROVIDER` |
| Persistence | `sqlite`, `dynamodb` | `VISIONIQ_REPOSITORY` |
| Image storage | `local`, `s3` | `VISIONIQ_STORAGE` |
| Insights | `rules`, `bedrock` | `VISIONIQ_INSIGHTS_PROVIDER` |
| Authentication | `none`, `apigateway`, `jwt` | `VISIONIQ_AUTH_MODE` |

Details in [`docs/architecture/overview.md`](docs/architecture/overview.md).

---

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| API | FastAPI, Pydantic v2 | Response models are the canonical API contract |
| Inference | Ultralytics YOLOv8n, PyTorch CPU | COCO-80. AGPL-3.0 — [see below](#model--licensing) |
| Persistence | SQLite / DynamoDB | One `Protocol`, two implementations |
| Storage | filesystem / S3 | Presigned PUT in cloud mode |
| Frontend | React 19, TypeScript (strict), Vite | No UI framework; hand-rolled CSS |
| Auth | OAuth 2.0 code flow + PKCE (S256), Cognito | Written by hand, no Amplify |
| Async | SQS + ECS Fargate worker | Not Lambda — [see below](#engineering-notes) |
| IaC | Terraform, modular | Validated, never applied |
| Tests | pytest, Vitest, Testing Library | 449 tests total |
| CI | GitHub Actions | Python 3.10 and 3.11, x64 |
| Demo host | Vercel Hobby, static | $0 |

---

## Running locally

> **One supported environment: `backend/.venv`, 64-bit Python 3.10.**
>
> 64-bit is a hard requirement, not a preference. A 32-bit Windows interpreter
> can install **neither** of the two things this project needs: **PyTorch**
> publishes no 32-bit Windows wheels, and **`cryptography`** (pulled in by
> `PyJWT[crypto]` for RS256 verification) publishes none either — its source
> build dies in the Rust linker. A 32-bit venv can therefore do neither
> inference nor JWT verification.
>
> The floor is **3.10**, so no 3.11-only constructs (`datetime.UTC`,
> `enum.StrEnum`). `ruff.toml` pins `target-version = "py310"` to enforce it.

**Create the venv:**

```bash
cd backend
<path-to-64bit-python-3.10> -m venv .venv
.venv\Scripts\python.exe -m pip install --index-url https://download.pytorch.org/whl/cpu \
    torch==2.14.1+cpu torchvision==0.29.1+cpu
.venv\Scripts\python.exe -m pip install -r requirements-dev.txt -r requirements-ml.txt
```

**Backend** — port 8080, auth off by default:

```bash
cd backend
.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8080
```

**Frontend** — port 5175, proxies `/api` to `127.0.0.1:8080`:

```bash
cd frontend
npm install
npm run dev
```

Open <http://localhost:5175> and drop in a photo. Interactive API docs at
<http://127.0.0.1:8080/docs>.

**Smoke test real inference** — downloads ~6 MB of weights on first run:

```bash
cd backend
.venv\Scripts\python.exe scripts\smoke_inference.py
```

`requirements.txt` installs standalone into a clean 64-bit venv (3.10 or 3.11)
and passes the suite without torch; `requirements-ml.txt` adds inference.

Full environment variable reference:
[`docs/deployment/local.md`](docs/deployment/local.md).

---

## Testing

```bash
# Backend — inference mocked, no weight downloads
cd backend
.venv\Scripts\python.exe -m pytest -q
.venv\Scripts\python.exe -m ruff check . --config ruff.toml

# Frontend
cd frontend
npm run lint && npm run typecheck && npm test && npm run build

# Infrastructure — no AWS calls, no credentials, no apply
cd infrastructure/terraform
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
```

Measured on this machine:

| Suite | Result |
|---|---|
| Backend — `pytest` | **232 passed** |
| Backend — `ruff check` | clean |
| Frontend — `vitest` | **217 passed across 13 files** |
| Frontend — `tsc --noEmit`, `eslint`, `vite build` | clean, no suppressions |
| Lambda — `python -m py_compile` | OK |
| Terraform — `fmt` + `validate` | clean; *"Success! The configuration is valid."* |

**Real local inference, measured:** `bus.jpg` at 810×1080 → **6 detections** —
`bus` 0.87, `person` 0.87 / 0.85 / 0.83 / 0.26, `stop sign` 0.26. Roughly
**2.9–7.5 s** warm on CPU, **~18 s** cold including the weight download.

**What is *not* verified:** nothing has run against AWS or a live Cognito pool.
Every cloud interaction is covered by unit and contract tests with `fetch`,
XHR and boto3 stubbed. The worker image has never been built — Docker is not
installed here.

---

## Project structure

```
backend/
  app/
    routes/        FastAPI endpoints (images, analyses, cloud jobs)
    services/      analysis pipeline, vision providers, retail, insights
    repositories/  sqlite_repo.py | dynamo_repo.py behind one Protocol
    storage/       local_storage.py | s3_storage.py
    auth/          JWT verification, owner-id resolution
    cloud/         SQS enqueue, Fargate worker loop
  scripts/
    generate_demo_fixtures.py   runs REAL inference, writes the demo fixture
    smoke_inference.py
  tests/           232 tests, incl. test_cloud_contracts.py

frontend/src/
  api/             config.ts (mode selection), analysisClient.ts, client.ts
  auth/            PKCE, session, Cognito code flow — hand-written
  components/      AnnotatedImage, DetectionPanel, InsightsPanel, DemoPanel …
  demo/            demoClient.ts, demoData.ts, samples.json, demo.test.ts
  security/        csp.ts — single source of truth for CSP

infrastructure/terraform/   modular AWS stack — validated, never applied
docs/                       architecture, API, deployment, security, cost
vercel.json                 static demo build, SPA rewrites, security headers
```

---

## Engineering notes

A few decisions worth the paragraph.

**1. The no-fabrication rule.** The hardest thing about building on a generic
detector is resisting the urge to extrapolate. A COCO-80 model that finds four
bottles does not know whether a shelf is understocked, and a system that
reports one anyway is worse than useless — it is confidently wrong at scale.
So every retail claim carries an explicit status (`unsupported`, `estimated`),
the "no model available" state is structurally distinct from "model ran, found
nothing", and the insights layer defaults to deterministic rules rather than
an LLM narrative. The demo inherits this: its records stay `source: "rules"`,
and `DemoAnalysisClient.analyze()` **throws** rather than return a canned
result for a user's file, because returning one would read as *"we analysed
your image"*, which would be a lie. Eighteen tests in
`frontend/src/demo/demo.test.ts` hold the line.

**2. Cross-component contract tests caught three silent integration bugs.**
The local path was green throughout. The cloud path — Lambda → DynamoDB → SQS →
Fargate → S3 — was broken end to end, because the two halves were written
separately and only ever meet inside a deployed AWS account that does not
exist. (i) The Lambda wrote a flat DynamoDB item; the repository reads
`item["payload"]` — every job would have died on `KeyError` and been redriven
to the DLQ. (ii) The Lambda's SQS body said `object_key`; the worker reads
`image_key`. (iii) Three different S3 key conventions were in play, one of
which the worker's IAM policy did not even grant read access to — `AccessDenied`,
not a 404, on every backend-written object. `backend/tests/test_cloud_contracts.py`
now imports the real Lambda module with boto3 mocked and asserts the seam:
item shape, key bytes, message body, error envelopes, pagination cursors. The
rule is that changing one side means changing the other side *and* the contract
test in the same commit.

**3. No refresh token ever enters the browser.** The SPA implements the OAuth
2.0 authorization code flow with PKCE (S256) by hand against the Cognito hosted
UI — no Amplify. `exchangeCodeForTokens` deliberately never reads
`payload.refresh_token`: it is long-lived (30 days by default) and every
SPA-reachable store is JavaScript-readable, so a single XSS would buy a month
of access. Session continuity comes instead from `prompt=none` silent
re-authentication against Cognito's *own* session cookie, with the access token
held in a module-scoped variable and nowhere else. The honest cost: closing the
browser requires a fresh interactive sign-in. A backend-for-frontend holding
the refresh token in an `HttpOnly` cookie is the documented upgrade path, and
it is not built.

**4. Inference on Fargate, not Lambda.** The obvious serverless instinct is
wrong here. A torch CPU image is far past Lambda's deployment limits, and even
within them, CPU cold starts measured at ~18 seconds are unacceptable for a
queue worker that should drain a backlog steadily. A long-lived Fargate task
keeps the model resident and the weights on disk. Lambda keeps the control
plane, where it belongs — short, bursty, I/O-bound.

**5. One API contract across three transports.** FastAPI's response models are
canonical; the Lambda control plane was changed to match them byte for byte, so
a client can talk to either without branching on the response shape. The payoff
is in `frontend/src/api/`: the local, cloud and demo clients implement the same
`AnalysisClient` interface, and only the *choreography* differs — one request,
versus presign → PUT → job → poll, versus replay from a bundled fixture. The
dashboard renders the same `AnalysisRecord` in all three cases and special-cases
nothing.

---

## Model & licensing

Default model: **YOLOv8n** via Ultralytics, CPU, COCO-80 classes.

> ⚠️ **Ultralytics YOLOv8 and its weights are licensed AGPL-3.0.** The AGPL's
> network-use clause is triggered by *serving the model over a network* — not
> only by distributing it. If you deploy this as a network service, you must
> release your corresponding source under a compatible licence, or buy an
> Ultralytics Enterprise Licence.
>
> This applies to the exported ONNX weights too: converting the format does not
> change the licence.
>
> For closed commercial use, swap in a permissively licensed model or a
> SageMaker endpoint — see
> [`docs/architecture/models.md`](docs/architecture/models.md).

Application code: choose your own licence, and note the obligation above if you
ship the default model.

---

## Cost

**As deployed: $0.** A static React bundle on Vercel Hobby. No backend, no
database, no storage bucket, no DNS registration, no card on file.

**Vercel Hobby is restricted to personal, non-commercial use** by Vercel's fair
use terms. A portfolio piece qualifies; anything revenue-generating needs Pro
at $20/user/month. Check Vercel's current Fair Use Guidelines yourself.

**If the AWS stack were ever applied** — it has not been — the dev workspace
would run at roughly **$1.50/month idle**, plus usage. That figure is an
estimate from the Terraform configuration, not an observed bill. See
[`infrastructure/terraform/README.md`](infrastructure/terraform/README.md) and
[`docs/cost/README.md`](docs/cost/README.md).

Free-tier terms change often. Verify every figure on the provider's own pricing
page before relying on it.

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/architecture/overview.md`](docs/architecture/overview.md) | System design, all execution paths |
| [`docs/architecture/models.md`](docs/architecture/models.md) | Model choice, licensing, limitations |
| [`docs/api/README.md`](docs/api/README.md) | Full endpoint reference |
| [`docs/deployment/local.md`](docs/deployment/local.md) | Local setup, every env var |
| [`docs/deployment/vercel.md`](docs/deployment/vercel.md) | The $0 demo deployment, step by step |
| [`docs/deployment/free-hosting.md`](docs/deployment/free-hosting.md) | Why no free host can run CPU YOLO — with sources |
| [`docs/deployment/aws.md`](docs/deployment/aws.md) | Cloud runbook (never executed) |
| [`docs/cost/README.md`](docs/cost/README.md) | Idle vs. per-use costs, teardown |
| [`docs/security/threat-model.md`](docs/security/threat-model.md) | Threat model and assumptions |
| [`docs/portfolio/screenshots.md`](docs/portfolio/screenshots.md) | Screenshot checklist |
| [`docs/portfolio/deployment-checklist.md`](docs/portfolio/deployment-checklist.md) | $0 deployment checklist |
| [`CLAUDE.md`](CLAUDE.md) | Conventions, layout, the honesty rule |
