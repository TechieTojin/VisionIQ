# VisionIQ — System Architecture

VisionIQ validates retail shelf photographs, runs generic object detection over
them, derives a provenance-tagged "retail intelligence" view, and narrates the
result. It runs in two shapes from **one codebase and one pipeline function**:

- **Local synchronous** — FastAPI + YOLOv8n on CPU + SQLite + the filesystem.
- **Cloud asynchronous** — Cognito + API Gateway (JWT authorizer) + Lambda +
  presigned S3 + SQS + an ECS Fargate inference worker + DynamoDB.

The shared entry point is `analysis_service.analyse()`
(`backend/app/services/analysis_service.py`), used by both the synchronous HTTP
route and the queue worker, so local and cloud results are byte-for-byte the
same shape.

> **Status:** the cloud path is fully implemented in application code and
> Terraform, but **nothing has been deployed**. See `docs/deployment/aws.md`.

---

## 1. Local synchronous path

```
┌─────────┐  multipart POST /api/images/detect
│ Browser │──────────────┐
└─────────┘              │ (relative /api path — never a hardcoded host)
                         ▼
                 ┌──────────────────┐
                 │ Vite dev server  │  :5175
                 │  proxy /api  ───────────────┐
                 └──────────────────┘          │ http://127.0.0.1:8080
                                               ▼
                               ┌────────────────────────────────┐
                               │ FastAPI (uvicorn :8080)        │
                               │  CorrelationMiddleware         │
                               │  CORSMiddleware                │
                               │  routes/images.py              │
                               └───────────────┬────────────────┘
                                               │
                     ┌─────────────────────────┼──────────────────────────┐
                     ▼                         ▼                          ▼
          ┌────────────────────┐   ┌──────────────────────┐   ┌────────────────────┐
          │ image_analyzer     │   │ vision registry      │   │ retail/intelligence│
          │ Pillow verify+open │──▶│  YoloProvider (CPU)  │──▶│  counts, occupancy │
          │ size / pixel caps  │   │  _INFERENCE_LOCK     │   │  shelf_gaps/sku =  │
          └────────────────────┘   │  ultralytics YOLOv8n │   │   unsupported      │
                                   └──────────────────────┘   └─────────┬──────────┘
                                                                        ▼
                                                              ┌────────────────────┐
                                                              │ insights/rule_based│
                                                              │ deterministic text │
                                                              └─────────┬──────────┘
                                                                        │
                           ┌────────────────────────────────────────────┴───────┐
                           ▼                                                    ▼
             ┌──────────────────────────┐                      ┌────────────────────────┐
             │ SqliteAnalysisRepository │                      │ LocalImageStorage      │
             │ backend/data/visioniq.db │                      │ backend/data/images/   │
             │ PK (owner_id, analysis_id)                      │ key {owner}/{id}.{ext} │
             └──────────────────────────┘                      └────────────────────────┘
                           │
                           ▼  single HTTP response: the complete AnalysisRecord
                        Browser
```

The whole thing is one request. `POST /api/images/detect` returns the finished
`AnalysisRecord` — detections, retail view, insights and all — with
`status: "completed"`. With the default `VISIONIQ_AUTH_MODE=none`, `owner_id` is
the pseudo-tenant `"local"` (`backend/app/security.py` → `app/auth/resolver.py`).

---

## 1a. Authentication

Identity is resolved by `backend/app/auth/` and nothing else. `TokenClaims`
(`auth/base.py`) is the verified subset of a token the app is willing to act on,
and its `subject` — the `sub` claim — is the sole tenant key. It is opaque and
immutable in Cognito, which is what makes it a safe DynamoDB partition key.
**No code path reads an owner id from a header, query parameter or body.**

`VISIONIQ_AUTH_MODE` selects one of three modes (`auth/resolver.py`):

| Mode | Token verified by | Claims read from | Owner id | Intended for |
|---|---|---|---|---|
| `none` *(default)* | nobody — auth is off | n/a; no `Authorization` header is read | pseudo-tenant `local` | Local development with no AWS account |
| `apigateway` | **API Gateway's Cognito JWT authorizer**, before the request is ever invoked | `request.scope["aws.event"].requestContext.authorizer.jwt.claims` | verified `sub` | The deployed HTTP API |
| `jwt` | **this process**, via JWKS + RS256 | the `Authorization: Bearer` header | verified `sub` | FastAPI exposed directly, or testing against a real pool |

