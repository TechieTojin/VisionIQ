# Local Development Setup

Windows, PowerShell. No AWS account required — the default configuration is
SQLite + the local filesystem + the rule-based insights provider.

---

## 1. One virtualenv: `backend\.venv`

The repo used to carry two virtualenvs. That is **resolved**: everything now
runs in `backend\.venv` — **Python 3.10, 64-bit**.

| Virtualenv | Python | Status |
|---|---|---|
| `backend\.venv` | **3.10, 64-bit** | **The only venv.** API, full test suite, ruff, real inference. |

The former 32-bit Python 3.11 venv has been **deleted**. 64-bit Python is now
a hard requirement.

### Why the 32-bit venv was removed

A 32-bit Windows interpreter cannot install **either** of the two things this
project now needs:

- **PyTorch** publishes no 32-bit Windows wheels, and Ultralytics depends on
  torch — so there has never been local inference there.
- **`cryptography`**, pulled in by `PyJWT[crypto]` for RS256 signature
  verification, also publishes no 32-bit wheels, and the source build fails in
  the Rust linker.

Without `cryptography` the entire auth module is unimportable, so the whole
`tests\test_auth.py` module **skips**. Measured:

| Environment | Result |
|---|---|
| `.venv` (3.10, 64-bit) | **232 passed** |
| Clean venv, `requirements-dev.txt` only (no torch) | **164 passed** |
| Former 32-bit venv (3.11), before removal | **124 passed, 1 skipped** (auth module skipped wholesale) |

The floor is Python **3.10**, so no 3.11-only constructs (`datetime.UTC`,
`enum.StrEnum`); `ruff.toml` pins `target-version = "py310"`. CI runs the suite
on both **3.10 and 3.11**, `architecture: x64`, installing
`requirements-dev.txt`.

`requirements.txt` was previously not installable on its own target — it pinned
`pillow==13.0.0`, which requires Python >= 3.11. It is now `pillow==12.3.0`,
`fastapi==0.159.1` and `PyJWT[crypto]==2.12.1`, verified to install into a clean
venv and pass the suite.

The honest-failure design is unchanged: `YoloProvider.warmup()` catches
`ImportError` and `OSError` and raises `ProviderUnavailable`, which surfaces as
`detection.status = "unavailable"` with zero detections and an explicit caveat
that zero means *nothing was analysed*, not *the shelf is empty*. CI relies on
this: `backend-ci.yml` sets `VISIONIQ_DETECTION_PROVIDER: "null"` and never
installs `requirements-ml.txt`, so the suite is hermetic and never downloads
weights.

> `.gitignore` ignores `backend/.venv/` but **not** `backend/.venv/`. Do not
> commit it.

---

## 2. Setting up `backend\.venv` from scratch

```powershell
cd backend

<path-to-64bit-python-3.10>\python.exe -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip

# CPU-only torch FIRST, from the CPU index — otherwise pip pulls ~2 GB of CUDA.
pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision

# API + test tooling, then inference extras.
pip install -r requirements-dev.txt     # pulls in requirements.txt
pip install -r requirements-ml.txt
```

Verify the interpreter, the bitness, and that **both** blockers are gone:

```powershell
.venv\Scripts\python.exe -c "import struct,sys,torch,ultralytics,jwt; from cryptography.hazmat.primitives.asymmetric import rsa; print(sys.version); print(struct.calcsize('P')*8,'bit'); print('torch',torch.__version__); print('ultralytics',ultralytics.__version__); print('pyjwt',jwt.__version__)"
```

If `import jwt` or the `cryptography` import fails, you are on a 32-bit
interpreter — auth verification will not work and `test_auth.py` will skip.

### Running without inference

You do not need torch to work on the API. A venv built from
`requirements-dev.txt` alone passes **164** tests; the two it does not run are
the ones that need the real provider. Detection then reports
`status: "unavailable"`.

---

## 3. Docker

**Docker is not installed on this machine, so the worker image has never been
built.** `backend/Dockerfile` and `backend/.dockerignore` exist and have been
reviewed, but no `docker build` has ever run from this repo. Treat the build
instructions in `docs/deployment/aws.md` §4 as unexecuted.

`backend/.dockerignore` was added in this phase; without it the build context
would have included both virtualenvs and the local SQLite database.

