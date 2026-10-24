# VisionIQ — Cloud-Native AI-Powered Retail Shelf Intelligence Platform

VisionIQ analyses retail shelf photographs: it validates an upload, runs object
detection, derives retail observations, and stores the result so scans can be
reviewed and compared. It runs fully locally with no AWS account, and the same
code paths run in the cloud when configured.

## The honesty rule (most important convention)

**Never fabricate detections, SKU identities, stock levels, or shelf gaps.**

The default model is a generic COCO-80 detector. It recognises `bottle`, `cup`,
`person` — it cannot tell one product from another. The codebase enforces this:

- `InferenceStatus.UNAVAILABLE` ≠ "the shelf is empty". When no model runs, the
  caveats say *nothing was analysed*.
- `SkuAssessment.status` is `unsupported` until a real SKU matcher is registered.
- `ShelfGapAssessment.reliability` is `unsupported`; gaps are never inferred
  from object absence.
- `OccupancyEstimate` is tagged `estimated` and documents that overlapping boxes
  inflate it.
- LLM output is tagged `InsightSource.BEDROCK` and never presented as verified.

If you add a feature that cannot be backed by real model output, it must report
an explicit `unsupported` / `unavailable` status rather than a plausible number.

## Repository layout

```
VisionIQ/
├── backend/
│   ├── app/
│   │   ├── main.py            App, CORS, middleware, router wiring
│   │   ├── config.py          All env-driven settings (single source)
│   │   ├── security.py        Tenant resolution (FastAPI deps), rate limiting
│   │   ├── auth/              Verified caller identity — the ONLY source of owner_id
│   │   │   ├── base.py        TokenClaims, AuthError
│   │   │   ├── jwt_verifier.py  JWKS cache + RS256 verification
│   │   │   └── resolver.py    Mode dispatch: none | apigateway | jwt
│   │   ├── observability.py   JSON logging, correlation IDs
│   │   ├── routes/            HTTP layer — thin controllers
│   │   │   ├── images.py      /api/images/analyze, /api/images/detect
│   │   │   ├── analyses.py    history: list/get/delete/compare
│   │   │   └── cloud.py       presign, jobs, system status
│   │   ├── schemas/           Pydantic contracts (image, detection, retail,
│   │   │                      insights, analysis)
│   │   ├── services/
│   │   │   ├── image_analyzer.py    Phase 1 validation (unchanged)
│   │   │   ├── analysis_service.py  Orchestrates the whole pipeline
│   │   │   ├── vision/        DetectionProvider: yolo | sagemaker | null
│   │   │   ├── retail/        Aggregation, comparison, SKU interface
│   │   │   └── insights/      rule_based (default) | bedrock (optional)
│   │   ├── repositories/      AnalysisRepository: sqlite | dynamodb
│   │   ├── storage/           ImageStorage: local | s3
│   │   └── cloud/             Job state machine + SQS worker
│   ├── tests/                 pytest; model inference always mocked
│   │   └── test_cloud_contracts.py  Lambda↔backend seam: key/SQS/DynamoDB
│   │                                shapes. Imports the real Lambda with
│   │                                boto3 mocked — no AWS, no credentials
│   ├── scripts/smoke_inference.py   Real inference check (manual)
│   ├── Dockerfile / .dockerignore   Fargate worker image (never built — no Docker here)
│   ├── requirements.txt       API deps incl. PyJWT[crypto] — 64-bit, Py>=3.10
│   ├── requirements-ml.txt    torch/ultralytics — 64-bit ONLY
│   └── requirements-dev.txt   pytest, ruff, coverage
├── frontend/                  React 19 + TS + Vite dashboard
│   ├── .env.example           VITE_* reference; every value is PUBLIC
│   └── src/
│       ├── main.tsx           Wraps the app in <AuthProvider>
│       ├── AuthenticatedApp.tsx  Gates the dashboard behind <AuthGate>
│       ├── App.tsx            App shell + hash router; optional user/mode/onLogout props
│       ├── pages/             Dashboard, Analyze, Compare, Timeline, Reports
│       ├── data/              ScanSource (local | cloud | demo) + ScanDataProvider:
│       │                      history fetched once, shared by every page
│       ├── lib/
│       │   ├── analytics.ts   THE single source of every metric (KPIs, trends,
│       │   │                  alerts, compareRecords = port of backend compare)
│       │   ├── zones.ts       Zone geometry; box CENTRE -> first zone, no double count
│       │   ├── heatmap.ts     Deterministic detection-density grid
│       │   ├── router.ts      Dependency-free hash router
│       │   └── pdf/           Hand-written PDF writer + inspection report (no deps)
│       ├── auth/              Cognito hosted-UI sign-in (code flow + PKCE)
│       │   ├── config.ts      resolveAuthConfig: local | cognito | misconfigured
│       │   ├── pkce.ts        S256 verifier/challenge/state, sessionStorage stash
│       │   ├── cognito.ts     authorize/logout URLs, code exchange, AuthFlowError
│       │   ├── session.ts     In-memory token store, EXPIRY_SKEW_MS = 60_000
│       │   ├── context.ts     AuthStatus / AuthContextValue
│       │   ├── AuthProvider.tsx  Bootstrap, silent re-auth, expiry, 401 handling
│       │   ├── useAuth.ts     Context accessor
│       │   └── contract.test.ts  Encodes the backend + Terraform contracts
│       ├── api/
│       │   ├── config.ts      resolveApiConfig: VITE_API_MODE local | cloud,
│       │   │                  base URL, poll interval/timeout; apiUrl(path)
│       │   ├── analysisClient.ts  AnalysisClient: local one-shot detect, or
│       │   │                  cloud presign → S3 PUT → create job → poll
│       │   ├── client.ts      request() (+ optional config), onUnauthorized
│       │   └── auth.ts        token provider
│       ├── security/csp.ts    CSP + security headers — single source of truth,
│       │                      mirrored by the CloudFront response-headers policy
│       ├── components/        AuthScreens.tsx + dashboard panels
│       └── {utils,test}
├── infrastructure/terraform/  Modular AWS IaC (never auto-applied)
│   ├── lambda/api/handler.py  Control-plane handlers (presign, jobs CRUD)
│   └── modules/frontend/      SPA delivery: S3 + OAC + CloudFront + headers policy
├── docs/{architecture,api,deployment,security}
└── .github/workflows/         CI + manual-approval deploy
```