In `apigateway` mode the gateway rejects an unverified token before the handler
runs, so claims that arrive are already trusted; the app still refuses to proceed
without a `sub` and, when `VISIONIQ_JWT_ISSUER` is set, re-checks `iss`.

In `jwt` mode `auth/jwt_verifier.py` checks, in order: the header `alg` against
an `RS256/384/512` allow-list (so `alg: none` and HS\*-signed forgeries are
rejected before any crypto runs); the signature against the JWKS key matching
`kid`; `exp`/`iat`/`nbf` with leeway; an exact `iss`; the audience (`aud` for id
tokens, `client_id` for Cognito access tokens, which carry no `aud`);
`token_use`; and a non-empty `sub`. JWKS keys are cached with a TTL and an
unknown `kid` forces at most one refetch per 60 s.

Failure handling is deliberately split: **401** for the caller's fault (with
`WWW-Authenticate: Bearer`), **503** for ours — an unknown mode, a missing
issuer or audience, or an unreachable JWKS. A misconfiguration never degrades to
anonymous access, and error details never echo token contents or internal state.

Cross-tenant reads return **404, not 403**, so existence is not disclosed.

### 1b. Frontend authentication

The SPA half of the story lives in `frontend/src/auth/` and implements the
OAuth 2.0 **authorization code flow with PKCE (S256)** against the Cognito
hosted UI — hand-written, no Amplify, so each security-relevant step is
visible and testable. `resolveAuthConfig()` picks a mode at build time from
`VITE_*` variables:

| `VITE_AUTH_MODE` | What the SPA does | Token the API sees | Pairs with |
|---|---|---|---|
| `local` *(dev default)* | No provider interaction at all; the provider reports `authenticated` immediately and the header shows an "auth off (local)" pill | none | `VISIONIQ_AUTH_MODE=none` |
| `cognito` *(prod default)* | Hosted-UI code flow with PKCE; access token held in memory | `Authorization: Bearer <access token>` | `VISIONIQ_AUTH_MODE=apigateway` (deployed) or `jwt` (direct uvicorn) |
| `misconfigured` | Not selectable — the fail-closed outcome. Renders a hard configuration error, never a dashboard | none | — |

`misconfigured` is returned for a production build with `VITE_AUTH_MODE=local`,
a missing `VITE_COGNITO_DOMAIN`/`VITE_COGNITO_CLIENT_ID`, an unknown mode, or
an `http://` redirect URI in production.

`AuthProvider` exposes seven statuses — `initialising`, `authenticating`,
`authenticated`, `unauthenticated`, `expired`, `error`, `misconfigured` — and
`AuthenticatedApp` renders the dashboard only on `authenticated`, routing
every other status to `AuthGate`. The module boundaries:

| Module | Responsibility |
|---|---|
| `auth/config.ts` | `resolveAuthConfig(env, isProd, origin)` — the fail-closed mode decision |
| `auth/pkce.ts` | S256 verifier/challenge, `state`, the `sessionStorage` stash, `statesMatch` |
| `auth/cognito.ts` | Authorize/logout URL construction, the token exchange, `readClaimsUnsafe`, `AuthFlowError` |
| `auth/session.ts` | In-memory token store, `EXPIRY_SKEW_MS = 60_000`, `isExpired`, `msUntilRefresh` |
| `auth/AuthProvider.tsx` | Bootstrap, silent re-auth, callback handling, expiry timer, `401` handling |
| `components/AuthScreens.tsx` | Loading / login / expired / error / misconfigured screens and `AuthGate` |

Two decisions shape everything else: the **access token lives in memory only**,
and **no refresh token ever enters the browser**. Session continuity therefore
comes from `prompt=none` silent re-authentication against Cognito's own session
cookie rather than a stored credential. See
[`docs/security/threat-model.md`](../security/threat-model.md) §3, *Frontend
authentication*, for the full reasoning and the accepted tradeoff.

---

## 2. Cloud asynchronous path

**(0) Sign-in** — authorization code flow with PKCE, before anything else:

```
┌─────────┐                                        ┌──────────────────────────┐
│ Browser │                                        │ Cognito hosted UI        │
│  (SPA)  │                                        │  + user pool             │
└────┬────┘                                        └────────────┬─────────────┘
     │ 0a. page load, no callback params                        │
     │     verifier = random 64B; challenge = S256(verifier)    │
     │     state = random 32B;  both stashed in sessionStorage  │
     │                                                          │
     │ 0b. GET /oauth2/authorize?response_type=code             │
     │       &code_challenge=<S256>&code_challenge_method=S256  │
     │       &state=<state>&redirect_uri=<BARE ORIGIN>          │
     │       &prompt=none      ← silent attempt                 │
     │─────────────────────────────────────────────────────────▶│
     │                                                          │ session cookie?
     │ 0c-i.  ?error=login_required   (no session)              │
     │◀─────────────────────────────────────────────────────────│
     │        → status "unauthenticated", login screen.         │
     │          User clicks Sign in → repeat 0b WITHOUT         │
     │          prompt=none → interactive hosted-UI login.      │
     │                                                          │
     │ 0c-ii. ?code=<code>&state=<state>   (session present     │
     │◀───────────────────────────────────  or login completed) │
     │                                                          │
     │ 0d. consumeFlow() — read AND clear verifier + state      │
     │     statesMatch(expected, returned)?                     │
     │       NO  → abort. The code is NEVER exchanged.          │
     │       YES ↓                                              │
     │ 0e. POST /oauth2/token                                   │
     │       grant_type=authorization_code&code=<code>          │
     │       &code_verifier=<verifier>   (NO client secret —    │
     │                                    public client)        │
     │─────────────────────────────────────────────────────────▶│
     │ 0f. { access_token, id_token, expires_in,                │
     │◀──────  refresh_token ← READ BY NOBODY, DISCARDED }      │
     │                                                          │
     │ 0g. access token → module-scoped variable (memory only)  │
     │     history.replaceState() strips code/state from the URL│
     │     expiry timer armed at (expires_at − 60s)             │
     │                                                          │
     │ 0h. sign out → GET /logout?client_id&logout_uri          │
     │─────────────────────────────────────────────────────────▶│
     │        clears Cognito's session cookie, else silent      │
     │        re-auth would undo the sign-out                   │
```

Then every API call carries that token:

```
┌─────────┐                                    ┌──────────────────────────┐
│ Browser │   access token from step 0f        │ Amazon Cognito user pool │
│         │   held in MEMORY ONLY, never       │  public SPA client       │
└────┬────┘   localStorage/sessionStorage      │  no secret, SRP+refresh  │
     │        NO refresh token in the browser  │  access/id 1h, refresh 30d
     │                                         └──────────────────────────┘
     │ (1) POST /api/uploads/presign  {filename, content_type, size_bytes}
     │     Authorization: Bearer <access token>
     ▼
┌──────────────────────────┐    ┌───────────────────────────────┐
│ API Gateway HTTP API     │───▶│ Lambda (control plane only)   │
│  JWT authorizer on ALL   │    │ presign / create / get / list │
│  FOUR routes — no public │    │ owner_id = verified claims    │
│  route; 401 without a    │    │   .sub, never a header/body   │
│  verified `sub`          │    └──────────────┬────────────────┘
│  throttling, CORS        │                   │ generate_presigned_url(put_object)
└──────────────────────────┘                   │ ContentType + SSE signed in,
     ▲                                         │ TTL 300s
     │                                         ▼
     │ 200 PresignResponse — the CANONICAL shape, identical on both backends:
     │ {analysis_id, upload:{url, key, expires_in, required_headers, max_bytes}}
     │
     │ (2) PUT the bytes DIRECTLY to S3 — never through the API
     │     ONLY upload.required_headers — and NO Authorization header:
     │     the presigned signature IS the credential
     │        ┌───────────────────────────────────────────┐
     └───────▶│ S3 (private, SSE-AES256, no public access)│
              │ key: {prefix}{owner_id}/{analysis_id}.{ext}│
              └──────────────┬────────────────────────────┘
                             │
     (3) POST /api/jobs {analysis_id, image_key}
     │      → 202 bare AnalysisRecord, status "queued"
     │      server-side re-validation:
     │        assert_owned(key, owner_id)   → 403 forbidden
     │        head_object → real size       → 413 file_too_large (+ delete)
     │        head_object → real ContentType→ 400 unsupported_format (+ delete)
     ▼
┌───────────────────────┐   create_job()    ┌─────────────────────┐
│ Lambda / FastAPI      │──────────────────▶│ DynamoDB            │
│ app/cloud/jobs.py     │   status=queued   │ PK owner_id         │
│                       │                   │ SK analysis_id      │
│                       │──────────────────▶│ GSI owner_created   │
│                       │   SQS send_message└─────────────────────┘
└───────────┬───────────┘                              ▲
            ▼                                          │
     ┌──────────────┐    long poll (20s, 1 msg)        │ update / set_status
     │ SQS main     │◀──────────────────────┐          │
     │ + DLQ (maxRx │                       │          │
     │   Count 3)   │             ┌─────────┴──────────┴──────────────┐
     └──────────────┘             │ ECS Fargate worker                │
                                  │  app/cloud/worker.py              │
                                  │  warmup() YOLO once at boot       │
                                  │  jobs.process_job():              │
                                  │   re-read record → skip if terminal│
                                  │   set_status(processing)          │
                                  │   S3 get bytes                    │
                                  │   analysis_service.analyse(...)   │
                                  │   repo.update(completed)          │
                                  │  delete SQS msg ONLY on success   │
                                  └───────────────────────────────────┘
                                                 │ optional
                                                 ▼
                                       ┌────────────────────┐
                                       │ Amazon Bedrock     │
                                       │ structured counts  │
                                       │ only — never image │
                                       └────────────────────┘

     (4) GET /api/jobs/{analysis_id}  → 200 bare AnalysisRecord
         poll every VITE_JOB_POLL_INTERVAL_MS (2s) until
         status ∈ {completed, failed, cancelled};
         give up after VITE_JOB_POLL_TIMEOUT_MS (5 min) — WITHOUT cancelling:
         the worker carries on and the record lands in the scan history
     (-) POST /api/jobs/{id}/cancel   → only while queued (409 invalid_state otherwise)
```

The client side of steps 1–4 is `frontend/src/api/analysisClient.ts`
(`CloudAnalysisClient`); `frontend/src/api/config.ts` selects it with
`VITE_API_MODE=cloud` and supplies the base URL and poll timings. Because every
response above is the canonical shape, the **local** client differs only in
collapsing all four steps into a single `POST /api/images/detect` — the parsing
is shared. See
[`docs/api/README.md`](../api/README.md) § *Local vs cloud: same shapes,
different choreography*.

### Job state machine

Documented in `backend/app/cloud/jobs.py`:

```
queued ──▶ processing ──▶ completed
                      └─▶ failed       (terminal, after SQS redrive to DLQ)
queued ──▶ cancelled                   (only before a worker claims it)
```

**Idempotency.** `analysis_id` is the idempotency key. `derive_analysis_id(bucket,
key, etag)` makes it a deterministic SHA-256 prefix of the uploaded object, so a
duplicate "create job" for the same object returns the existing record instead
of creating a second analysis. `create_job()` does a `repo.get()` first and
returns the existing record untouched on a hit. `process_job()` re-reads the
record and returns immediately if the status is already terminal — which is what
makes SQS at-least-once delivery safe.

**Failure handling.** A worker crash or timeout leaves the message unacknowledged;
after the visibility timeout it becomes visible again and is retried. After
`maxReceiveCount` (3) attempts it moves to the DLQ and a CloudWatch alarm fires.
`process_job()` marks the record `failed` and re-raises so the message is *not*
deleted. Partial failure is handled separately: if Bedrock is down, the analysis
still completes and `insights.degraded = true`.

### Cross-component contracts

The cloud path has two producers — the FastAPI backend (`app/cloud/jobs.py`,
`app/routes/cloud.py`) and the deployed Lambda control plane
(`infrastructure/terraform/lambda/api/handler.py`) — and one consumer, the
Fargate worker reading through `app/repositories/dynamo_repo.py` and
`app/storage/`. **Four** data shapes cross that seam — three internal ones plus
the public API contract. They are the *only* place in the system where two
independently written components must agree byte for byte, and the internal
three only meet inside a deployed AWS account — so a local test suite that does
not model them proves nothing about the cloud path.