**Licensing:** `requirements-ml.txt` installs Ultralytics, which is AGPL-3.0,
as are the `yolov8n.pt` weights. That is fine for local development. It is
**not** fine for a closed-source network deployment — read
`docs/architecture/models.md` §2 first.

---

## 4. Running the backend

```powershell
cd backend
.venv\Scripts\Activate.ps1
uvicorn app.main:app --reload --port 8080
```

**Use port 8080.** Port 8000 previously failed to bind on this machine, and the
Vite proxy is hardcoded to `http://127.0.0.1:8080`. Start the backend *before*
the frontend so the proxy resolves.

- API: <http://127.0.0.1:8080>
- Swagger UI: <http://127.0.0.1:8080/docs>
- Liveness: <http://127.0.0.1:8080/health>

Auth is **off by default** (`VISIONIQ_AUTH_MODE=none`) — every request is the
pseudo-tenant `local` and no `Authorization` header is read. See §8a to turn it
on.

Be aware: the first `/api/images/detect` or `/api/system/status` call then pays
the cold model load (~18 s on this machine, including the weight download), and
a warm CPU inference on an 810×1080 image took ~7.5 s. Expect a slow first
click.

Logs are single-line JSON on stdout with a `correlation_id` on every line;
uvicorn's own access log is silenced to avoid duplication.

---

## 5. Running the frontend

```powershell
cd frontend
npm install
npm run dev
```

- Dev server: <http://localhost:5175>
- `vite.config.ts` proxies `/api` → `http://127.0.0.1:8080` with
  `changeOrigin: true`.
- The client only ever uses **relative** `/api/...` paths; never hardcode a host.
- The backend's CORS allow-list already covers `localhost`/`127.0.0.1` on 5173,
  5174 and 5175 (`VISIONIQ_CORS_ORIGINS` overrides it entirely with a
  comma-separated list).

Other scripts:

```powershell
npm run lint
npm run typecheck
npm test           # 219 passed across 13 files
npm run build      # tsc -b && vite build
```

### 5a. Frontend authentication modes

The SPA resolves its auth mode at **build time** from `VITE_*` variables
(`frontend/src/auth/config.ts`). Copy the reference file and edit it:

```powershell
cd frontend
copy .env.example .env.local
```

Every `VITE_*` value is embedded in the built JavaScript and is **public**.
Nothing secret goes here — the Cognito app client is intentionally a public
client (`generate_secret = false`), which is why the flow uses PKCE.

#### Mode 1 — `local` (the dev default, no AWS)

Nothing to configure. With no `.env.local` at all, a dev build defaults to
`local`: authentication is bypassed, the user is the pseudo-tenant `local`, and
the dashboard header shows an **"auth off (local)"** pill.

```powershell
# terminal 1
cd backend; .venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8080
# terminal 2
cd frontend; npm run dev
```

#### Mode 2 — `cognito` against a real pool

Requires a deployed user pool. Run the backend in `jwt` mode so it verifies the
token itself (there is no API Gateway in front of a local uvicorn).

```dotenv
# frontend/.env.local
VITE_AUTH_MODE=cognito
VITE_COGNITO_DOMAIN=visioniq-dev-ab12cd34.auth.us-east-1.amazoncognito.com
VITE_COGNITO_CLIENT_ID=<app client id>
VITE_COGNITO_ISSUER=https://cognito-idp.us-east-1.amazonaws.com/<user-pool-id>
```

```powershell
# backend, same terminal session
$env:VISIONIQ_AUTH_MODE  = "jwt"
$env:VISIONIQ_JWT_ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/<user-pool-id>"
$env:VISIONIQ_JWT_AUDIENCE = "<app client id>"   # must equal VITE_COGNITO_CLIENT_ID
.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8080
```

Terraform's `dev.tfvars` registers exactly `http://localhost:5175` and
`http://127.0.0.1:5175` as callback *and* logout URLs, so browse to one of
those two origins — not `127.0.0.1` if you registered `localhost` only, and
never with a path appended.

#### Mode 3 — `misconfigured` (not selectable; the fail-closed result)

`resolveAuthConfig` returns `misconfigured` and the app renders a hard
configuration error instead of a dashboard when:

- a **production** build has `VITE_AUTH_MODE=local`;
- `VITE_COGNITO_DOMAIN` or `VITE_COGNITO_CLIENT_ID` is missing in cognito mode;
- `VITE_AUTH_MODE` is anything other than `local` or `cognito`;
- the redirect URI starts with `http://` in a production build.