## One virtualenv — read this before running anything

The environment split is **resolved**. There is exactly one venv —
`backend/.venv`, 64-bit Python **3.10** — used for the API, tests, ruff and
real inference. The former 32-bit Python 3.11 venv has been **deleted**.

**64-bit Python is mandatory.** A 32-bit interpreter can run neither PyTorch
*nor* `cryptography`: neither publishes 32-bit Windows wheels, and a source
build of `cryptography` dies in the Rust linker. PyJWT's RS256 path needs
`cryptography`, so on 32-bit the entire auth test module skipped
(`124 passed, 1 skipped` versus **322 passed** on 64-bit today).

The floor is Python **3.10**, so do not introduce 3.11-only constructs
(`datetime.UTC`, `enum.StrEnum`). `ruff.toml` pins `target-version = "py310"` to
enforce this, and CI runs the suite on both 3.10 and 3.11, x64 only.

## Architecture

**Local (synchronous):** browser → Vite proxy → FastAPI `/api/images/detect` →
`analysis_service.analyse()` → YOLO provider → retail aggregation → rule-based
insights → SQLite + local file storage → full record returned.

**Cloud (asynchronous):** browser → Cognito sign-in → API Gateway JWT authorizer
(attached to all six routes) → presigned S3 PUT → `POST /api/jobs` (server
re-validates the object) → DynamoDB `queued` + SQS → ECS Fargate worker →
`jobs.process_job()` → DynamoDB `completed` → client polls `GET /api/jobs/{id}`.

Inference is a **Fargate container, not Lambda**: the torch image exceeds
practical Lambda limits and CPU cold starts are unacceptable for a queue worker.

Both paths call the same `analysis_service.analyse()`, so results are identical.

## Cross-component contracts — change all sides or none

The Lambda control plane (`infrastructure/terraform/lambda/api/handler.py`) and
the FastAPI backend (`backend/app/`) are written in different places, ship
separately, and only meet inside a deployed AWS account. Three data shapes
cross that seam. Each of them was **broken** before Phase 3.7, and nothing
local caught it — the local path never touches the seam.

### 1. Storage key

```
{UPLOAD_PREFIX}{owner_id}/{analysis_id}.{ext}      e.g. uploads/alice/abc123.jpg
```

