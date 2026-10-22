# AWS Deployment Runbook

> ## NOTHING IS DEPLOYED — `terraform plan` HAS NEVER BEEN RUN
>
> **There are no AWS credentials on this machine.** `terraform plan` has never
> executed, let alone `terraform apply`. No S3 bucket, DynamoDB table, SQS
> queue, ECS cluster, ECR repository, Lambda function, API Gateway or Cognito
> user pool created by this stack exists. There is no state file. The
> `deploy.yml` workflow has never been dispatched.
>
> **The worker container image has never been built.** Docker is not installed
> on this machine. `backend/Dockerfile` and `backend/.dockerignore` have been
> written and reviewed, not executed.
>
> What *has* been verified, offline: `terraform fmt -recursive` is clean,
> `terraform init -backend=false` succeeds, and `terraform validate` reports
> *"Success! The configuration is valid."* That is a syntax and type check
> against the provider schema — it proves nothing about what AWS will accept.
>
> Everything below is a procedure derived from the Terraform and workflow
> source, not a record of something that worked. Expect to debug it the first
> time. Every cost figure in `docs/cost/README.md` and
> `infrastructure/terraform/README.md` is a planning aid from list prices, not
> an observed bill.

Source of truth: `infrastructure/terraform/` (do not modify while following
this), `.github/workflows/deploy.yml`, `backend/Dockerfile`.

---

## 1. Known gaps — close these before real tenants

Carried over from `infrastructure/terraform/README.md`:

**Closed in Phase 3.7** (previously the second blocker): **the Lambda control
plane is no longer a skeleton.** `infrastructure/terraform/lambda/api/handler.py`
implements all six routes — `presign`, `create_job`, `get_job`, `list_jobs`,
plus the new `cancel_job` (`POST /api/jobs/{id}/cancel`) and `delete_job`
(`DELETE /api/jobs/{id}`) — with server-side ownership enforcement on every
path, `head_object` verification of the uploaded object, idempotent creation,
keyset pagination, validated `limit`, a shared error envelope and security
headers on every response. The three Lambda↔backend data shapes (storage key,
SQS body, DynamoDB item) were **broken** and are now fixed and pinned by
`backend/tests/test_cloud_contracts.py` (62 tests, boto3 mocked). Terraform
gained the two new routes in `modules/api` `local.functions` (JWT-authorized
like the rest, via `for_each`) and two new IAM grants in `modules/security`:
`s3:DeleteObject` scoped to `${bucket_arn}/${upload_prefix}*` and
`dynamodb:DeleteItem` on the table and its index — each with an inline comment
explaining which handler needs it. **The Lambda has still never executed
against real AWS**, so route wiring, IAM and the authorizer attachment are
reviewed-but-unexecuted; `terraform plan` has not been run.

**Closed in Phase 3.8** (previously: *the Lambda and FastAPI success envelopes
differ, so a client cannot talk to both*): **they no longer differ.** FastAPI's
successful response schemas are the canonical contract, and the Lambda was
changed to match — bare `AnalysisRecord` for create/get/cancel, bare
`AnalysisPage` (`{items, next_cursor, has_more}`) for list, `PresignResponse`
(`{analysis_id, upload{…}}`) for presign. The `{"success": true, "analysis": …}`
wrapper and the `count` field are gone; no client needs
`body.analysis ?? body`. The **error envelope is unchanged** — it already
matched — and `DELETE` still returns a bodiless `204`.
`frontend/src/api/analysisClient.ts` is the client side of this: one interface,
a local one-shot implementation and a cloud presign/PUT/create/poll
implementation, selected by `VITE_API_MODE`. **Still never executed against
real AWS**; the contract is pinned by `test_cloud_contracts.py` with boto3
mocked and by `analysisClient.test.ts` with a stubbed `fetch`/XHR.

**Closed in Phase 3.7** (SPA delivery): `infrastructure/terraform/modules/frontend/`
now provides S3 + Origin Access Control + CloudFront with a response-headers
policy carrying the CSP, HSTS and the rest (see §5a). The SPA bucket is
private; CloudFront is the only reader.

**Closed in Phase 3.5** (previously the top blocker): the HTTP API now has a
Cognito JWT authorizer attached to **every route** (`modules/api`,
`aws_apigatewayv2_authorizer`), there is no public route, and
`lambda/api/handler.py` no longer has an `anonymous` fallback — a missing `sub`
is a **401**. `backend/app/security.py` derives the owner id exclusively from
verified claims; the trusted-`X-VisionIQ-User`-header path is gone.

Still open:

- **The CloudFront distribution and the Cognito callback URLs are circularly
  dependent**, so the first apply is a two-step. See §5a.
- **The worker container image is not built by Terraform, and has never been
  built at all** — Docker is not installed on this machine. The worker
  Dockerfile lives at **`backend/Dockerfile`** (build context `backend`) — see
  §4. The ECS service has nothing to run until an image is pushed and the tag
  passed via `-var="worker_image_tag=<tag>"`. A `check` block in `main.tf`
  (`prod_uses_immutable_image_tag`) forbids `latest` when `environment = "prod"`.