This is intentional: a local bypass shipped to production would authenticate
every visitor as the same tenant.

#### Frontend variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `VITE_AUTH_MODE` | no | `local` in dev, `cognito` in a production build | Only `local` or `cognito`; anything else is `misconfigured` |
| `VITE_COGNITO_DOMAIN` | cognito mode | — | Bare domain or full URL; normalised to an `https` origin with no trailing slash |
| `VITE_COGNITO_CLIENT_ID` | cognito mode | — | **Must equal the backend's `VISIONIQ_JWT_AUDIENCE`.** Public, not a secret |
| `VITE_COGNITO_ISSUER` | no | `''` | Must equal the backend's `VISIONIQ_JWT_ISSUER` |
| `VITE_COGNITO_SCOPES` | no | `openid email profile` | Space-separated; must be a subset of Terraform's `allowed_oauth_scopes` |
| `VITE_COGNITO_REDIRECT_URI` | no | `window.location.origin` | **Bare origin, no path.** Cognito requires an exact match. Must be `https` in a production build |
| `VITE_API_MODE` | no | `local` | `local` (one synchronous `POST /api/images/detect`) or `cloud` (presign → S3 PUT → create job → poll). **An unrecognised value falls back to `local`** |
| `VITE_API_BASE_URL` | no | `''` | API origin. Empty means same-origin relative `/api` paths, which the Vite dev proxy forwards to `127.0.0.1:8080`. A trailing slash is stripped |
| `VITE_JOB_POLL_INTERVAL_MS` | no | `2000` | Cloud mode only: milliseconds between `GET /api/jobs/{id}` polls. Non-numeric or non-positive → the default |
| `VITE_JOB_POLL_TIMEOUT_MS` | no | `300000` | Cloud mode only: 5 minutes, then stop polling. **This does not cancel the job** — it may still finish and appear in the scan history |

#### API transport modes

Resolved at build time by `resolveApiConfig` (`frontend/src/api/config.ts`) and
acted on by `frontend/src/api/analysisClient.ts`. Both modes parse **identical
response shapes** — only the number of round trips differs.

| `VITE_API_MODE` | Choreography | Needs |
|---|---|---|
| `local` *(default)* | `POST /api/images/detect` → finished `AnalysisRecord` | the FastAPI backend on `:8080` |
| `cloud` | `POST /api/uploads/presign` → `PUT` direct to S3 → `POST /api/jobs` (202) → poll `GET /api/jobs/{id}` | a deployed API Gateway **and** a signed-in user |

Cloud mode **fails closed**: with no access token it raises "You are not signed
in" before the first request, instead of a confusing `401` three steps later.
So `VITE_API_MODE=cloud` with `VITE_AUTH_MODE=local` cannot work — pair cloud
transport with `VITE_AUTH_MODE=cognito`.

#### Pointing a local SPA at a deployed API

Useful for working on the UI against real cloud data without building and
uploading the bundle. The API Gateway's `allowed_origins` must include your dev
origin, or the browser blocks the call before it leaves.

```dotenv
# frontend/.env.local
VITE_API_MODE=cloud
VITE_API_BASE_URL=https://abc123.execute-api.us-east-1.amazonaws.com
VITE_AUTH_MODE=cognito
VITE_COGNITO_DOMAIN=visioniq-dev-ab12cd34.auth.us-east-1.amazoncognito.com
VITE_COGNITO_CLIENT_ID=<app client id>
VITE_COGNITO_ISSUER=https://cognito-idp.us-east-1.amazonaws.com/<user-pool-id>
```

```powershell
cd frontend; npm run dev     # :5175 — no local backend needed in this mode
```

Read the gateway URL from Terraform rather than copying it by hand:

```bash
cd infrastructure/terraform && terraform output -raw api_endpoint
```

With `VITE_API_BASE_URL` set, calls bypass the Vite dev proxy entirely and go
straight to the gateway — so a running local backend is irrelevant in cloud
mode, and browsing to `localhost:5175` must still be a Cognito callback URL
Terraform registered.

#### Backend / frontend mode pairing