| Side | Where |
|---|---|
| Backend | `backend/app/storage/base.py::build_key` / `assert_owned` (both take an optional `prefix`) |
| Lambda | `handler.py::build_key` / `_owns_key`, using `UPLOAD_PREFIX` |
| Config | `VISIONIQ_UPLOAD_PREFIX` (default `uploads/`) in `backend/app/config.py`; `upload_prefix` Terraform variable |
| IAM | `modules/security/main.tf` scopes `s3:GetObject`/`PutObject`/`DeleteObject` to `${bucket_arn}/${upload_prefix}*` |

A key built any other way is **unreadable by the worker** — the failure is
`AccessDenied` at inference time, not a 404 at upload time. Extension, prefix
and separator are all part of the contract.

### 2. SQS message body

```json
{ "analysis_id": "…", "owner_id": "…", "image_key": "uploads/alice/abc123.jpg" }
```

Produced by both `backend/app/cloud/jobs.py::enqueue` and the Lambda's
`create_job`. Consumed by `backend/app/cloud/worker.py::process_message`, which
requires `analysis_id` and `owner_id`. Never rename a field on one producer
only — that is exactly bug #2 of Phase 3.7 (`object_key` vs `image_key`).

### 3. DynamoDB item

Promoted query attributes (`owner_id`, `analysis_id`, `created_at`, `status`,
`filename`, `detection_count`, `distinct_categories`, `top_labels`,
`execution_mode`) **plus a `payload` attribute holding the full
`AnalysisRecord` JSON**, because `dynamo_repo.py::_record` does:

```python
AnalysisRecord.model_validate(_from_dynamo(item["payload"]))
```

An item without a parseable `payload` makes every job raise `KeyError` in the
worker and land on the DLQ. The Lambda writes **integers, never floats** in the
payload (`0`, not `0.0`): DynamoDB rejects `float` outright.

### 4. Successful response shapes (the canonical API contract)

**FastAPI's successful response schemas are THE contract.** For equivalent
resources the Lambda returns exactly the same shapes, so a client parses one
format regardless of which backend it is talking to. The Lambda's projection
helpers (`_record`, `_summary`, and `_SUMMARY_FIELDS`, which mirrors
`AnalysisSummary.model_fields`) exist solely to hold this line.

| Resource | Canonical shape |
|---|---|
| create / get / cancel job | bare `AnalysisRecord` |
| list jobs | bare `AnalysisPage` — `{items, next_cursor, has_more}`, items are `AnalysisSummary` |
| presign | `PresignResponse` — `{analysis_id, upload{url, key, expires_in, required_headers, max_bytes}}` |
| delete job | `204`, no body |

Storage internals never cross the wire: `_record` returns `item["payload"]`,
dropping `payload`/`expires_at`. `owner_id` stays, because it is a field of
`AnalysisRecord`.

**Deliberately unchanged:** the **error envelope**
(`{"success": false, "error": "<code>", "detail": "…"}`) already matched on
both sides and was left alone, and **204 is bodiless** — RFC 9110 forbids a
body and some clients and proxies mishandle one. Do not "harmonise" either.

> **Rule:** any new or changed success response must have the **same shape in
> FastAPI and in the Lambda** for equivalent resources, and
> `backend/tests/test_cloud_contracts.py` must assert it **in the same commit.**

### The rule

> Changing any one of these four shapes requires changing **every** side —
> backend, Lambda, Terraform IAM — **and** `backend/tests/test_cloud_contracts.py`,
> **in the same commit.** That file (62 tests) is the only thing standing
> between a rename and a silently broken deployment. It imports the real Lambda
> module with the environment stubbed and boto3 mocked, so it needs no AWS
> credentials and makes no network call.