- **The SPA sign-in flow is IMPLEMENTED but UNVERIFIED against live Cognito.**
  Phase 3.6 added `frontend/src/auth/`: the authorization code flow with PKCE
  (S256) against the hosted UI, `AuthProvider` wiring `setTokenProvider()` to
  an in-memory token store, and `AuthGate` keeping the dashboard behind a
  session. All of it is covered by unit and integration tests with a stubbed
  `fetch` and a stubbed `window.location` — **none of it has ever run against a
  real user pool**, because nothing is deployed and there are no AWS
  credentials on this machine. §8a lists the live checks that remain.
- **No refresh-token rotation in the SPA — by design, not an oversight.** The
  browser never receives a refresh token (`exchangeCodeForTokens` deliberately
  does not read `payload.refresh_token`), because a 30-day credential in any
  JS-readable store turns one XSS into a month of access. Session continuity is
  `prompt=none` silent re-authentication against Cognito's own session cookie.
  The accepted cost: closing the browser, or the Cognito session expiring,
  requires a fresh interactive sign-in. The upgrade path, if persistent
  sessions are ever required, is a backend-for-frontend holding the refresh
  token in an `HttpOnly`, `Secure`, `SameSite` cookie with CSRF protection —
  not implemented, because the deployed API is API Gateway + Lambda with a JWT
  authorizer expecting a bearer token, not a same-origin cookie backend.
- **`environments/prod.tfvars` contains placeholders.** `allowed_origins` is
  `https://visioniq.example.com` and `alarm_email` is
  `visioniq-alerts@example.com`. Both must be replaced before a prod apply.
- The `worker-task-failures` alarm reads `ECS/ContainerInsights`
  `RunningTaskCount`, which only publishes when `enable_container_insights` is
  true (prod). In dev it stays `INSUFFICIENT_DATA`; it is configured
  `treat_missing_data = "notBreaching"` for that reason.

---

## 2. Prerequisites

- AWS account + credentials with permission to create S3, DynamoDB, SQS, VPC,
  ECS/ECR, Lambda, API Gateway, IAM, CloudWatch, SNS and Budgets resources.
- Terraform **1.9.8** (the version pinned in both workflows), AWS CLI v2,
  Docker with Buildx.
- Bedrock model access **explicitly enabled in the console** for the model id in
  your tfvars, if `enable_bedrock = true`.

---

## 2a. Cognito — create a user and get a token

`modules/auth` creates the user pool, a **public** SPA app client
(`generate_secret = false`, since a browser cannot keep a secret) and a hosted-UI
domain whose prefix is derived from a hash of account id + region (Cognito domain
prefixes are globally unique; the account id itself never appears in the name).

What the module configures, from `modules/auth/main.tf` and `variables.tf`:

| Setting | Value |
|---|---|
| Sign-in | email alias (`alias_attributes = ["email", "preferred_username"]`, email auto-verified) |
| Password policy | minimum **12** chars, upper + lower + number + symbol |
| MFA | `OPTIONAL` by default, TOTP (`software_token_mfa`) enabled |
| Advanced security | `AUDIT` — risk telemetry only, inside the free tier. `ENFORCED` is billed per MAU *on top of* the normal price. |
| Auth flows | `ALLOW_USER_SRP_AUTH` + `ALLOW_REFRESH_TOKEN_AUTH` only. `ALLOW_USER_PASSWORD_AUTH` is deliberately absent so the raw password never crosses the wire. |
| OAuth | authorization-code flow, scopes `openid email profile`, exact callback/logout URIs (no wildcards) |
| Token lifetimes | access **1 h**, id **1 h**, refresh **30 d**; revocation enabled |
| User enumeration | `prevent_user_existence_errors = ENABLED` |
| Deletion protection | `ACTIVE` in prod only |

The relevant outputs — all **public by design**, since the SPA ships them in its
bundle, and therefore none is marked `sensitive`:

```bash
cd infrastructure/terraform
terraform output cognito_user_pool_id
terraform output cognito_client_id
terraform output cognito_issuer            # the VISIONIQ_JWT_ISSUER value
terraform output cognito_hosted_ui_domain
```

### Option A — the hosted UI

Open `https://<cognito_hosted_ui_domain>/login?client_id=<cognito_client_id>&response_type=code&scope=openid+email+profile&redirect_uri=<one of cognito_callback_urls>`,
sign up with an email address, confirm the emailed code, and sign in. The
redirect carries `?code=...`; exchange it at the `/oauth2/token` endpoint of the
same domain for `access_token`, `id_token` and `refresh_token`.

The `redirect_uri` must be **exactly** one of `cognito_callback_urls` — the
module passes those straight through and a root `check` block
(`cognito_urls_are_not_wildcards`) rejects wildcards.

### Option B — admin-create a user from the CLI