| `VITE_AUTH_MODE` | `VISIONIQ_AUTH_MODE` | When |
|---|---|---|
| `local` | `none` | Local development, no AWS account. Owner is `local` |
| `cognito` | `jwt` | Local uvicorn against a real pool — this process verifies via JWKS |
| `cognito` | `apigateway` | Deployed behind the HTTP API; the gateway's authorizer verifies |
| `cognito` | `none` | **Mismatch.** The SPA signs in, the backend ignores the token and files everything under `local` |
| `local` | `jwt` / `apigateway` | **Mismatch.** The SPA sends no token; every call is `401` |

#### What to expect from the flow

On load with no callback parameters, the SPA silently redirects to
`/oauth2/authorize?...&prompt=none`. If Cognito's session cookie is present it
returns a code with no interaction; otherwise it returns
`error=login_required`, which is treated as simply "signed out" and shows the
login screen. The access token is held **in memory only** — a page reload
therefore starts with no token and re-runs the silent attempt. There is no
refresh token in the browser by design.

---

## 6. Running the tests

Always from `backend\`, with `.venv` — the suite mocks inference and never
downloads weights.

```powershell
cd backend
.venv\Scripts\Activate.ps1

python -m pytest                       # whole suite — 232 passed
python -m pytest -q --cov=app --cov-report=term-missing
python -m pytest tests\test_auth.py -v # the auth suite; SKIPS wholesale on 32-bit
python -m ruff check . --config ruff.toml
```

`tests/conftest.py` sets `VISIONIQ_DETECTION_PROVIDER=null` before
`app.config` is imported, installs a `FakeProvider` in the vision registry, and
points SQLite and image storage at a per-test `tmp_path`. No test touches the
network, downloads weights, or calls Bedrock.

Suite files: `test_images.py`, `test_detection.py`, `test_retail_and_insights.py`,
`test_persistence.py`, `test_cloud.py`, `test_auth.py`, `test_regressions.py`,
`test_worker_reliability.py`.

---

## 7. The inference smoke test

Not part of the automated suite — it needs 64-bit Python with torch and may
download weights on first run.

```powershell
cd backend
.venv\Scripts\python.exe scripts\smoke_inference.py path\to\shelf.jpg
```

With no argument it renders a synthetic shelf scene (five blue rectangles).
A generic COCO model may legitimately find **nothing** in that synthetic image —
per the script's own docstring, that is a **pass**, not a failure, as long as
inference completes. Use a real photograph if you want detections.

Output:

```
provider          : yolo
model             : yolov8n.pt
device            : cpu
confidence        : 0.25
image             : shelf.jpg (241,763 bytes)
----------------------------------------------------------
validated         : 810x1080 JPEG
inference status  : ok
model reported    : yolov8n.pt v8.4.183
detections        : 6
inference time    : 7512 ms
total pipeline    : 7589 ms
  - bottle         0.92  [120,341 -> 198,512]
  ...
----------------------------------------------------------
insights source   : rules
summary           : Detected 6 objects across 2 categories. Most frequent: bottle (5).
warning           : Generic COCO-80 model: labels are object categories, not retail SKUs.