Related contracts covered by the same file: the pagination cursor format (must
round-trip between `dynamo_repo._encode_cursor` and the Lambda's, and must
reject another tenant's cursor), the error envelope
(`{"success": false, "error": "<code>", "detail": "…"}`), and the rule that
`owner_id` comes only from the verified JWT `sub`.

## Coding conventions

- **Layering:** routes stay thin; logic lives in `services/`; I/O shapes in
  `schemas/`; persistence behind `repositories/`; blobs behind `storage/`.
  Services raise domain errors; routes map them to HTTP.
- **Swapping implementations is configuration, not code.** Every pluggable
  concern is a `Protocol` in a `base.py` with a cached factory. Add a provider,
  register it in the factory, select it with an env var.
- **Config:** every tunable lives in `config.py`, read from the environment.
  No secrets, no account IDs, anywhere in source or Terraform.
- **Tenancy:** every repository and storage call is scoped by `owner_id`.
  `assert_owned()` guards storage keys; pagination cursors are rejected if they
  reference another tenant.

### Authentication — non-negotiable

- **The owner id comes only from verified claims.** `app/auth/` produces a
  `TokenClaims`; `TokenClaims.subject` (the token's `sub`, or the pseudo-tenant
  `local` when `VISIONIQ_AUTH_MODE=none`) is the sole tenant key.
- **Never add a code path that reads an owner id from a header, query parameter
  or request body.** The old trusted `X-VisionIQ-User` header is gone and must
  not come back in any form, including "just for tests" or "just for the
  worker".
- **Cross-tenant reads must return 404, not 403.** A 403 confirms that the
  record exists under some other tenant; a 404 leaks nothing. (403 is correct
  only for a *storage key prefix* that is not the caller's, where the key is
  client-supplied and nothing is being looked up — `routes/cloud.py`
  `assert_owned`.)
- **Misconfiguration fails closed.** An unknown mode, a missing issuer or
  audience, or an unreachable JWKS yields `503`, never anonymous access.
  Caller-fault failures are `401` with `WWW-Authenticate: Bearer`, and their
  messages never echo token contents, keys or internal state.
- **Asymmetric algorithms only** (`RS256/384/512`). Never add an HS\* algorithm
  to `ALLOWED_ALGORITHMS`: JWKS keys are public, so accepting HMAC is the
  algorithm-confusion forgery.
- **Tests never download weights.** Inference is mocked via the `fake_provider`
  fixture; `VISIONIQ_DETECTION_PROVIDER=null` is the CI default.
- **Frontend:** types in `types.ts` mirror the backend. All calls go through
  `src/api/client.ts` using absolute `/api` paths — never a hardcoded host.
  The origin, if any, comes from `resolveApiConfig()` via `apiUrl()`. A caller
  holding a resolved `ApiConfig` (the cloud analysis client) **must pass it to
  `request()`**, or the call silently goes same-origin instead of to the
  configured gateway — that was a real bug in Phase 3.8.
- **The S3 PUT carries no `Authorization` header.** `putToS3` sends exactly the
  `required_headers` that were signed. The presigned signature is the
  credential; a bearer token there would leak it to the storage endpoint, and
  any extra header breaks the signature anyway.
  Bounding boxes render in an SVG whose `viewBox` is the original image size, so
  scaling is automatic.
- **Detection colours** are assigned by category rank (`utils/colors.ts`), not by
  hashing the label — hashing collided on `bottle`/`cup`.

#### Content Security Policy (`frontend/src/security/csp.ts`)

- **`csp.ts` is the single source of truth.** `vite.config.ts` serves it on the
  dev server (relaxed) and on `vite preview` (strict); CloudFront's
  response-headers policy in `infrastructure/terraform/modules/frontend/`
  delivers it in production. Changing one without the other produces a policy
  that passes locally and breaks in production — change both.
- **Never add `'unsafe-eval'`** to any directive, in any environment but the
  dev server's `dev = true` branch. The production bundle was measured and
  contains zero `eval(` / `new Function(`; there is nothing to accommodate.
- **Never add `'unsafe-inline'` to `script-src`.** `script-src 'self'` holds
  against the real bundle: zero inline `<script>` blocks, one external module
  script. `'unsafe-inline'` in **`style-src`** stays — four runtime-computed
  `style={{}}` props need it, and inline style cannot execute JavaScript.
  Removing it requires per-request nonces, which a static CloudFront origin
  cannot generate. Do not silently "fix" it by adding inline scripts.
- **A new external origin goes in two places:** the `CspOrigins` plumbing in
  `csp.ts` *and* the Terraform frontend module. A hardcoded origin in a
  component is not a CSP update.
- `default-src 'none'`, `object-src 'none'`, `frame-ancestors 'none'` and
  `base-uri 'self'` are deliberate floors. Widen a specific directive instead.

#### Frontend auth rules (`frontend/src/auth/`) — equally non-negotiable

- **The access token lives in memory only** — the module-scoped variable in
  `auth/session.ts`, surfaced to the API client through `api/auth.ts`. Never
  write it to `localStorage`, `sessionStorage`, a JS-readable cookie, or the
  URL. A reload starting with no token is the design, not a bug.
- **No refresh token ever enters the browser.** `exchangeCodeForTokens` must
  not read, return or store `payload.refresh_token`. It is a 30-day credential
  (Terraform default) and every SPA-reachable store is JS-readable. Session
  continuity is `prompt=none` silent re-auth against Cognito's own session
  cookie — not a refresh token, and not browser storage.
- **Never add the implicit flow.** `response_type` is `code`, always;
  `code_challenge_method` is `S256`, never `plain`. Terraform permits only
  `allowed_oauth_flows = ["code"]`.
- **Never add a production bypass.** `resolveAuthConfig` must keep failing
  closed: a production build with `VITE_AUTH_MODE=local`, missing Cognito
  settings, an unknown mode or an `http://` redirect URI all resolve to
  `misconfigured`, which renders a hard error and never a dashboard.
- **`state` must be validated before the code is exchanged.** It is generated
  per request, stashed, and compared with `statesMatch`; a mismatch aborts
  before `fetch` is called. This is the CSRF defence for the callback.
- **The dashboard stays behind `AuthGate`.** `AuthenticatedApp` renders
  `App` only on `status === 'authenticated'`. Do not render dashboard routes
  from any other status.
- The PKCE verifier and `state` are the *only* things allowed in
  `sessionStorage`, because they must survive the redirect. They are not
  credentials: single-use, useless without the matching code, tab-scoped, and
  `consumeFlow()` always clears them.
- `readClaimsUnsafe` performs **no** verification and is for display only. It
  must never drive an authorization decision — the backend verifies.
- The SPA sends the **access** token, matching the backend's
  `VISIONIQ_JWT_TOKEN_USE=access` default. Keep `VITE_COGNITO_CLIENT_ID` equal
  to `VISIONIQ_JWT_AUDIENCE` and `VITE_COGNITO_ISSUER` equal to
  `VISIONIQ_JWT_ISSUER`; `auth/contract.test.ts` encodes this.
- `redirect_uri` is the **bare origin, no path** — Cognito requires an exact
  match with the URLs Terraform registers.

## Bounding box convention

`xyxy`, origin top-left, **absolute pixels in the original image**, with
`0 ≤ x1 < x2 ≤ width`. Providers that resize must rescale back. Documented in
`backend/app/schemas/detection.py`.

## Development commands

Backend API, tests and inference — all in `.venv`:
```
cd backend
.venv\Scripts\activate
python -m pip install -r requirements-dev.txt -r requirements-ml.txt
uvicorn app.main:app --reload --port 8080     # port 8000 fails on this machine
python -m pytest -q                            # 322 passed
python -m pytest tests\test_auth.py -q         # auth suite specifically
python -m ruff check . --config ruff.toml
python scripts\smoke_inference.py path\to\shelf.jpg
```

Auth is off by default (`VISIONIQ_AUTH_MODE=none`, owner `local`). To exercise
verification locally, set `VISIONIQ_AUTH_MODE=jwt` plus `VISIONIQ_JWT_ISSUER`
and `VISIONIQ_JWT_AUDIENCE` and send `Authorization: Bearer <token>`.

Frontend:
```
cd frontend
npm install
cp .env.example .env.local     # optional: defaults to VITE_AUTH_MODE=local in dev
npm run dev        # :5175, proxies /api -> 127.0.0.1:8080
npm run lint && npm run typecheck && npm test && npm run build   # 457 passed (25 files)
```

The frontend defaults to `VITE_AUTH_MODE=local` in dev, which pairs with the
backend's default `VISIONIQ_AUTH_MODE=none`. To exercise the real sign-in flow
set `VITE_AUTH_MODE=cognito` plus `VITE_COGNITO_DOMAIN` and
`VITE_COGNITO_CLIENT_ID`, and run the backend with `VISIONIQ_AUTH_MODE=jwt`.
A *production* build (`npm run build`) refuses `VITE_AUTH_MODE=local` and
renders a configuration error instead — that is deliberate, do not work around
it. See [`docs/deployment/local.md`](docs/deployment/local.md).

Infrastructure (never auto-applied):
```
cd infrastructure/terraform
terraform fmt -recursive && terraform init -backend=false && terraform validate
```

## Rules

- Do not deploy AWS resources or run `terraform apply` without explicit approval.
- Never commit `.env`, model weights (`*.pt`), the SQLite DB, or virtualenvs.
- Keep the app fully usable without AWS credentials.
- Preserve Phase 1 behaviour: `/api/images/analyze` must stay validation-only.