The first three were broken before Phase 3.7 and are now fixed; the fourth was
unified in Phase 3.8.

#### 1. Storage key

```
{UPLOAD_PREFIX}{owner_id}/{analysis_id}.{ext}      →  uploads/alice/abc123.jpg
```

| Side | Implementation |
|---|---|
| Backend | `app/storage/base.py::build_key` / `assert_owned` (optional `prefix` argument) |
| Lambda | `handler.py::build_key` / `_owns_key`, from the `UPLOAD_PREFIX` env var |
| Config | `VISIONIQ_UPLOAD_PREFIX` (default `uploads/`); Terraform `upload_prefix` |
| IAM | `modules/security/main.tf` scopes every S3 grant to `${bucket_arn}/${upload_prefix}*` |

The prefix is not cosmetic: the worker task role holds `s3:GetObject` on the
upload prefix **only**. Before the fix there were three conventions in play —
the Lambda built `uploads/{owner}/{id}` with no extension, `build_key` built
`{owner}/{id}.{ext}` with no prefix, and the IAM policy granted read on
`uploads/*`. The backend's own keys were therefore unreadable by the worker,
which surfaces as `AccessDenied` at inference time rather than a clean 404.

#### 2. SQS message body

```json
{ "analysis_id": "abc123", "owner_id": "alice", "image_key": "uploads/alice/abc123.jpg" }
```

Produced by `app/cloud/jobs.py::enqueue` **and** the Lambda's `create_job`;
consumed by `app/cloud/worker.py::process_message`, which requires
`analysis_id` and `owner_id`. The Lambda previously sent `object_key` — one
consumer, two incompatible producers.

#### 3. DynamoDB item

Promoted query attributes (`owner_id`, `analysis_id`, `created_at`, `status`,
`filename`, `detection_count`, `distinct_categories`, `top_labels`,
`execution_mode`) **plus a `payload` attribute holding the full
`AnalysisRecord` JSON**, because the repository reconstitutes the record with:

```python
AnalysisRecord.model_validate(_from_dynamo(item["payload"]))
```

The Lambda previously wrote a flat item with no `payload`. Every cloud job
would have raised `KeyError` in the worker and been redriven to the DLQ — with
a green local test suite the whole way. The Lambda also writes integers rather
than floats in the payload (`0`, not `0.0`), because DynamoDB rejects `float`
and the alternative is `Decimal` conversion in a dependency-free handler.

#### 4. Successful response shapes — the canonical API contract

Unlike the first three, this one is visible to clients. **FastAPI's successful
response schemas are the contract**; the Lambda was changed to match, and
FastAPI was not touched.

| Resource | Canonical shape |
|---|---|
| create / get / cancel job | bare `AnalysisRecord` |
| list jobs | bare `AnalysisPage` — `{items, next_cursor, has_more}` |
| presign | `PresignResponse` — `{analysis_id, upload{url, key, expires_in, required_headers, max_bytes}}` |
| delete job | `204`, no body |

The Lambda previously wrapped every success in `{success: true, analysis: …}`
(or `{success, analyses, count, …}` when listing), which forced any client
talking to both backends to read `body.analysis ?? body`. Two projection
helpers now hold the line:

```python
def _record(item: dict) -> dict:          # bare AnalysisRecord
    payload = item.get("payload")
    return payload if isinstance(payload, dict) else {}

_SUMMARY_FIELDS = (...)                   # == AnalysisSummary.model_fields
def _summary(item: dict) -> dict: ...     # bare AnalysisSummary
```

`_record` returns the stored `payload` and nothing else, so storage internals
(`payload`, `expires_at`) never reach the wire. `owner_id` does appear, because
it is a field of `AnalysisRecord`.

**Deliberately unchanged:** the error envelope
(`{"success": false, "error": …, "detail": …}`) already matched on both sides,
and `204` stays bodiless per RFC 9110.

> Any new or changed success response must have the same shape in FastAPI and
> in the Lambda for equivalent resources, with an assertion in
> `test_cloud_contracts.py` in the same commit.

#### Enforcement