RESULT: real inference completed successfully.
```

Exit code is `1` if `status` is `unavailable` or `failed`, `0` otherwise.

Measured on this machine with a real photograph: `bus.jpg`, 810×1080 → **6
detections** (`bus` 0.87; `person` 0.87 / 0.85 / 0.83 / 0.26; `stop sign` 0.26),
~18 s cold including the weight download and ~2.9–7.5 s warm on CPU.

Setting `VISIONIQ_DETECTION_PROVIDER=null` is the quickest way to see the
`unavailable` path end-to-end.

---

## 8. Environment variables

Every tunable, from `backend/app/config.py`. All are optional; the defaults are
a fully working local setup. Nothing here may contain secrets or account ids.

### Vision

| Variable | Default | Notes |
|---|---|---|
| `VISIONIQ_DETECTION_PROVIDER` | `yolo` | `yolo` \| `sagemaker` \| `null`/`none`/`disabled`. Unknown values fall back to `NullProvider` with an explanatory reason. |
| `VISIONIQ_MODEL_ID` | `yolov8n.pt` | Weights filename / Ultralytics model id. |
| `VISIONIQ_CONFIDENCE` | `0.25` | Minimum detection confidence. |
| `VISIONIQ_MAX_DETECTIONS` | `300` | Hitting the cap adds a warning to the result. |
| `VISIONIQ_INFERENCE_TIMEOUT` | `60.0` | Seconds. Advisory: exceeding it adds a warning, it does not abort. |
| `VISIONIQ_DEVICE` | `cpu` | Passed straight to Ultralytics. |
| `VISIONIQ_IMAGE_SIZE` | `640` | Inference letterbox size. Boxes are still returned in original pixels. |
| `VISIONIQ_MAX_PIXELS` | `50000000` | Decompression-bomb cap → `image_too_large`. |
| `VISIONIQ_MODEL_DIR` | `backend/models` | Weights cache. Never committed. |
| `VISIONIQ_SAGEMAKER_ENDPOINT` | `""` | Required when the provider is `sagemaker`. |

### Persistence

| Variable | Default | Notes |
|---|---|---|
| `VISIONIQ_REPOSITORY` | `sqlite` | `sqlite` \| `dynamodb`/`dynamo`. |
| `VISIONIQ_SQLITE_PATH` | `backend/data/visioniq.db` | Created on first use. |
| `VISIONIQ_DYNAMODB_TABLE` | `""` | Required for `dynamodb`; empty raises at construction. |

### Storage

| Variable | Default | Notes |
|---|---|---|
| `VISIONIQ_STORAGE` | `local` | `local` \| `s3`. `/api/uploads/presign` and `/api/jobs` return `503 cloud_disabled` unless this is `s3`. |
| `VISIONIQ_STORAGE_DIR` | `backend/data/images` | Local image root. |
| `VISIONIQ_S3_BUCKET` | `""` | Required for `s3`; empty raises at construction. |
| `VISIONIQ_PRESIGN_TTL` | `300` | Presigned PUT lifetime, seconds. |

### Insights

| Variable | Default | Notes |
|---|---|---|
| `VISIONIQ_INSIGHTS_PROVIDER` | `rules` | `rules` \| `bedrock`. Misconfigured `bedrock` silently degrades to `rules`. |
| `VISIONIQ_BEDROCK_MODEL_ID` | `""` | Required for `bedrock`; never hardcoded in code. |
| `VISIONIQ_BEDROCK_TIMEOUT` | `20.0` | Seconds (read timeout; connect timeout is `min(5.0, this)`). |
| `VISIONIQ_BEDROCK_MAX_TOKENS` | `600` | Hard output cap. |

### Authentication

All seven are read in `config.py` under `-- Authentication --`.

| Variable | Default | Notes |
|---|---|---|
| `VISIONIQ_AUTH_MODE` | `none` | `none` \| `apigateway` \| `jwt`. Anything else **fails closed** with `503 auth_misconfigured` — it never degrades to open. |
| `VISIONIQ_JWT_ISSUER` | `""` | Exact issuer, e.g. `https://cognito-idp.<region>.amazonaws.com/<user-pool-id>`. Required in `jwt` mode; in `apigateway` mode it is optional but, when set, the claims' `iss` must match it. |
| `VISIONIQ_JWT_AUDIENCE` | `""` | Cognito **app client id**. Checked against `aud` for id tokens and `client_id` for access tokens. Required in `jwt` mode. |
| `VISIONIQ_JWKS_URL` | `""` | Overrides the derived endpoint. When empty, `Settings.effective_jwks_url` is `<issuer>/.well-known/jwks.json`. |
| `VISIONIQ_JWT_LEEWAY` | `30` | Clock-skew tolerance in seconds for `exp`/`iat`/`nbf`. Keep it small. |
| `VISIONIQ_JWT_TOKEN_USE` | `access` | `access` \| `id`. Enforced against the `token_use` claim, so an id token cannot be replayed where an access token belongs. Also decides whether `aud` or `client_id` is the audience. |
| `VISIONIQ_JWKS_CACHE_TTL` | `3600` | Seconds the JWKS key set is cached in-process. An unknown `kid` triggers at most one refetch per 60 s (a hardcoded cooldown), so junk tokens cannot amplify into outbound request floods. |

Verification in `jwt` mode, in order: the header `alg` must be in the
`RS256/RS384/RS512` allow-list (`none` and any HS\* are rejected outright —
accepting HMAC against a public JWKS key is the classic algorithm-confusion
forgery); signature against the JWKS key matching `kid`; `exp`/`iat`/`nbf` with
leeway; exact `iss`; audience; `token_use`; non-empty `sub`. JWKS and network
errors are logged but **never** echoed to the caller.