```bash
POOL=$(terraform output -raw cognito_user_pool_id)
CLIENT=$(terraform output -raw cognito_client_id)
REGION=us-east-1
EMAIL=you@example.com

aws cognito-idp admin-create-user \
  --region "$REGION" --user-pool-id "$POOL" \
  --username "$EMAIL" \
  --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true \
  --message-action SUPPRESS

# Set a permanent password that satisfies the 12-char policy
# (upper + lower + number + symbol).
aws cognito-idp admin-set-user-password \
  --region "$REGION" --user-pool-id "$POOL" \
  --username "$EMAIL" --password 'Corr3ct-Horse!Batt' --permanent
```

Getting a token from the CLI is deliberately awkward: `ALLOW_USER_PASSWORD_AUTH`
is **not** an enabled flow, so `admin-initiate-auth --auth-flow
ADMIN_USER_PASSWORD_AUTH` will be refused, and `USER_SRP_AUTH` needs an SRP
client (`aws-cognito-srp`, Amplify, or boto3's `warrant`-style helper). Use the
hosted UI for a manual token; use SRP from the SPA.

### Call the API with the bearer token

```bash
API=$(terraform output -raw api_endpoint)
TOKEN=<the access_token>

curl -s "$API/api/analyses" -H "Authorization: Bearer $TOKEN" | jq
curl -s -o /dev/null -w '%{http_code}\n' "$API/api/analyses"   # 401 — no token
```

Every route on the HTTP API is authorized. CORS preflight `OPTIONS` is answered
by API Gateway itself and is never authorized, which is expected.

Note which token to send: the backend defaults to `VISIONIQ_JWT_TOKEN_USE=access`,
so send the **access token**, not the id token. Cognito access tokens carry no
`aud` — the audience is checked against `client_id` instead. If you would rather
send id tokens, set `VISIONIQ_JWT_TOKEN_USE=id` and keep the gateway authorizer's
audience in step.

---

## 3. Bootstrap the Terraform state backend (once per account)

`versions.tf` carries a **partial** S3 backend block on purpose — no bucket
name, no account id, nothing environment-specific is committed. The state
bucket cannot be created by the stack that stores its state in it, so create it
out of band:

```bash
REGION=us-east-1
# Pick a globally unique name; do NOT put the account id in it.
STATE_BUCKET=visioniq-tfstate-<random-suffix>
LOCK_TABLE=visioniq-tfstate-lock

aws s3api create-bucket \
  --bucket "$STATE_BUCKET" --region "$REGION" \
  $( [ "$REGION" = us-east-1 ] || echo --create-bucket-configuration LocationConstraint=$REGION )

aws s3api put-public-access-block --bucket "$STATE_BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws s3api put-bucket-versioning --bucket "$STATE_BUCKET" \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption --bucket "$STATE_BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

aws dynamodb create-table --table-name "$LOCK_TABLE" \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST --region "$REGION"
```

Then write a **gitignored** `backend.<env>.hcl` per environment:

```hcl
bucket         = "visioniq-tfstate-<random-suffix>"
key            = "visioniq/dev/terraform.tfstate"
region         = "us-east-1"
dynamodb_table = "visioniq-tfstate-lock"
encrypt        = true
```

Use a **different `key` per environment**. Never share one key across envs.
The bootstrap bucket and lock table are not managed by this stack and must be
removed by hand if you tear the account down.

---

## 4. Build and push the worker image

> **This image has never been built.** Docker is not installed on the machine
> this repo was developed on. The Dockerfile has been reviewed line by line; it
> has not been executed. The first build will take a long time (multi-GB torch
> download) and may need debugging.

The ECS service has nothing to run until an image exists in ECR. From
`backend/Dockerfile`:

- base `python:3.11-slim`, installs **pinned** CPU-only
  `torch==2.14.1+cpu` / `torchvision==0.29.1+cpu` from
  `https://download.pytorch.org/whl/cpu` (cp311 linux wheels for these versions
  were confirmed to exist on that index), then `requirements.txt` +
  `requirements-ml.txt`. Unpinned installs are not reproducible, and the default
  index drags in ~2 GB of CUDA.
- installs `libgl1` and `libglib2.0-0` (opencv, pulled in by ultralytics)
- **bakes `yolov8n.pt` into `/opt/models`** at build time so workers never
  download weights at scale-out (`VISIONIQ_MODEL_DIR=/opt/models`). The bake is
  **fail-fast**: it `cd`s into `$VISIONIQ_MODEL_DIR` (Ultralytics downloads into
  the working directory), then `test -s` the file and asserts its size. The
  earlier `find / ... || true` could silently produce an image with no weights.
- runs as non-root uid `10001`, with `HOME` and `YOLO_CONFIG_DIR` set — the
  Ultralytics settings file is written at import time and needs a writable home
- the `HEALTHCHECK` imports only `app.config`, **not** torch, so the probe does
  not briefly double the container's memory
- `VISIONIQ_ROLE=worker` (default) runs `python -m app.cloud.worker`;
  `VISIONIQ_ROLE=api` runs `uvicorn app.main:app --host 0.0.0.0 --port 8080`

`backend/.dockerignore` (added in Phase 3.5) keeps both virtualenvs, `data/`,
the local SQLite database and `models/` out of the build context.

Manually (after the first apply, when the ECR repo exists):

```bash
cd infrastructure/terraform
REGION=us-east-1
ECR=$(terraform output -raw worker_ecr_repository_url)   # sensitive: embeds the account id
TAG=$(git rev-parse --short HEAD)                        # immutable tag, never "latest"

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "${ECR%%/*}"

docker build -f ../../backend/Dockerfile -t "$ECR:$TAG" ../../backend
docker push "$ECR:$TAG"

# Deploy that exact image. worker_image_tag is a root variable wired through to
# the worker module; a check block refuses "latest" when environment = "prod".
terraform plan -var-file=environments/dev.tfvars \
  -var="worker_image_tag=$TAG" -out=dev.tfplan
terraform apply dev.tfplan
```

Or let CI do it — `deploy.yml` job **(a) build-and-push** tags the image with
`${GITHUB_SHA}` plus the environment name, using `vars.WORKER_CONTEXT`
(default `backend`) and `vars.WORKER_DOCKERFILE` (default `backend/Dockerfile`).

> The image is multi-gigabyte (torch + weights). ECR storage is ~$0.10/GB-month
> and the lifecycle policy keeps 10 tags.

---

## 5. Plan and apply, per environment

```bash
cd infrastructure/terraform

# dev
terraform init -backend-config=backend.dev.hcl -reconfigure
terraform plan  -var-file=environments/dev.tfvars -out=dev.tfplan
terraform apply dev.tfplan

# prod (separate state key -> separate init)
terraform init -backend-config=backend.prod.hcl -reconfigure
terraform plan  -var-file=environments/prod.tfvars -out=prod.tfplan
terraform apply prod.tfplan
```

Always `plan -out` and apply the **saved plan file**. Never `apply
-auto-approve` against prod by hand.

Environment differences (`environments/*.tfvars`):

| Setting | dev | prod |
|---|---|---|
| `log_retention_days` | 7 | 90 |
| `image_expiration_days` | 7 | 30 |
| `allowed_origins` | localhost:5175 | `https://visioniq.example.com` **(placeholder)** |
| `enable_bedrock` | `false` | `true` (claude-3-5-sonnet) |
| `worker_cpu` / `worker_memory` | 1024 / 2048 | 2048 / 8192 |
| `worker_desired_count` / `max` | 0 / 1 | 1 / 6 |
| `alarm_email` | `""` (no subscription) | placeholder address |
| `budget_limit_usd` | 10 | 250 |
| API throttle rate/burst | 10 / 20 | 100 / 200 |
| `queue_age_alarm_seconds` | 1800 | 600 |

Formatting and validation (also enforced by `infra-ci.yml`):

```bash
terraform fmt -check -recursive
terraform init -backend=false -input=false
terraform validate
```

### Immediately after the first apply

1. **Confirm the SNS email subscription.** AWS emails `alarm_email`; alarms are
   silent until someone clicks confirm. (Skipped in dev where it is `""`.)
2. **Push a worker image** (§4) if you have not already.
3. **Activate the `Project` cost allocation tag** in Billing → Cost allocation
   tags, otherwise the budget filter matches nothing and reports account-wide.
4. **Point the frontend** at `terraform output api_endpoint`, and give it the
   Cognito `cognito_user_pool_id`, `cognito_client_id` and
   `cognito_hosted_ui_domain`. These are public by design and ship in the SPA
   bundle; none of the `cognito_*` outputs is marked `sensitive`.
5. **Create your first user** (§2a) — every route is authorized, so without one
   you cannot call the API at all.
6. **Configure the SPA** (§5a).

---

## 5a. Configure the SPA

After `terraform apply`, map the stack outputs onto the frontend's build-time
variables. All four `cognito_*` outputs are public by design and none is marked
`sensitive`.

```bash
cd infrastructure/terraform

cat > ../../frontend/.env.production <<EOF
VITE_API_MODE=cloud
VITE_API_BASE_URL=$(terraform output -raw api_endpoint)
VITE_AUTH_MODE=cognito
VITE_COGNITO_DOMAIN=$(terraform output -raw cognito_hosted_ui_domain)
VITE_COGNITO_CLIENT_ID=$(terraform output -raw cognito_client_id)
VITE_COGNITO_ISSUER=$(terraform output -raw cognito_issuer)
VITE_COGNITO_SCOPES="openid email profile"
VITE_COGNITO_REDIRECT_URI=https://visioniq.example.com
EOF
```

| Terraform output | Frontend variable | Must also equal |
|---|---|---|
| `cognito_hosted_ui_domain` | `VITE_COGNITO_DOMAIN` | — |
| `cognito_client_id` | `VITE_COGNITO_CLIENT_ID` | the backend's `VISIONIQ_JWT_AUDIENCE` |
| `cognito_issuer` | `VITE_COGNITO_ISSUER` | the backend's `VISIONIQ_JWT_ISSUER` |
| `cognito_user_pool_id` | *(not used by the SPA)* | — |
| `api_endpoint` | `VITE_API_BASE_URL` | must appear in the API's `allowed_origins` CORS list |

`VITE_API_MODE=cloud` switches the SPA to the asynchronous choreography —
presign → `PUT` direct to S3 → `POST /api/jobs` → poll `GET /api/jobs/{id}`.
Both modes parse the **same response shapes**; only the number of round trips
differs. Optionally tune the polling:

```dotenv
VITE_JOB_POLL_INTERVAL_MS=2000     # default
VITE_JOB_POLL_TIMEOUT_MS=300000    # default: 5 min, then stop watching
```

Giving up on polling does **not** cancel the job — the Fargate worker carries
on and the finished record shows up in the scan history.

Rules that will bite you if ignored:

- **`VITE_API_MODE=cloud` requires `VITE_AUTH_MODE=cognito`.** The cloud client
  fails closed: with no access token it refuses before the first request rather
  than producing a `401` three steps in.
- **`VITE_API_BASE_URL` must carry no trailing slash** — one is stripped for
  you, but set it from `terraform output -raw api_endpoint` and leave it alone.
  If it is left empty the SPA calls same-origin `/api` paths, which a
  CloudFront-served bundle has no origin behaviour for.

- **`VITE_COGNITO_REDIRECT_URI` must be the bare origin with no path**, and it
  must appear verbatim in `cognito_callback_urls` *and* `cognito_logout_urls`
  in your `*.tfvars`. Cognito matches the string exactly. The app uses the same
  value for the callback and the logout return.
- **It must be `https` in a production build.** An `http://` redirect URI
  resolves to `misconfigured` and the app renders a configuration error rather
  than a dashboard — an authorization code returned over plaintext is
  interceptable.
- **`VITE_AUTH_MODE=local` in a production build also resolves to
  `misconfigured`.** That fail-closed check is deliberate: a shipped local
  bypass would authenticate every visitor as the same tenant. Do not remove it.
- Every `VITE_*` value is embedded in the bundle and is public. Nothing secret
  goes here; the app client is a public client (`generate_secret = false`) and
  PKCE is what replaces the missing secret.

### The two-step first apply

The SPA's origin is the CloudFront distribution domain, and that domain must be
registered in Cognito's `callback_urls` and `logout_urls` — but the
distribution does not exist until the first apply. Cognito matches callback
URLs **exactly**, so you cannot guess it. The first apply is therefore two
passes:

```bash
cd infrastructure/terraform

# Pass 1 — create everything, including the distribution. Sign-in will not
# work yet: Cognito has no callback URL pointing at the new domain.
terraform apply -var-file=environments/dev.tfvars

terraform output -raw frontend_url     # e.g. https://d111111abcdef8.cloudfront.net

# Pass 2 — feed that origin back in as a callback/logout URL and re-apply.
# Put it in your *.tfvars rather than on the command line so it is recorded.
#   cognito_callback_urls = ["https://d111111abcdef8.cloudfront.net", ...]
#   cognito_logout_urls   = ["https://d111111abcdef8.cloudfront.net", ...]
terraform apply -var-file=environments/dev.tfvars
```

Pass 2 updates only the Cognito user-pool client; it does not replace the
distribution. If you are putting a custom domain in front of CloudFront,
register **that** origin instead and skip the churn — but the same exact-match
rule applies.

### Build and upload the bundle

`terraform apply` creates the bucket and the distribution; it does **not**
upload the SPA. Build it with the `.env.production` above, sync it, then
invalidate CloudFront's cache — otherwise edge locations keep serving the
previous `index.html` and its stale asset references.

```bash
cd frontend
npm ci
npm run lint && npm run typecheck && npm test && npm run build

BUCKET=$(terraform -chdir=../infrastructure/terraform output -raw frontend_bucket_name)
DIST=$(terraform -chdir=../infrastructure/terraform output -raw frontend_distribution_id)

# Hashed assets first, cached hard — their names change on every build.
aws s3 sync dist/ "s3://${BUCKET}/" \
  --delete \
  --exclude index.html \
  --cache-control "public,max-age=31536000,immutable"

# index.html last, never cached — it is the file that names the new assets.
aws s3 cp dist/index.html "s3://${BUCKET}/index.html" \
  --cache-control "no-cache"

aws cloudfront create-invalidation --distribution-id "${DIST}" --paths "/index.html"
```

Order matters: upload assets **before** `index.html`, so the new `index.html`
never references an object that is not there yet. Invalidating `/index.html`
alone is enough when the assets are content-hashed, and it keeps you inside
the free 1,000 invalidation paths per month — `--paths "/*"` burns the same
allowance for no benefit.

> The root module re-exports the frontend module's outputs as
> `frontend_bucket_name`, `frontend_distribution_id`, `frontend_url` and
> `frontend_content_security_policy` (`infrastructure/terraform/outputs.tf`).
> **None of this has been run** — nothing is deployed and there are no AWS
> credentials on this machine.

---

## 6. GitHub OIDC role and protected environments

`deploy.yml` is **`workflow_dispatch` only** — no `push`, no `pull_request`.
Infrastructure is never applied automatically from a commit. Authentication is
GitHub OIDC; there are no long-lived AWS access keys and no account id or ARN
is hardcoded anywhere in the workflow.

1. **AWS side.** Create an IAM OIDC identity provider for
   `token.actions.githubusercontent.com`, and an IAM role whose trust policy is
   scoped to this repository — and, for the prod role, to `environment:prod`.
2. **GitHub → Settings → Environments.** Create `dev` and `prod`.
   **For `prod`, enable "Required reviewers".** That protection rule is the
   *only* thing that makes the `terraform-apply` job pause for human approval;
   without it the apply job runs unattended. Consider enabling it on `dev` too.
3. **Per-environment variables** (Settings → Environments → `<env>` → Variables):

   | Name | Example |
   |---|---|
   | `AWS_REGION` | `ap-south-1` |
   | `ECR_REPOSITORY` | `visioniq-worker` |
   | `WORKER_CONTEXT` | `backend` (default) |
   | `WORKER_DOCKERFILE` | `backend/Dockerfile` (default) |

4. **Per-environment secret:** `AWS_DEPLOY_ROLE_ARN` — the role to assume via
   OIDC.

Job graph: **build-and-push** → **terraform-plan** (uploads `tfplan.binary` +
`tfplan.txt` as an artifact, 7-day retention) → **terraform-apply**, which only
runs when the `apply` input is `true` and is gated by the target environment's
protection rules. The apply downloads the saved plan artifact and applies that
exact plan — it never re-plans. `concurrency: deploy-<env>` with
`cancel-in-progress: false` prevents overlapping applies.

Workflow permissions: `id-token: write` (OIDC) and `contents: read` only.

The other three workflows never touch AWS:
`backend-ci.yml` (ruff + pytest on a **Python 3.10 and 3.11 matrix**, `x64`
only, installing `requirements-dev.txt` with `VISIONIQ_DETECTION_PROVIDER=null`
and no `requirements-ml.txt`),
`frontend-ci.yml` (lint, `tsc --noEmit`, build), and `infra-ci.yml`
(`fmt -check`, `init -backend=false`, `validate`, plus a soft-fail tfsec SARIF
scan). `infra-ci.yml` explicitly never plans against real credentials.

---

## 7. Switching the application to cloud mode

Set these on the ECS worker task definition **and** on the API runtime:

```bash
VISIONIQ_CLOUD_MODE=1
VISIONIQ_STORAGE=s3
VISIONIQ_REPOSITORY=dynamodb
VISIONIQ_S3_BUCKET=$(terraform output -raw image_bucket_name)
VISIONIQ_DYNAMODB_TABLE=$(terraform output -raw analyses_table_name)
VISIONIQ_JOBS_QUEUE_URL=$(terraform output -raw inference_queue_url)   # sensitive
AWS_REGION=us-east-1

# --- Authentication (required in the cloud) ---
VISIONIQ_AUTH_MODE=apigateway                                  # behind the HTTP API
VISIONIQ_JWT_ISSUER=$(terraform output -raw cognito_issuer)
VISIONIQ_JWT_AUDIENCE=$(terraform output -raw cognito_client_id)
# optional, all have working defaults:
# VISIONIQ_JWKS_URL=<issuer>/.well-known/jwks.json   (derived when unset)
# VISIONIQ_JWT_TOKEN_USE=access                      (or "id")
# VISIONIQ_JWT_LEEWAY=30
# VISIONIQ_JWKS_CACHE_TTL=3600

# optional
VISIONIQ_INSIGHTS_PROVIDER=bedrock
VISIONIQ_BEDROCK_MODEL_ID=anthropic.claude-3-5-sonnet-20241022-v2:0
VISIONIQ_DETECTION_PROVIDER=yolo        # default; in-container weights at /opt/models
```

Use `VISIONIQ_AUTH_MODE=apigateway` when the app sits behind the HTTP API: the
gateway's JWT authorizer has already verified signature, issuer, audience and
expiry, so the app reads the claims it passes through and only re-checks that
`sub` is present (and, when `VISIONIQ_JWT_ISSUER` is set, that `iss` matches).
Use `jwt` only if you expose FastAPI directly, in which case this process does
the full JWKS verification itself. Either way the owner id comes from the
verified `sub` and from nowhere else.

The **worker** task does not serve HTTP, so `VISIONIQ_AUTH_MODE` is irrelevant
to it; it takes `owner_id` from the SQS message the authorized API wrote.

What each flag changes:

| Flag | Effect |
|---|---|
| `VISIONIQ_AUTH_MODE` | Selects the identity source: `none` (pseudo-tenant `local`), `apigateway`, or `jwt`. Anything else → `503 auth_misconfigured`. **This, not `VISIONIQ_CLOUD_MODE`, controls authentication.** |
| `VISIONIQ_CLOUD_MODE=1` | Reports `execution_mode: "cloud"`. It no longer has any bearing on identity. |
| `VISIONIQ_STORAGE=s3` | Enables `/api/uploads/presign` and `/api/jobs` (otherwise `503 cloud_disabled`); images go to the private bucket with SSE-AES256. |
| `VISIONIQ_REPOSITORY=dynamodb` | Switches to `DynamoAnalysisRepository`; requires `VISIONIQ_DYNAMODB_TABLE` or construction raises. |
| `VISIONIQ_JOBS_QUEUE_URL` | Required by `jobs.enqueue()` and by the worker loop; empty makes the worker log `worker_misconfigured` and exit `1`. |

No secrets belong in any of these: they are resource identifiers. The queue URL
and ECR URL are marked `sensitive` in `outputs.tf` because they embed the
account id — keep them out of logs and commits.

---

## 8. Verification

Nothing below has been executed. Run it in order after a real apply.

1. **Worker is alive.** CloudWatch Logs under the `log_group_prefix` output
   should show `worker_model_ready` then `worker_started`. If instead you see
   `worker_model_unavailable`, the image is missing torch or the weights.
2. **Control plane.** Get a token first (§2a).
   ```bash
   API=$(terraform output -raw api_endpoint)
   AUTH="Authorization: Bearer $TOKEN"

   curl -s "$API/health"                            # {"status":"healthy"}
   curl -s "$API/api/system/status" -H "$AUTH" | jq
   ```
   `system/status` should report `execution_mode: "cloud"` and
   `auth_mode: "apigateway"`. Note that with auth enabled it **deliberately
   stops reporting** `storage_backend`, `repository_backend` and
   `insights_provider`, and gives only a generic
   `model_unavailable_reason` — the endpoint is reachable pre-sign-in, so it no
   longer advertises backend topology or internal failure strings.
3. **Auth negative check.** Every route must reject an unauthenticated call:
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' "$API/api/analyses"             # 401
   curl -s -o /dev/null -w '%{http_code}\n' "$API/api/analyses" \
     -H 'Authorization: Bearer not.a.token'                                  # 401
   ```
4. **Presign → PUT → job → poll.**
   ```bash
   PRESIGN=$(curl -s -X POST "$API/api/uploads/presign" -H "$AUTH" \
     -H 'Content-Type: application/json' \
     -d '{"filename":"shelf.jpg","content_type":"image/jpeg","size_bytes":241763}')
   URL=$(echo "$PRESIGN" | jq -r .upload.url)
   KEY=$(echo "$PRESIGN" | jq -r .upload.key)
   ID=$(echo  "$PRESIGN" | jq -r .analysis_id)

   curl -X PUT "$URL" \
     -H 'Content-Type: image/jpeg' \
     -H 'x-amz-server-side-encryption: AES256' \
     --data-binary @shelf.jpg

   curl -s -X POST "$API/api/jobs" -H "$AUTH" -H 'Content-Type: application/json' \
     -d "{\"analysis_id\":\"$ID\",\"image_key\":\"$KEY\"}"     # 202, status "queued"

   curl -s "$API/api/jobs/$ID" -H "$AUTH" | jq '.status, .detection.status, .detection.detection_count'
   ```
   Expect `queued` → `processing` → `completed`. A `completed` record with
   `detection.status == "unavailable"` means the worker ran but has no model —
   that is a deployment bug, not an empty shelf.
5. **Tenancy checks.** With a **second** Cognito user's token:
   - `GET /api/jobs/<first user's id>` must return **404**, not 403 — a 403
     would confirm the record exists under another tenant.
   - `POST /api/jobs` naming the first user's key prefix must return
     `403 forbidden` (that is a client-supplied storage key, not a lookup).
   - An oversized object must return `413` *and* be deleted from the bucket.
6. **Idempotency.** Repeat the same `POST /api/jobs` — the existing record must
   come back and nothing new should be enqueued (`job_already_exists` in logs).
7. **DLQ.** Put a malformed message on the main queue; after 3 receives it must
   land on the DLQ and raise the alarm.
8. **Autoscaling does not kill a running job.** Queue one analysis and watch the
   worker scale-in alarm while it is in flight. Both alarms now use metric math
   over `ApproximateNumberOfMessagesVisible + ApproximateNumberOfMessagesNotVisible`.
   This is a **bug fix**: previously both alarms read only `...MessagesVisible`,
   and an in-flight message is *not* visible, so the backlog read as 0 and the
   scale-in alarm terminated the task mid-inference; after three such cycles the
   job landed on the DLQ.
9. **X-Ray traces appear.** The Lambdas have `tracing_config = Active` and now
   also have `xray:PutTraceSegments` / `xray:PutTelemetryRecords` in their IAM
   policy. Without those permissions tracing is enabled but every segment is
   silently dropped, which looks identical to "no traffic".
10. **Cost guardrails.** Confirm the budget exists and the `Project` cost
    allocation tag is active. See `docs/cost/README.md`.

### 8a. SPA sign-in — the checks that still need a live pool

The frontend auth code is fully unit- and integration-tested with a stubbed
`fetch` and a stubbed `window.location`, but **a stub cannot prove Cognito
agrees with us**. Everything below requires a deployed user pool and has
**never been run**. Do it in order, in a normal (non-incognito) browser window,
with the SPA built per §5a.

1. **Create a user.** §2a, either via the hosted UI sign-up or
   `admin-create-user` + `admin-set-user-password`. Confirm the user is in
   `CONFIRMED` state — a `FORCE_CHANGE_PASSWORD` user will stall at the hosted
   UI, not at the SPA.
2. **Load the SPA signed out.** Expect a brief redirect to
   `/oauth2/authorize?...&prompt=none` and a return with
   `?error=login_required`, landing on the **login screen** — not an error
   screen, and not a redirect loop. Confirm the address bar is clean
   afterwards: `history.replaceState` should have stripped `error`.
3. **Sign in via the hosted UI.** Click **Sign in**. Confirm in devtools that
   the authorize URL carries `response_type=code`,
   `code_challenge_method=S256`, a `state`, and **no** `prompt=none`. Confirm
   the Cognito login form appears at the `cognito_hosted_ui_domain`.
4. **Confirm the callback.** After submitting credentials the browser returns
   to the bare origin with `?code=…&state=…`. Confirm:
   - the `POST {domain}/oauth2/token` request carries `code_verifier` and
     **no** `client_secret`;
   - the response is `200` and the dashboard renders with the signed-in email
     in the header;
   - the address bar no longer shows `code` or `state`;
   - `sessionStorage` contains no `visioniq.pkce.*` keys (consumed and cleared);
   - `localStorage` and `sessionStorage` contain **no token of any kind**, and
     in particular no refresh token.
5. **Confirm a bearer token reaches the API.** Upload an image. In the network
   tab, `POST /api/uploads/presign` and `POST /api/jobs` must carry
   `Authorization: Bearer <access token>`, and the XHR `PUT` to S3 must **not**
   (it is presigned). Decode the access token and check `token_use: "access"`
   and `client_id` equal to `cognito_client_id` — the backend's
   `VISIONIQ_JWT_TOKEN_USE` defaults to `access` and compares `client_id`
   against `VISIONIQ_JWT_AUDIENCE`. Confirm the resulting record's `owner_id`
   is the token's `sub`, not `local`.
6. **Confirm reload behaves.** Refresh the page. The in-memory token is gone,
   so the SPA should silently re-authenticate against Cognito's session cookie
   and land back on the dashboard with **no** login form.
7. **Confirm sign-out.** Click sign out. The browser must navigate to
   `{domain}/logout?client_id=…&logout_uri=…` and return to the origin. Then
   reload: the silent attempt must now fail with `login_required` and show the
   login screen. If it signs you straight back in, the hosted-UI logout was
   skipped and Cognito's session cookie survived.
8. **Confirm expiry.** Either wait out the access-token lifetime or shorten it
   in the app client. One minute before expiry (`EXPIRY_SKEW_MS = 60_000`) the
   app must move to the **session expired** screen, and no request may carry
   the stale token. Separately, a `401` from the API must drive the same
   transition via `onUnauthorized`.
9. **Confirm the negative config paths on the real build.** Build once with
   `VITE_AUTH_MODE=local` and once with a missing `VITE_COGNITO_CLIENT_ID`;
   both must render the configuration-error screen and never a dashboard.

---

## 9. Teardown

```bash
cd infrastructure/terraform

# Empty the versioned image bucket first — terraform cannot delete a non-empty
# bucket, and versioning means "empty" includes old versions and delete markers.
BUCKET=$(terraform output -raw image_bucket_name)
aws s3api delete-objects --bucket "$BUCKET" --delete "$(aws s3api list-object-versions \
  --bucket "$BUCKET" --output json \
  --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}')" 2>/dev/null || true
aws s3api delete-objects --bucket "$BUCKET" --delete "$(aws s3api list-object-versions \
  --bucket "$BUCKET" --output json \
  --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}')" 2>/dev/null || true

terraform destroy -var-file=environments/dev.tfvars
```

- The ECR repository is created with `force_delete = true`, so images do not
  block the destroy.
- In **prod**, `deletion_protection_enabled` is true on the DynamoDB table.
  Destroying prod requires turning that off first — deliberately annoying.
- In **prod**, the Cognito user pool has `deletion_protection = ACTIVE`. Turn it
  off before destroying prod.
- The bootstrap state bucket and lock table are **not** managed here.

Full teardown checklist, including what needs separate cleanup:
[`docs/cost/README.md`](../cost/README.md).

To stop paying without destroying anything:

```bash
terraform apply -var-file=environments/dev.tfvars -var worker_desired_count=0
```

The worker is the only always-on compute in the stack. There is **no NAT
Gateway** by design (~$32/month per AZ before any traffic): Fargate tasks run in
public subnets with `assign_public_ip = true` behind an egress-only security
group with zero ingress rules, plus free gateway VPC endpoints for S3 and
DynamoDB. See the cost table in `infrastructure/terraform/README.md`.
