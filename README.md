# VisionIQ

**Cloud-native retail shelf intelligence.** Upload a shelf photograph, run real
object detection, review bounding boxes and confidence scores, and compare scans
over time — locally with no AWS account, or on AWS when you want it.

![status](https://img.shields.io/badge/phase-3.8-blue)
![tests](https://img.shields.io/badge/tests-231%20backend%20%2F%20197%20frontend-brightgreen)

---

## What it does

- **Validates** uploads (JPEG/PNG/WebP, 10 MB, real pixel decoding — not header sniffing)
- **Detects** objects with a local CPU YOLO model, or a SageMaker endpoint
- **Visualises** bounding boxes with confidence filtering and per-detection selection
- **Aggregates** category counts, confidence statistics, and a coarse occupancy estimate
- **Narrates** findings deterministically, or via Amazon Bedrock when enabled
- **Persists** every scan to SQLite (or DynamoDB) with search, pagination, and comparison

## What it deliberately does *not* do

The default model is a generic **COCO-80** detector. It sees `bottle`, `cup`,
`person` — not products. So VisionIQ reports, rather than guesses:

| Capability | Status | Why |
|---|---|---|
| SKU / product identity | `unsupported` | Needs a retail fine-tuned model or embedding index |
| Shelf-gap detection | `unsupported` | Needs planogram reference or empty-space annotations |
| Occupancy | `estimated` | Box-area heuristic; overlapping boxes inflate it |
| Stock levels / low-stock alerts | not implemented | Would require the above |

When no model is available, the result says *nothing was analysed* — never
"the shelf is empty". This is enforced in code and covered by tests.

---

## Phase 3.8 — unified API contract and cloud client integration

### Unified API contract

**FastAPI's successful response schemas are the canonical API contract.** Where
the FastAPI backend and the deployed Lambda control plane serve equivalent
resources, they now return **byte-identical shapes**, so a client can talk to
either without branching on the response format. The Lambda was changed to
match; FastAPI was not.

Two projection helpers in `infrastructure/terraform/lambda/api/handler.py` do
the work:

- `_record(item)` returns `item["payload"]` — a bare `AnalysisRecord`. The
  surrounding DynamoDB attributes (`payload`, `expires_at`) are storage
  internals and are dropped. `owner_id` legitimately survives, because it *is*
  an `AnalysisRecord` field.
- `_summary(item)` builds a bare `AnalysisSummary` from the item's promoted
  attributes, with defaults for items written by older code. `_SUMMARY_FIELDS`
  matches `AnalysisSummary.model_fields` exactly.

| Endpoint | Before (Lambda) | Now (canonical) |
|---|---|---|
| `POST /api/uploads/presign` | `{success, analysis_id, upload_url, object_key, expires_in, required_headers, max_bytes}` | `PresignResponse` — `{analysis_id, upload{url, key, expires_in, required_headers, max_bytes}}`; the `upload` dict mirrors `S3ImageStorage.presign_put` |
| `POST /api/jobs` (202) | `{success, analysis}` | bare `AnalysisRecord` |
| `GET /api/jobs/{id}` | `{success, analysis}` | bare `AnalysisRecord` |
| `GET /api/jobs` | `{success, analyses, count, next_cursor, has_more}` | bare `AnalysisPage` — `{items, next_cursor, has_more}` |
| `POST /api/jobs/{id}/cancel` | `{success, analysis}` | bare `AnalysisRecord` |
| `DELETE /api/jobs/{id}` | `204`, no body | **unchanged** |
| any error | `{success, error, detail}` | **unchanged** |

Two things were deliberately *not* touched: the **error envelope** already
matched on both sides, and **204 stays bodiless** (RFC 9110 forbids a body, and
some proxies mishandle one).

> **Rule:** any new or changed success response must have the same shape in
> FastAPI and in the Lambda for equivalent resources, and
> `backend/tests/test_cloud_contracts.py` must assert it **in the same commit**.

### Two API modes in the SPA

`frontend/src/api/config.ts` resolves the transport at build time, and
`frontend/src/api/analysisClient.ts` implements one `AnalysisClient` interface
twice. Because the shapes are identical, only the *choreography* differs:

```
local  POST /api/images/detect                      -> finished AnalysisRecord

cloud  POST /api/uploads/presign                    -> PresignResponse
       PUT  <presigned url>  (direct to S3)         -> 200, no API involved
       POST /api/jobs                               -> AnalysisRecord, 202 queued
       GET  /api/jobs/{id}   (polled)               -> AnalysisRecord, terminal
```

Terminal states are `completed`, `failed`, `cancelled`; a job that is already
terminal on creation is never polled. Transient poll failures are retried up to
**5** times, but `401`/`403`/`404` are never retried — those are definitive
answers. A poll timeout reports that the job *may still finish* and to check the
scan history; **it does not cancel the job.** `AbortSignal` cancellation is
supported throughout, and the progress callback reports
`uploading → queued → processing → done`.

Cloud mode **fails closed**: with no access token in memory, `analyze()` throws
"You are not signed in" immediately rather than producing a confusing `401`
three steps later. And the S3 `PUT` sends **only the signed headers and never an
`Authorization` header** — the presigned signature is the credential, and a
bearer token there would leak it to the storage endpoint. A test asserts this.

| Variable | Default | Notes |
|---|---|---|
| `VITE_API_MODE` | `local` | `local` or `cloud`; an unrecognised value falls back to `local` |
| `VITE_API_BASE_URL` | `''` | Empty means same-origin relative `/api` paths. A trailing slash is stripped |
| `VITE_JOB_POLL_INTERVAL_MS` | `2000` | Milliseconds between `GET /api/jobs/{id}` polls |
| `VITE_JOB_POLL_TIMEOUT_MS` | `300000` | 5 minutes, then give up polling (the job is **not** cancelled) |

### Two real bugs found by the new tests

| # | Bug | Consequence | Fix |
|---|---|---|---|
| 1 | **`request()` ignored the passed config.** It resolved the base URL from `import.meta.env` rather than the `ApiConfig` handed to it by the cloud client | In cloud mode with a configured gateway, every call would have gone **same-origin** instead — silently, with no error at the call site | `request()` now takes an optional `config` and routes through `apiUrl()`; `config` is threaded through all three cloud call sites |
| 2 | **`tsc` TS1294.** A constructor parameter property is not allowed under `erasableSyntaxOnly`, which this `tsconfig` sets | The build did not compile | The field is declared explicitly and assigned in the constructor body |

---

## Phase 3.7 — final pre-deployment hardening

### Three integration bugs that would have broken every cloud job

The local path was green the whole time. The *cloud* path — Lambda API →
DynamoDB → SQS → Fargate worker → S3 — was broken end to end, because the two
halves were written separately and only ever meet in a deployed AWS account.
Nothing in the local suite exercised the seam. All three are fixed, and all
three now have executable contract tests.

| # | Bug | Consequence if deployed | Fix |
|---|---|---|---|
| 1 | **DynamoDB item shape.** `lambda/api/handler.py` wrote a flat item (`owner_id`, `analysis_id`, `created_at`, `status`, `object_key`, `expires_at`). `backend/app/repositories/dynamo_repo.py::_record` does `AnalysisRecord.model_validate(item["payload"])` | `KeyError: 'payload'` in the worker on **every** job; every message redriven to the DLQ | `_queued_item()` emits the promoted query attributes **plus** a `payload` attribute holding the full `AnalysisRecord` JSON |
| 2 | **SQS field name.** The Lambda sent `object_key`; `backend/app/cloud/jobs.py::enqueue` sends `image_key` | Two producers, one consumer, two incompatible message bodies | Both now emit exactly `{analysis_id, owner_id, image_key}` |
| 3 | **Three storage key conventions.** Lambda built `uploads/{owner}/{id}` (no extension); `build_key` built `{owner}/{id}.{ext}` (no prefix); the worker's IAM policy grants `s3:GetObject` on `uploads/*` only | The backend's own keys were **unreadable by the worker** — `AccessDenied`, not a 404 | One convention everywhere: `{prefix}{owner_id}/{analysis_id}.{ext}`, e.g. `uploads/alice/abc123.jpg` |

The key prefix is now configuration on both sides: `VISIONIQ_UPLOAD_PREFIX`
(default `uploads/`) in `backend/app/config.py`, `UPLOAD_PREFIX` in the Lambda,
and the Terraform `upload_prefix` variable that scopes the IAM grants.
`build_key()` and `assert_owned()` take an optional `prefix` argument so the
contract can be asserted against a fixed value in tests.

**`backend/tests/test_cloud_contracts.py`** encodes the seam (47 tests then;
**62** after Phase 3.8). It
imports the real Lambda module with its environment stubbed and its boto3
clients mocked — no AWS call, no credentials — and asserts that the item the
Lambda writes parses as an `AnalysisRecord`, that the keys the two
implementations build are byte-identical, that both reject the same hostile
keys, that the SQS body matches what `worker.process_message` requires, that
the error envelopes agree, that identity comes only from the JWT, and that
pagination cursors round-trip and reject another tenant's values.

> **Rule:** these three shapes are cross-component contracts. Changing one side
> means changing the other side *and* `test_cloud_contracts.py` in the same
> commit. See [`CLAUDE.md`](CLAUDE.md) § Cross-component contracts.

### The cloud API is now complete

`POST /api/jobs/{id}/cancel` and `DELETE /api/jobs/{id}` are implemented, and
the existing handlers were hardened: keyset pagination with a cursor matching
`dynamo_repo`'s format (and rejecting another tenant's), `limit` validation
(1–100; a non-numeric `limit` is now a `400` rather than a `500`), server-side
`head_object` verification on create (existence, size, content type — the
object is deleted and `413`/`400` returned on failure), idempotent create via
`ConditionExpression="attribute_not_exists(analysis_id)"`, analysis-id format
validation, base64 body handling, `ClientError` mapped to `503` instead of a
stack trace, an identical `404` for missing and cross-tenant records, and
`x-content-type-options: nosniff` + `cache-control: no-store` on every
response. See [`docs/api/README.md`](docs/api/README.md).

### Content Security Policy

`frontend/src/security/csp.ts` is the single source of truth (`buildCsp`,
`securityHeaders`). `vite.config.ts` serves the relaxed policy on the dev
server and the **strict** policy on `vite preview`; production delivery is
CloudFront's response-headers policy in
`infrastructure/terraform/modules/frontend/`.

Measured against the real production bundle (`vite preview` on `:4175`): zero
inline `<script>` blocks, one external module script from `'self'`, and zero
`eval(` / `new Function(` — so `script-src 'self'` with no unsafe directives
holds. The honest exception is `style-src 'unsafe-inline'`, required by four
runtime-computed `style={{}}` props (the progress bar in `App.tsx`, category
colours in `DetectionPanel.tsx`); removing it needs per-request nonces, which
CloudFront cannot generate for a static origin. Inline *style* cannot execute
JavaScript. Full reasoning in
[`docs/security/threat-model.md`](docs/security/threat-model.md).

### Cognito reliability

A redirect-loop guard (`MAX_SILENT_ATTEMPTS = 2`, counted in `sessionStorage`)
stops a provider that returns neither a code nor an error from redirecting on
every page load forever. Blocked browser storage is detected (`storageAvailable()`
plus a verified write in `stashFlow`, because some browsers accept a write and
then drop it) and produces an actionable message instead of a redirect into a
flow that cannot complete. The auth screens gained `role="alert"` on the failure
and misconfiguration states and `role="status" aria-live="polite"` on loading
and session-expired. **JWT validation was not weakened** — `backend/app/auth/`
is unchanged.

---

## Quick start (local, no AWS)

> **One supported environment: `backend/.venv` (64-bit Python 3.10).**
> This project previously carried a second 32-bit Python 3.11 venv. It has been
> removed: a 32-bit interpreter can run neither PyTorch nor `cryptography`
> (no 32-bit wheels, and a source build dies in the Rust linker), so it could
> do neither inference nor JWT verification. **64-bit Python is required.**
> Because the supported interpreter is **3.10**, no Python 3.11-only
> constructs (`datetime.UTC`, `enum.StrEnum`) may be used — `ruff.toml` pins
> `target-version = "py310"` to enforce this.

**Backend:**
```bash
cd backend
.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8080
```

**Frontend:**
```bash
cd frontend
npm install
npm run dev     # http://localhost:5175, proxies /api -> 127.0.0.1:8080
```

Open http://localhost:5175 and drop in a shelf photo.

### Setting up `.venv` from scratch

```bash
cd backend
<path-to-64bit-python-3.10> -m venv .venv
.venv\Scripts\python.exe -m pip install --index-url https://download.pytorch.org/whl/cpu torch==2.14.1+cpu torchvision==0.29.1+cpu
.venv\Scripts\python.exe -m pip install -r requirements-dev.txt -r requirements-ml.txt
.venv\Scripts\python.exe scripts\smoke_inference.py    # verify
```

`requirements.txt` is installable on its own into a clean 64-bit venv (3.10 or
3.11) and passes the suite without torch; `requirements-ml.txt` adds inference.

---

## Authentication

Selected by `VISIONIQ_AUTH_MODE`. **The owner id comes only from verified token
claims** — there is no code path that reads it from a header, query parameter or
body.

| Mode | Who verifies the token | Owner id | Use |
|---|---|---|---|
| `none` *(default)* | nobody — auth is off | pseudo-tenant `local` | Local development, no AWS account |
| `apigateway` | API Gateway's Cognito JWT authorizer, before the request reaches the app | `sub` from `requestContext.authorizer.jwt.claims` | Deployed behind the HTTP API |
| `jwt` | this process, via JWKS + RS256 | `sub` from the verified token | FastAPI exposed directly, or testing against a real pool |

Run locally with auth off — this is the default, so nothing to set:

```bash
cd backend
.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8080
```

Cloud mode needs a Cognito user pool and these variables:

```bash
VISIONIQ_AUTH_MODE=apigateway       # or jwt
VISIONIQ_JWT_ISSUER=https://cognito-idp.<region>.amazonaws.com/<user-pool-id>
VISIONIQ_JWT_AUDIENCE=<cognito-app-client-id>
# optional: VISIONIQ_JWKS_URL, VISIONIQ_JWT_LEEWAY, VISIONIQ_JWT_TOKEN_USE,
#           VISIONIQ_JWKS_CACHE_TTL
```

In `jwt` mode the verifier enforces an RS256/384/512 allow-list (`alg: none` and
any HS\* algorithm are rejected outright — that is the classic
algorithm-confusion forgery), checks the signature against the JWKS key matching
the token's `kid`, validates `exp`/`iat`/`nbf` with a small leeway, requires an
exact `iss` match, checks `aud` (id tokens) or `client_id` (Cognito access
tokens), requires `token_use` to match, and requires a non-empty `sub`. JWKS keys
are cached with a TTL and an unknown `kid` triggers at most one refetch per 60 s,
so junk tokens cannot amplify into a flood of outbound requests.

Bad credentials get `401` with `WWW-Authenticate: Bearer`; a **misconfiguration
fails closed with `503`**, never with anonymous access. Cross-tenant reads return
**404, not 403**, so existence is not disclosed.

### Frontend sign-in (`frontend/src/auth/`)

The SPA implements the **OAuth 2.0 authorization code flow with PKCE (S256)**
against the Cognito hosted UI, by hand — no Amplify. Terraform pins
`allowed_oauth_flows = ["code"]` and `generate_secret = false`, so the app
client is a *public* client and PKCE is what replaces the absent secret.

```
  dashboard load, no callback params
        │
        ▼
  GET  {domain}/oauth2/authorize?response_type=code&code_challenge_method=S256
        &prompt=none            ← silent attempt against Cognito's session cookie
        │
        ├─ Cognito has a session  → redirect back with ?code=…&state=…
        └─ no session             → redirect back with ?error=login_required
                                     (treated as "signed out", not an error)
        │
        ▼  (user clicks Sign in → same URL without prompt=none → hosted UI)
  callback: state compared with the stashed value BEFORE anything else
        │
        ▼
  POST {domain}/oauth2/token   grant_type=authorization_code, code_verifier, no secret
        │
        ▼
  access token → module-scoped variable in auth/session.ts, and nowhere else
  code/state scrubbed from the address bar via history.replaceState
```

Design decisions worth knowing before you change anything here:

| Decision | Why |
|---|---|
| Code flow, never implicit | The implicit flow returns the token in the URL fragment, where it leaks through history, referrers and extensions |
| **No refresh token ever enters the browser** | `exchangeCodeForTokens` never reads `payload.refresh_token`. It is long-lived (Terraform default **30 days**) and every SPA-reachable store is JS-readable, so one XSS would buy a month of access. A test asserts it appears neither on the returned object nor in `localStorage`/`sessionStorage` |
| Session continuity via `prompt=none` | Silent re-authentication against Cognito's *own* session cookie, instead of a refresh token |
| Access token in memory only | A module-scoped variable in `auth/session.ts`. A page reload therefore starts with no token — by design; the app then tries a silent re-auth |
| PKCE verifier/state in `sessionStorage` | They must survive the redirect. A verifier is **not a credential**: single-use, worthless without the matching code, scoped to one tab, and deleted on exchange (`consumeFlow` always clears) |
| `state` validated before exchange | Per-request, stashed, compared with `statesMatch` (length-checked, constant-time-ish XOR). A mismatch aborts *before* the code is redeemed — a test asserts `fetch` is never called |
| Callback params scrubbed | `history.replaceState` removes `code`/`state`/`error` so they do not linger in browser history |
| Logout hits the hosted-UI `/logout` | Clears Cognito's session cookie too; otherwise silent re-auth would immediately undo the sign-out |
| Expiry with 60 s skew | `EXPIRY_SKEW_MS = 60_000`. A timer moves the app to `expired` one minute early, and `getAccessToken()` returns `null` past that point, so an expired token is never sent |

The token the SPA sends is the **access token**, because the backend's
`VISIONIQ_JWT_TOKEN_USE` defaults to `access`. A Cognito access token carries
`client_id` rather than `aud`, which is what the verifier compares against
`VISIONIQ_JWT_AUDIENCE`. `client.ts` attaches `Authorization: Bearer` to both
`fetch` calls and XHR uploads, and exposes `onUnauthorized(listener)` — a `401`
from either transport moves the provider to `expired`.

**Not implemented: a backend-for-frontend.** The documented upgrade path for
persistent sessions is a BFF holding the refresh token in an `HttpOnly`,
`Secure`, `SameSite` cookie with CSRF protection. It is not built, because the
deployed API is API Gateway + Lambda with a JWT authorizer that expects a
bearer token, not a same-origin cookie backend. The honest cost of the current
design: **closing the browser — or Cognito's session expiring — requires a
fresh interactive sign-in.**

#### Frontend modes and variables

`resolveAuthConfig(env, isProd, origin)` resolves one of three modes. Dev
defaults to `local`; a production build defaults to `cognito`.

| `VITE_AUTH_MODE` | Behaviour | Pair with |
|---|---|---|
| `local` *(dev default)* | Auth bypassed, user is the pseudo-tenant `local`, the dashboard shows an "auth off (local)" pill | `VISIONIQ_AUTH_MODE=none` |
| `cognito` *(prod default)* | Hosted-UI code flow with PKCE | `VISIONIQ_AUTH_MODE=apigateway` (deployed) or `jwt` (direct uvicorn) |
| `misconfigured` | Not selectable — the fail-closed result. The app renders a hard configuration error and never a dashboard | — |

**It fails closed.** `resolveAuthConfig` returns `misconfigured` when a
*production* build is given `VITE_AUTH_MODE=local`, when
`VITE_COGNITO_DOMAIN` or `VITE_COGNITO_CLIENT_ID` is missing, when the mode is
unknown, or when the redirect URI is `http://` in production.

| Variable | Required | Notes |
|---|---|---|
| `VITE_AUTH_MODE` | no | `local` or `cognito`; dev defaults to `local`, prod to `cognito` |
| `VITE_COGNITO_DOMAIN` | cognito mode | Bare domain or full URL; normalised to an `https` origin |
| `VITE_COGNITO_CLIENT_ID` | cognito mode | **Must equal the backend's `VISIONIQ_JWT_AUDIENCE`.** Public, not a secret |
| `VITE_COGNITO_ISSUER` | no | Must equal the backend's `VISIONIQ_JWT_ISSUER` |
| `VITE_COGNITO_SCOPES` | no | Defaults to `openid email profile` |
| `VITE_COGNITO_REDIRECT_URI` | no | Defaults to `window.location.origin`. Must be the **bare origin with no path** — Terraform registers `http://localhost:5175` and `http://127.0.0.1:5175` for dev and Cognito requires an exact match |

Every `VITE_*` value is embedded in the built JavaScript and is public. See
[`frontend/.env.example`](frontend/.env.example).

For local development the default pairing needs no configuration at all:
`VISIONIQ_AUTH_MODE` unset (`none`) on the backend, `VITE_AUTH_MODE=local` on
the frontend.

`GET /api/system/status` is reachable before sign-in, so once auth is enabled it
stops reporting `storage_backend`, `repository_backend` and `insights_provider`
and gives only a generic model-unavailable reason.

See [`docs/deployment/local.md`](docs/deployment/local.md) §8 for every variable
and [`docs/deployment/aws.md`](docs/deployment/aws.md) for the Cognito runbook.

---

## Verification

Measured on this machine:

| Suite | Environment | Result |
|---|---|---|
| Backend | `.venv` (Python 3.10, 64-bit) | **231 passed** — was 216 before Phase 3.8 |
| Backend | `ruff check . --config ruff.toml` | *All checks passed* |
| Backend | former 32-bit venv, before removal | **124 passed, 1 skipped** — the whole auth module skipped |
| Frontend | node | **197 passed across 12 files** — was 169 across 11 before Phase 3.8 |
| Frontend | `npm run lint` / `tsc --noEmit` / `vite build` | clean, no suppressions; build **256.27 kB** JS (**79.74 kB** gzip) |
| Lambda | `python -m py_compile` on `lambda/api/handler.py` | OK |
| Terraform | `fmt -recursive` / `init -backend=false` / `validate` | clean; *"Success! The configuration is valid."* |

Phase 3.7 added `backend/tests/test_cloud_contracts.py`, which accounts for most
of the backend increase to 216. Phase 3.8 grew that file to **62 tests** with
canonical-contract assertions, and added
`frontend/src/api/analysisClient.test.ts` (**28 tests**), which is the whole of
the frontend increase. Each of the two bugs above was found by one of those new
tests, not by review.

```
backend  python -m pytest tests/test_cloud_contracts.py -q   # 62 passed
frontend npx vitest run src/api/analysisClient.test.ts       # 28 passed
```

**Live local verification (Phase 3.6):** backend on `:8080` with
`VISIONIQ_AUTH_MODE=none` plus the Vite dev server on `:5175` — `/` served
`200`, `/api/system/status` through the proxy reported `auth_mode: none`,
`/api/analyses` returned `200`, and `POST /api/images/detect` returned 6 real
YOLO detections with `owner_id: local`.

**Not verified against a live Cognito pool.** Nothing is deployed and there are
no AWS credentials on this machine. Every Cognito interaction is covered by
unit and integration tests with a stubbed `fetch` and a stubbed
`window.location` — never by a real sign-in.

**Live local verification (Phase 3.8):** backend on `:8080` —
`POST /api/images/detect` returned 6 real YOLO detections with
`image_key = uploads/local/{id}.jpg`, and the response was asserted to be a
**bare `AnalysisRecord`** with no `success`/`analysis` wrapper;
`GET /api/analyses` was asserted to have exactly the keys
`{items, next_cursor, has_more}`.

**What Phase 3.8 could not verify here:** no Docker, no AWS credentials, no
live Cognito. `terraform plan` was never run. The Lambda has never executed
against real AWS — the contract tests import it with boto3 mocked, so the
**cloud choreography is proven only by unit tests with a stubbed `fetch`/XHR**.
The CSP was measured against the real production bundle served by
`vite preview`, but not behind CloudFront.

```bash
# Backend — inference mocked, no weight downloads
cd backend && .venv\Scripts\python.exe -m pytest -q
.venv\Scripts\python.exe -m ruff check . --config ruff.toml

# Frontend
cd frontend && npm run lint && npm run typecheck && npm test && npm run build

# Real inference (downloads ~6 MB of weights on first run)
cd backend && .venv\Scripts\python.exe scripts\smoke_inference.py

# Infrastructure (no AWS calls, no apply)
cd infrastructure/terraform
terraform fmt -check -recursive && terraform init -backend=false && terraform validate
```

`terraform plan` has **not** been run — there are no AWS credentials on this
machine. CI tests both Python **3.10 and 3.11**, x64 only, installing
`requirements-dev.txt`.

**Docker is not installed on this machine, so the worker image has never been
built.** `backend/Dockerfile` and `backend/.dockerignore` are written and
reviewed, but unexecuted.

---

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/images/analyze` | Validate an image, return metadata (Phase 1, no inference) |
| `POST` | `/api/images/detect` | Validate + detect + aggregate + persist |
| `GET` | `/api/analyses` | List scans — paginated, searchable, filterable |
| `GET` | `/api/analyses/{id}` | Full analysis record |
| `DELETE` | `/api/analyses/{id}` | Delete a scan and its stored image |
| `GET` | `/api/analyses/{a}/compare/{b}` | Category-count delta between two scans |
| `POST` | `/api/uploads/presign` | Short-lived presigned S3 PUT (cloud mode) |
| `POST` | `/api/jobs` | Queue an async analysis (cloud mode) |
| `GET` | `/api/jobs/{id}` | Poll job status |
| `GET` | `/api/jobs` | List this owner's jobs, keyset-paginated (cloud mode) |
| `POST` | `/api/jobs/{id}/cancel` | Cancel a job no worker has claimed — `409` otherwise (cloud mode) |
| `DELETE` | `/api/jobs/{id}` | Delete a job record and best-effort its image (cloud mode) |
| `GET` | `/api/system/status` | Execution mode and model availability |

Interactive docs at `http://127.0.0.1:8080/docs`.
Full reference: [`docs/api/README.md`](docs/api/README.md).

---

## Architecture

```
Local:  browser → Vite proxy → FastAPI → YOLO (CPU) → SQLite + filesystem

Cloud:  browser → Cognito hosted UI (code flow + PKCE) → access token (in memory)
                → API Gateway (JWT authorizer, all six routes)
                → presigned PUT → S3 (private, uploads/{owner}/{id}.{ext})
                → POST /api/jobs → head_object verify → DynamoDB(queued) + SQS
                → ECS Fargate worker → inference → DynamoDB(completed)
                → browser polls GET /api/jobs/{id}

SPA delivery: S3 (private, OAC) → CloudFront → response-headers policy (CSP, HSTS, …)
```

Inference runs on **Fargate, not Lambda** — the torch image is far past Lambda's
limits and CPU cold starts are unacceptable for a queue worker.

Every pluggable concern sits behind a `Protocol` with an env-selected factory:

| Concern | Options | Env var |
|---|---|---|
| Detection | `yolo`, `sagemaker`, `null` | `VISIONIQ_DETECTION_PROVIDER` |
| Persistence | `sqlite`, `dynamodb` | `VISIONIQ_REPOSITORY` |
| Image storage | `local`, `s3` | `VISIONIQ_STORAGE` |
| Insights | `rules`, `bedrock` | `VISIONIQ_INSIGHTS_PROVIDER` |
| Authentication | `none`, `apigateway`, `jwt` | `VISIONIQ_AUTH_MODE` |

See [`docs/architecture/overview.md`](docs/architecture/overview.md) and
[`.env.example`](.env.example) for every setting.

---

## Model & licensing

Default: **YOLOv8n** via Ultralytics, CPU, COCO-80 classes.

> ⚠️ **Ultralytics YOLOv8 and its weights are AGPL-3.0.** Serving them over a
> network obliges you to release your source under a compatible licence, or to
> buy an Ultralytics Enterprise Licence. For closed commercial use, swap in a
> permissively licensed model or a SageMaker endpoint —
> see [`docs/architecture/models.md`](docs/architecture/models.md).

Measured on this machine (CPU): ~18 s first call including weight download,
~2.9–7.5 s warm inference on an 810×1080 image.

---

## Cloud deployment

**Nothing has been deployed.** `terraform apply` has never been run, and neither
has `terraform plan` — there are no AWS credentials on this machine. The worker
image has never been built, because Docker is not installed here. The
infrastructure is written and `terraform validate` passes; it needs AWS
credentials and your explicit approval.

See [`docs/deployment/aws.md`](docs/deployment/aws.md) for the runbook,
[`docs/cost/README.md`](docs/cost/README.md) for what bills while idle, and
[`infrastructure/terraform/README.md`](infrastructure/terraform/README.md) for
the full cost table (~$1.50/mo idle for dev) and known gaps.

---

## Documentation

| Document | Contents |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Conventions, layout, the honesty rule |
| [`docs/architecture/overview.md`](docs/architecture/overview.md) | System design, both execution paths |
| [`docs/architecture/models.md`](docs/architecture/models.md) | Model choice, licensing, limitations |
| [`docs/api/README.md`](docs/api/README.md) | Full endpoint reference |
| [`docs/deployment/local.md`](docs/deployment/local.md) | Local setup, env vars |
| [`docs/deployment/aws.md`](docs/deployment/aws.md) | Cloud runbook, Cognito setup |
| [`docs/cost/README.md`](docs/cost/README.md) | Idle vs. per-use costs, teardown |
| [`docs/security/threat-model.md`](docs/security/threat-model.md) | Threat model and assumptions |

## Licence

Application code: choose your own. **Note the AGPL-3.0 obligation inherited from
Ultralytics** if you ship the default model — see the model docs above.