### Cloud / jobs

| Variable | Default | Notes |
|---|---|---|
| `AWS_REGION` | `us-east-1` | Used by every boto3 client. |
| `VISIONIQ_JOBS_QUEUE_URL` | `""` | SQS queue. Empty → `enqueue()` raises `JobError`; the worker exits 1. |
| `VISIONIQ_CLOUD_MODE` | `false` | Truthy: `1`, `true`, `yes`, `on`. Reports `execution_mode: "cloud"`. It **no longer has anything to do with identity** — authentication is controlled solely by `VISIONIQ_AUTH_MODE`. |

### Misc

| Variable | Default | Notes |
|---|---|---|
| `VISIONIQ_LOG_LEVEL` | `INFO` | Root log level for the JSON formatter. |
| `VISIONIQ_RATE_LIMIT` | `60` | Requests per minute per client IP, in-process. |
| `VISIONIQ_CORS_ORIGINS` | *(built-in list)* | Comma-separated. **Replaces** the defaults (localhost/127.0.0.1 on 5173/5174/5175). |
| `VISIONIQ_ROLE` | `worker` | Container entrypoint only (`backend/Dockerfile`): `api` runs uvicorn, anything else runs `python -m app.cloud.worker`. Not read by `config.py`. |

Settings are read **once** via `get_settings()` (`lru_cache(maxsize=1)`), so
changing an env var requires a process restart. Tests call
`get_settings.cache_clear()` plus the `reset_*_cache()` helpers — including
`app.auth.resolver.reset_verifier_cache()`, which drops the cached verifier and
its JWKS cache.

---

## 8a. Running with each auth mode

### `none` — the local default

Nothing to configure. Every request is the pseudo-tenant `local`; no
`Authorization` header is read and none is required.

```powershell
cd backend
.venv\Scripts\Activate.ps1
uvicorn app.main:app --reload --port 8080

curl.exe http://127.0.0.1:8080/api/analyses      # 200, owner "local"
```

Keep this bound to loopback. Anyone who can reach the port has every local
analysis.

### `jwt` — this process verifies the token

Use this to test against a real Cognito pool, or when FastAPI is exposed
directly rather than behind API Gateway.

```powershell
$env:VISIONIQ_AUTH_MODE   = "jwt"
$env:VISIONIQ_JWT_ISSUER  = "https://cognito-idp.us-east-1.amazonaws.com/<user-pool-id>"
$env:VISIONIQ_JWT_AUDIENCE= "<app-client-id>"
# $env:VISIONIQ_JWT_TOKEN_USE = "access"   # default
uvicorn app.main:app --reload --port 8080
```

Then, with an access token from the pool (see `docs/deployment/aws.md` §2a for
how to mint one):

```powershell
curl.exe -H "Authorization: Bearer $env:TOKEN" http://127.0.0.1:8080/api/analyses
```

Expected failure shapes:

| Request | Response |
|---|---|
| no `Authorization` header | `401 unauthenticated`, `WWW-Authenticate: Bearer` |
| `Authorization: Token abc` | `401 unauthenticated` — only `Bearer` is accepted |
| `alg: none` or an HS256-signed token | `401 invalid_token` |
| expired token | `401 token_expired` |
| id token while `VISIONIQ_JWT_TOKEN_USE=access` | `401 invalid_token` |
| issuer/audience set but empty, or an unknown mode | `503 auth_misconfigured` |
| JWKS endpoint unreachable | `503 jwks_unavailable`, with no URL or cause echoed |

Note the split: **401 is the caller's fault, 503 is ours.** A misconfiguration
never looks like a bad credential and never falls back to anonymous.

### `apigateway` — the gateway already verified it

In this mode the app reads claims from
`request.scope["aws.event"].requestContext.authorizer.jwt.claims`, which API
Gateway's JWT authorizer has already validated. There is nothing to verify
locally and plain uvicorn never populates that scope key, so a direct local run
in this mode yields `401 unauthenticated` for every request — that is correct
behaviour, not a bug. Exercise this path with `tests\test_auth.py`, which
constructs the scope directly; end-to-end it only works behind the deployed
HTTP API.

If `VISIONIQ_JWT_ISSUER` is set, the claims' `iss` must still match it exactly.

---