`backend/tests/test_cloud_contracts.py` (**62 tests**) imports the real Lambda
module with its environment stubbed and its boto3 clients mocked — no AWS call,
no credentials — and asserts that the Lambda's item parses as an
`AnalysisRecord`, that both `build_key` implementations produce byte-identical
keys, that both ownership guards reject the same hostile keys, that the SQS
body satisfies `worker.process_message`, that the error envelopes agree, that
identity comes only from the JWT `sub`, and that pagination cursors round-trip
and reject cross-tenant values.

> Changing any of these four shapes means changing every side — backend,
> Lambda, Terraform IAM — **and** `test_cloud_contracts.py`, in the same commit.

---

## 3. Why Fargate for inference, not Lambda

Stated in `backend/app/cloud/worker.py`, `backend/Dockerfile` and
`infrastructure/terraform/README.md`:

| Constraint | Lambda | Fargate |
|---|---|---|
| Image size | torch + torchvision + ultralytics + weights is multi-GB, past Lambda's package/image limits | 5 GB+ image is routine; ECR lifecycle keeps 10 tags |
| Cold start | pulling and initialising torch would dominate the request | model warmed **once at container boot** (`worker.py` calls `warmup()` before the receive loop) |
| Duration | CPU inference is seconds to tens of seconds per image | `worker_processing_timeout_seconds = 300` |
| Memory shape | fixed per invocation | 1 vCPU/2 GB dev, 2 vCPU/8 GB prod; one message at a time bounds RSS |
| Concurrency | per-invocation isolation makes a global inference lock impossible | one container, `MaxNumberOfMessages=1`, `_INFERENCE_LOCK` serialises |

The **control plane** — presign, create job, get job, list jobs — is small and
I/O bound, so it *is* on Lambda, where per-request billing and scale-to-zero are
the right trade. Only the heavy, stateful, warm-model part gets a container.

---

## 4. Layered backend

```
backend/app/
├── main.py            FastAPI app, lifespan logging, CORS, router wiring
├── config.py          every tunable, env-driven; no secrets, no account ids
├── security.py        FastAPI deps: owner resolution + in-process rate limiter
├── auth/              verified caller identity — the only source of owner_id
│   ├── base.py        TokenClaims (subject == tenant key), AuthError
│   ├── jwt_verifier.py  JWKS cache (TTL + refetch cooldown), RS256 verification
│   └── resolver.py    mode dispatch: none | apigateway | jwt
├── observability.py   JSON logging, correlation ids, redaction, request metrics
├── routes/            HTTP only: parse, delegate, map errors to JSON
│   ├── images.py      POST /api/images/analyze, /api/images/detect
│   ├── analyses.py    GET/DELETE history, compare
│   └── cloud.py       presign, jobs, system status
├── schemas/           Pydantic I/O contracts — the published shape of the API
│   ├── detection.py   BoundingBox convention, InferenceStatus, DetectionResult
│   ├── retail.py      Reliability, SkuStatus, RetailIntelligence, ComparisonResult
│   ├── insights.py    InsightSource, InsightsResult
│   ├── analysis.py    JobStatus, AnalysisRecord, AnalysisSummary, AnalysisPage
│   └── image.py       ImageMetadata, AnalyzeResponse, ErrorResponse
├── services/          framework-agnostic business logic
│   ├── image_analyzer.py     Pillow validation + metadata
│   ├── analysis_service.py   the one pipeline: detect → aggregate → narrate
│   ├── vision/               detection providers (yolo | sagemaker | null)
│   ├── retail/               intelligence aggregation + SKU matcher interface
│   └── insights/             rule-based (default) and Bedrock providers
├── repositories/      persistence (sqlite | dynamodb) behind one Protocol
├── storage/           image bytes (local | s3) behind one Protocol
└── cloud/             jobs.py (lifecycle) and worker.py (SQS consumer)
```

Rules the layers enforce:

- Routes never contain business logic; they translate exceptions into the
  `ErrorResponse` shape and nothing else.
- Services never import FastAPI.
- Repositories store a **storage key**, never image bytes.
- Schemas are the contract; both the SQLite and DynamoDB repositories persist
  the record as JSON of the same Pydantic model.

---

## 5. Swappable abstractions

Three Protocols, three factories, three env vars. Each factory caches per
configuration key and exposes a `reset_*_cache()` for tests.

### Detection provider — `app/services/vision/`