## 9. Quick troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `detection.status = "unavailable"`, reason mentions PyTorch | running a 32-bit interpreter | use the 64-bit `.venv`; the rest of the API works regardless |
| `tests\test_auth.py` all skipped | `cryptography` missing (32-bit interpreter) | use the 64-bit `.venv`; 32-bit cannot build it |
| `401 unauthenticated` on every request | `VISIONIQ_AUTH_MODE` is `apigateway` but you are running uvicorn directly | use `none` locally, or `jwt` with a real token |
| `503 auth_misconfigured` | unknown mode, or `jwt` mode without issuer/audience | fix the env vars; the app deliberately will not open up |
| `503 jwks_unavailable` | JWKS endpoint unreachable | check the issuer URL and egress; the detail is intentionally generic |
| Frontend `/api/...` 404s or hangs | backend not on 8080 | start uvicorn on `--port 8080` first |
| Port 8000 refuses to bind | known on this machine | use 8080 |
| First detect takes ~18 s | cold weight download + torch import | expected; subsequent calls ~7.5 s |
| `429 rate_limited` while testing | 60 req/min per IP | raise `VISIONIQ_RATE_LIMIT` and restart |
| `503 cloud_disabled` on presign/jobs | `VISIONIQ_STORAGE` is not `s3` | use `/api/images/detect` locally |
| `pip install ultralytics` fails on wheels | 32-bit interpreter | install into the 64-bit `.venv` only |
| `pip install -r requirements.txt` fails on pillow | Python < 3.11 with the old `pillow==13.0.0` pin | pull latest; it is pinned to `12.3.0` now |
| `cryptography` build fails with a Rust linker error | 32-bit interpreter | use the 64-bit `.venv`; there is no 32-bit wheel |

### Frontend authentication

| Symptom | Cause | Fix |
|---|---|---|
| Cognito shows `redirect_mismatch` / "redirect_uri does not match" | the origin you browsed to is not one Terraform registered, or a path was appended | browse to exactly `http://localhost:5175` or `http://127.0.0.1:5175`; if you set `VITE_COGNITO_REDIRECT_URI`, make it the **bare origin with no path**. Cognito matches the string exactly |
| The page keeps bouncing to Cognito and back (`login_required` loop) | no Cognito session cookie, so every silent `prompt=none` attempt fails | this is the normal signed-out path and should land on the login screen, not loop. A real loop means third-party/blocked cookies for the Cognito domain, or an incognito window with storage blocked — allow cookies for the hosted-UI domain and click **Sign in** for an interactive flow |
| A production build renders "configuration error" and no dashboard | the fail-closed path in `resolveAuthConfig` | you built with `VITE_AUTH_MODE=local`, omitted `VITE_COGNITO_DOMAIN`/`VITE_COGNITO_CLIENT_ID`, used an unknown mode, or gave an `http://` redirect URI. The on-screen `reason` names which. **Do not patch around it** |
| "Sign-in failed a security check" | the returned `state` did not match the stashed one | usually a stale tab or a re-used callback URL. Start sign-in again; the code is never exchanged in this case |
| "This sign-in link is no longer valid" | no PKCE verifier in `sessionStorage` — a callback URL opened in a different tab, or storage blocked | start sign-in again in the tab that will complete it |
| Signed out, then immediately signed back in | logout did not reach the hosted-UI `/logout` | `logout()` must navigate to `buildLogoutUrl()`; without clearing Cognito's session cookie, silent re-auth undoes the sign-out |
| Session drops after ~an hour, or on reload | by design | the token is in memory only and a timer moves the app to `expired` 60 s (`EXPIRY_SKEW_MS`) before real expiry. `getAccessToken()` returns `null` past that point, so an expired token is never sent. There is **no refresh token in the browser** — re-authentication is silent if Cognito still has a session, interactive otherwise |
| `401` from the API while the UI still looks signed in | token rejected by the backend | `client.ts` notifies `onUnauthorized` and the provider moves to `expired`. Check `VITE_COGNITO_CLIENT_ID` equals `VISIONIQ_JWT_AUDIENCE` and `VITE_COGNITO_ISSUER` equals `VISIONIQ_JWT_ISSUER` |
| Everything saved under owner `local` despite signing in | backend is still `VISIONIQ_AUTH_MODE=none` | set `jwt` (or `apigateway` when deployed) — see the pairing table in §5a |