`DetectionProvider` (`base.py`) is a `Protocol` with `model_info`, `warmup()`
and `detect(image_bytes, *, confidence, max_detections) -> list[Detection]`.
Implementations **MUST** rescale boxes to the original image dimensions and
**MUST NOT** return synthetic results on failure.

| `VISIONIQ_DETECTION_PROVIDER` | Class | Behaviour |
|---|---|---|
| `yolo` (default) | `YoloProvider` | Ultralytics YOLOv8n, CPU, COCO-80, global inference lock |
| `sagemaker` | `SageMakerProvider` | `invoke_endpoint` with raw bytes; strict JSON validation, refuses to guess on a malformed payload |
| `null` / `none` / `disabled` | `NullProvider` | Raises `ProviderUnavailable` — zero detections, honest status |
| anything else | `NullProvider` | with reason `Unknown detection provider '<x>'` |

Failures are typed: `ProviderUnavailable` → `InferenceStatus.UNAVAILABLE`,
`InferenceFailed` → `InferenceStatus.FAILED`. Neither ever produces a detection.

### Repository — `app/repositories/`

`AnalysisRepository` serves exactly four access patterns (documented in
`base.py`), none of which needs a scan:

1. get by `(owner_id, analysis_id)` → primary key
2. list newest-first, paginated → GSI on `created_at`
3. update status / attach results → primary key
4. delete → primary key

| `VISIONIQ_REPOSITORY` | Class | Keys | Pagination |
|---|---|---|---|
| `sqlite` (default) | `SqliteAnalysisRepository` | `PRIMARY KEY (owner_id, analysis_id)`, index `(owner_id, created_at DESC)` | keyset on `created_at\|analysis_id`, base64 |
| `dynamodb` / `dynamo` | `DynamoAnalysisRepository` | PK `owner_id`, SK `analysis_id`, GSI `owner_created_index` | native `LastEvaluatedKey`, base64; a cursor whose `owner_id` ≠ requester is **rejected** |

Both promote `created_at`, `status`, `filename`, `detection_count`,
`distinct_categories`, `top_labels`, `execution_mode` out of the JSON payload so
listing and filtering stay indexable.

### Storage — `app/storage/`

`ImageStorage` is `put/get/delete/exists`. Keys are
`build_key(owner, analysis_id, fmt)` → `{owner_id}/{analysis_id}.{jpg|png|webp|bin}`.
`assert_owned(key, owner_id)` rejects `..`, leading `/`, backslashes, and any
key not prefixed with the caller's owner id.

| `VISIONIQ_STORAGE` | Class | Notes |
|---|---|---|
| `local` (default) | `LocalImageStorage` | resolves under the root and re-checks with `Path.relative_to` |
| `s3` | `S3ImageStorage` | private bucket, `ServerSideEncryption=AES256`, `presign_put()` + `head()` |

### Insights — `app/services/insights/`

| `VISIONIQ_INSIGHTS_PROVIDER` | Class |
|---|---|
| `rules` (default) | `RuleBasedInsights` — deterministic, offline, free, cannot hallucinate |
| `bedrock` | `BedrockInsights` — structured counts only, strict JSON parse, **falls back to rules** on any error with `degraded = true` |

A misconfigured Bedrock provider (e.g. empty model id) is caught in the factory
and silently degrades to rules rather than taking the app down.

---

## 6. Honesty guarantees

These are deliberate design properties, not accidents:

- **No fabricated detections.** Every provider raises instead of returning
  plausible-looking boxes. `NullProvider` exists purely so "detection disabled"
  is a first-class, explicitly reported state.
- **`unavailable` ≠ empty shelf.** `build_intelligence()` appends the caveat
  *"all counts are zero because nothing was analysed, not because the shelf is
  empty."*
- **SKU identity is reported `unsupported`**, with a reason string, rather than
  being faked from a COCO label.
- **Shelf-gap detection is reported `unsupported`** — gaps are not inferred from
  object absence.
- **Occupancy is `estimated`**, with the method and its over-read bias stated
  inline.
- **Comparisons across different models set `comparable: false`** and prepend a
  caveat about mismatched label spaces.
- A persistence failure after a successful analysis does not discard the result;
  it appends `" (result was not saved to history)"` to `error` and still returns
  the record.
