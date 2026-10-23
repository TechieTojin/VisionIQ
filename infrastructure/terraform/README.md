# VisionIQ — Terraform

> ## ⚠ Architecture demonstration — deliberately NOT deployed
>
> **Do not run `terraform apply`.** This project runs on a strict **$0
> budget**. There is no AWS account, nothing here has ever been applied, and
> applying it **would create billing-capable resources** — see the cost table
> below (≈ $1.50/month for dev, and some resources bill while completely
> idle).
>
> This stack exists to show the architecture and to be verified statically:
> `terraform fmt` and `terraform validate` pass, and the Lambda handler is
> covered by cross-component contract tests in `backend/tests/`. That is the
> intended extent of its use.
>
> The public demo is the React frontend on Vercel Hobby in demo mode, which
> costs nothing — see [`../../docs/deployment/free-hosting.md`](../../docs/deployment/free-hosting.md).
>
> If you ever do intend to deploy, read
> [`../../docs/deployment/aws-account-setup.md`](../../docs/deployment/aws-account-setup.md)
> first and set up billing alarms **before** the first apply.

Infrastructure for the VisionIQ async shelf-analysis pipeline.

```
Client ──presign──▶ API (Lambda)            ┌─────────────────────────┐
Client ──PUT──────▶ S3 (private)            │ ECS Fargate worker      │
Client ──create───▶ API ──▶ DynamoDB queued │  long-polls SQS         │
                      └──▶ SQS ─────────────▶  runs YOLO inference    │
Client ──poll─────▶ API ──▶ DynamoDB        │  writes DynamoDB result │
                                            └─────────────────────────┘
                              optional: Amazon Bedrock narrative insight
```

Inference runs on **Fargate, not Lambda**: torch plus model weights blow past
Lambda's package limit, and the cold start would be worse than the inference.
The small, I/O-bound control-plane operations (presign, create job, get job,
list jobs) *are* on Lambda, where they belong.

---

## Layout

```
infrastructure/terraform/
├── versions.tf             required_version, aws ~> 5.0, partial S3 backend
├── variables.tf            all inputs, with defaults and descriptions
├── main.tf                 module wiring + common tags
├── outputs.tf              bucket / table / api / queue / ecr
├── lambda/api/handler.py   control-plane handlers (packaged by archive_file)
├── environments/
│   ├── dev.tfvars          minimal, scale-to-zero, short retention
│   └── prod.tfvars         warm baseline, long retention, real alarms
└── modules/
    ├── storage        private S3 bucket, lifecycle, CORS, TLS-only policy
    ├── database       DynamoDB table (owner_id / analysis_id) + GSI, PITR, TTL
    ├── queue          SQS main queue + DLQ (maxReceiveCount 3), SSE
    ├── network        VPC, public subnets, gateway endpoints — NO NAT Gateway
    ├── api            HTTP API + 4 Lambdas, throttling, CORS, access logs
    ├── worker         ECR, ECS cluster, Fargate task/service, queue autoscaling
    ├── auth           Cognito user pool, public SPA client, hosted UI domain
    ├── frontend       private SPA bucket + CloudFront (OAC), CSP/security headers
    ├── security       least-privilege IAM for Lambda and the worker
    ├── observability  SNS topic, alarms, dashboard
    └── budget         monthly AWS Budgets with 50/80/100% alerts
```

`network` is not in the original module list but is required: something has to
own the VPC, and keeping it separate is what makes the no-NAT-Gateway decision
reviewable in one file.

---

## State backend

State is kept in S3 with a DynamoDB lock table. `versions.tf` carries a
**partial** backend block on purpose — no bucket name, no account id, nothing
environment-specific is committed.

### Bootstrap (once per account, before the first `init`)

The state bucket cannot be created by the stack that stores its state in it.
Create it out of band:

```bash
REGION=us-east-1
# Pick a globally unique name; do not put the account id in it.
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

Then write a **gitignored** `backend.<env>.hcl`:

```hcl
bucket         = "visioniq-tfstate-<random-suffix>"
key            = "visioniq/dev/terraform.tfstate"
region         = "us-east-1"
dynamodb_table = "visioniq-tfstate-lock"
encrypt        = true
```

Use a different `key` per environment. Never share one key across envs.

---

## Plan and apply, per environment

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

Always `plan -out` and apply the saved plan file. Never `apply -auto-approve`
against prod.

### After the first apply

1. **Confirm the SNS email subscription.** AWS emails `alarm_email`; alarms are
   silent until someone clicks confirm.
2. **Push a worker image.** The ECS service has nothing to run until then:

   ```bash
   ECR=$(terraform output -raw worker_ecr_repository_url)
   REGION=$(terraform output -raw log_group_prefix >/dev/null; echo us-east-1)
   aws ecr get-login-password --region "$REGION" \
     | docker login --username AWS --password-stdin "${ECR%%/*}"
   # The worker image is built from the backend, which holds both the API and
   # the SQS consumer (VISIONIQ_ROLE selects which one runs).
   TAG=$(git rev-parse --short HEAD)
   docker build -f ../../backend/Dockerfile -t "$ECR:$TAG" ../../backend
   docker push "$ECR:$TAG"
   # Then deploy that exact image:
   #   terraform apply -var="worker_image_tag=$TAG" ...
   ```
3. **Activate the `Project` cost allocation tag** in Billing → Cost allocation
   tags, otherwise the budget filter matches nothing and reports account-wide.
4. **Point the frontend** at `terraform output api_endpoint`.
5. **Deploy the SPA and close the Cognito loop** — see the next section.

### Two-step apply: the CloudFront → Cognito callback URL

`modules/frontend` serves the SPA from CloudFront, but **the CloudFront domain
is only known after the distribution exists**, and Cognito's hosted UI refuses
any redirect URI that is not pre-registered. Cognito already feeds the frontend
module (the hosted-UI origin goes into the CSP), so passing the CloudFront URL
back into `module.auth` would be a dependency cycle. It is therefore wired by
hand, once:

```bash
# 1. First apply: creates the bucket, the distribution and the headers policy.
terraform apply dev.tfplan

URL=$(terraform output -raw frontend_url)   # https://d111111abcdef8.cloudfront.net

# 2. Add $URL to allowed_origins, cognito_callback_urls and cognito_logout_urls
#    in environments/dev.tfvars, then plan + apply again.
terraform plan -var-file=environments/dev.tfvars -out=dev.tfplan
terraform apply dev.tfplan
```

Until step 2 is applied, the SPA loads but sign-in fails with
`redirect_mismatch`.

**One-step alternative — a custom domain.** Set `frontend_acm_certificate_arn`
(an ACM certificate in **us-east-1**) and `frontend_aliases`. The URL is then
known before the first apply, so `allowed_origins` and the Cognito URLs can be
correct from the start. The custom-certificate path is also the only one that
can carry `minimum_protocol_version = "TLSv1.2_2021"`: CloudFront fixes the TLS
floor of the default `*.cloudfront.net` certificate and rejects any other value.

### Deploying the SPA bundle

```bash
BUCKET=$(terraform output -raw frontend_bucket_name)
DIST=$(terraform output -raw frontend_distribution_id)

npm --prefix ../../frontend run build
aws s3 sync ../../frontend/dist/ "s3://$BUCKET/" --delete
aws cloudfront create-invalidation --distribution-id "$DIST" --paths '/index.html'
```

Hashed asset filenames are immutable, so only `/index.html` needs invalidating.

### Formatting and validation

```bash
terraform fmt -recursive
terraform validate
```

---

## Cleanup / destroy

```bash
# Empty the versioned image bucket first - terraform cannot delete a non-empty
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

Notes:

- The ECR repository is created with `force_delete = true`, so images do not
  block the destroy.
- In **prod**, `deletion_protection_enabled` is true on the DynamoDB table.
  Destroying prod requires turning that off first — deliberately annoying.
- The bootstrap state bucket and lock table are **not** managed here and must
  be removed by hand if you are tearing the whole account down.

To stop paying without destroying anything:

```bash
terraform apply -var-file=environments/dev.tfvars -var worker_desired_count=0
```

---

## What costs money while idle

The architecture is deliberately shaped so an idle environment costs cents, not
dollars. The single biggest avoided cost is the **NAT Gateway**: roughly
**$32/month per AZ before a single byte of traffic**, which would have been the
largest line item in the whole stack. It is avoided by running Fargate tasks in
**public subnets with `assign_public_ip = true`** behind an egress-only security
group with **no ingress rules at all**, plus **free gateway VPC endpoints** for
S3 and DynamoDB so bulk traffic never leaves the AWS network.

| Resource | Bills when idle? | Dev (~$/mo) | Prod (~$/mo) | Notes |
|---|---|---|---|---|
| NAT Gateway | **would be yes** | **$0.00** | **$0.00** | Not created. Would be ~$32/AZ/mo + $0.045/GB. |
| VPC, subnets, IGW, gateway endpoints | no | $0.00 | $0.00 | Gateway endpoints for S3/DynamoDB are free. |
| ECS Fargate worker | only while running | ~$0.00 | ~$30.00 | Dev `desired_count = 0`. Prod keeps 1 warm 2 vCPU/8 GB task ≈ $0.04/h. |
| Fargate burst (per analysis) | no | ~$0.01 | ~$0.01 | ~$0.00002/vCPU-s; a 30 s 1-vCPU inference is well under a cent. |
| ECR storage | yes | ~$0.50 | ~$1.00 | $0.10/GB-mo. A torch image is ~5 GB; lifecycle keeps 10 tags. |
| S3 storage | yes | ~$0.10 | ~$2.00 | $0.023/GB-mo. Lifecycle expires uploads after `image_expiration_days`. |
| S3 requests | no | ~$0.05 | ~$0.50 | PUT $0.005/1k, GET $0.0004/1k. |
| DynamoDB on-demand | storage only | ~$0.05 | ~$1.00 | $0.25/GB-mo + $1.25/M writes, $0.25/M reads. |
| DynamoDB PITR | yes (prod only) | $0.00 | ~$0.25 | $0.20/GB-mo of continuous backup. Disabled in dev. |
| SQS | no | ~$0.00 | ~$0.10 | 1M requests/mo free; $0.40/M after. Long polling keeps the count low. |
| Lambda (API) | no | ~$0.00 | ~$0.20 | 1M requests + 400k GB-s/mo free tier; arm64 is cheaper still. |
| API Gateway HTTP API | no | ~$0.00 | ~$1.00 | $1.00/M requests. |
| CloudFront | no | ~$0.00 | ~$0.00 | Always-free tier: **1 TB/mo data out + 10M HTTPS requests**, every month, not just year one. Beyond it ~**$0.085/GB** (NA/EU) + $0.01/10k requests. `PriceClass_100` keeps the SPA on North American and European edges only — the cheapest tier; viewers elsewhere are still served, just from a farther edge. No charge for the response headers policy or for OAC. |
| CloudFront invalidations | no | $0.00 | $0.00 | First 1,000 paths/mo free; the deploy invalidates one path. |
| S3 storage (SPA bundle) | yes | ~$0.00 | ~$0.00 | A built Vite bundle is single-digit MB — negligible against $0.023/GB-mo. Noncurrent versions expire after 30 d. |
| CloudWatch Logs ingest | with traffic | ~$0.25 | ~$3.00 | **$0.50/GB ingested** — the sneaky one. Retention 7 d dev / 90 d prod. |
| CloudWatch Logs storage | yes | ~$0.05 | ~$1.00 | $0.03/GB-mo; bounded by `log_retention_days`. |
| CloudWatch alarms | yes | ~$0.60 | ~$1.00 | $0.10/alarm/mo standard, $0.30 for metric-math/extended-statistic alarms. |
| CloudWatch dashboard | yes | $0.00 | ~$3.00 | First 3 dashboards free per account; $3 each after. |
| Container Insights | yes (prod only) | $0.00 | ~$2.00 | Custom metrics at $0.30 each. Disabled in dev. |
| SNS | no | ~$0.00 | ~$0.00 | 1k email notifications/mo free. |
| AWS Budgets | yes | $0.00 | $0.00 | First 2 budgets free per account. |
| Bedrock | no | $0.00 | varies | Per-token. Off in dev; prod depends entirely on volume. |
| **Idle total** | | **≈ $1.50/mo** | **≈ $45/mo** | Dev is essentially storage + logs + alarms. |

Prices are us-east-1 list prices as a planning aid, not a quote; confirm against
the AWS pricing pages and your own Cost Explorer. The `budget` module enforces
`budget_limit_usd` with alerts at 50/80/100% of actual spend plus a forecasted
100% alert.

### Cost levers, in order of effect

1. `worker_desired_count = 0` — the only always-on compute in the stack.
2. `log_retention_days` — log *ingest* at $0.50/GB usually beats storage; keep
   worker logging at INFO, not DEBUG.
3. `image_expiration_days` — shelf images are large and rarely needed twice.
4. `enable_container_insights = false` outside prod.
5. `enable_bedrock = false` unless narratives are actually being used.

---

## Security posture

- **S3**: all four public-access blocks true, `BucketOwnerEnforced` ownership,
  SSE-AES256 with bucket keys, versioning on, a bucket policy that denies any
  request with `aws:SecureTransport = false` and any `PutObject` that would land
  unencrypted. CORS is restricted to `allowed_origins` — never `*`.
- **DynamoDB**: SSE on, PITR in prod, TTL on `expires_at`, deletion protection
  in prod.
- **SQS**: SSE-SQS on both queues, DLQ redrive at `maxReceiveCount = 3`,
  visibility timeout = worker timeout + 60 s headroom so a slow inference is
  never double-processed, and a TLS-only queue policy.
- **IAM**: no `"*"` resource on any data action. The worker can read only
  `uploads/*` and write only `results/*` in the one bucket, and touch only the
  one table and the one queue. The API Lambda can presign only into `uploads/*`.
  ECR pull is scoped to the single repository; only `ecr:GetAuthorizationToken`,
  which supports no resource-level permissions and grants nothing by itself,
  uses `"*"`. The frontend bucket policy is resource-scoped to that bucket's
  objects and principal-scoped to CloudFront with an `AWS:SourceArn` condition
  naming this one distribution; the only other `"*"` resources in the stack are
  `xray:PutTraceSegments`/`PutTelemetryRecords` and `ecr:GetAuthorizationToken`,
  none of which support resource-level permissions or touch data.
- **Network**: worker security group has zero ingress rules; egress is 443 only
  to `0.0.0.0/0`. SQS, ECR (api + dkr) and CloudWatch Logs are reached over the
  internet gateway on 443 from a task with a public IP; S3 and DynamoDB use the
  free gateway VPC endpoints. Interface VPC endpoints are **not** created: each
  costs roughly $7/month per AZ and the public path over TLS is equivalent in
  security for this workload.
- **Auth**: every API route requires a Cognito-issued JWT (see above).
- **Nothing account-specific is committed** — no account ids, no ARNs carrying
  an account id, no bucket names, no secrets. The bucket suffix is a hash of the
  caller account id and region, derived at plan time.

### Frontend delivery, CSP and security headers (`modules/frontend`)

The SPA bucket is **private, with no website endpoint and no public bucket
policy**. CloudFront reaches it through an **Origin Access Control** (SigV4,
`signing_behavior = "always"`) — not a legacy OAI — and the bucket policy grants
`s3:GetObject` to the `cloudfront.amazonaws.com` service principal **only when
`AWS:SourceArn` is this exact distribution**, so no other distribution in any
account can read the bundle. A second statement denies everything over plain
HTTP.

Because the SPA is static there is no server to set headers, so an
`aws_cloudfront_response_headers_policy` is the only place a
**Content-Security-Policy** can be attached. That policy is the point of the
module. It serves:

| Header | Value |
|---|---|
| `Content-Security-Policy` | built in `locals` from the real API / Cognito / bucket origins (below) |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `X-Permitted-Cross-Domain-Policies` | `none` |

The CSP is assembled as a list of directives joined with `"; "`, so it stays
readable in review and is exposed as the `frontend_content_security_policy`
output for assertion in tests. The shape it produces:

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
connect-src 'self' <api origin> <cognito hosted ui> <cognito idp> <image bucket>;
font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none';
frame-src 'none'; form-action 'self' <cognito hosted ui>; upgrade-insecure-requests
```

Why each loosening exists — and nothing else does:

- **`script-src 'self'` with no `'unsafe-inline'` and no `'unsafe-eval'`.** A
  Vite production build emits external, hashed module scripts; neither is
  needed, and both are what turn an injection into an XSS.
- **`style-src 'self' 'unsafe-inline'` — the one exception.** Vite injects the
  stylesheet at runtime and the dashboard uses React inline `style` props.
  Removing it requires per-build style hashes or a per-request nonce, and
  CloudFront's response headers policy is static — it cannot mint a nonce per
  request — so hashes plus a build step emitting them would be the only route.
  Inline *styles* are a far smaller risk than inline scripts; accepted
  deliberately.
- **`img-src ... blob:`** — the dashboard previews the chosen photo with
  `URL.createObjectURL()` before the presigned upload finishes.
- **`connect-src`** names the API Gateway origin, the Cognito hosted-UI origin
  (PKCE token exchange), the Cognito IDP origin (the identity SDK calls it
  directly) and the image bucket origin (the presigned `PUT` goes straight to
  S3, never through the API). All come from module outputs at apply time;
  `frontend_extra_connect_src` is the only way to widen it, and defaults to `[]`.
- **`frame-ancestors 'none'`** makes the `X-Frame-Options` header redundant for
  modern browsers; both are sent.

**SPA routing.** `custom_error_response` maps both **403 and 404 to
`/index.html` with `response_code = 200`**. 403 matters as much as 404: with
OAC, S3 returns `AccessDenied` rather than `NoSuchKey` for a missing key. This
is required for client-side routing *and* for the OAuth callback, which lands
on the root path carrying `?code=...`.

Caching uses the AWS-managed **CachingOptimized** policy by id, compression is
on, and `viewer_protocol_policy = "redirect-to-https"`.

### Authentication (Cognito + API Gateway JWT authorizer)

`modules/auth` creates a Cognito user pool, a **public** SPA app client
(`generate_secret = false` — a browser cannot keep a secret) and a hosted-UI
domain. `modules/api` attaches an `aws_apigatewayv2_authorizer` of type `JWT`
to **every route**: presign, create job, get job and list jobs. There is no
public route on this API; CORS preflight `OPTIONS` is answered by API Gateway
itself and is never authorized.

- Auth flows are limited to `ALLOW_USER_SRP_AUTH` and
  `ALLOW_REFRESH_TOKEN_AUTH`. `ALLOW_USER_PASSWORD_AUTH` is deliberately absent
  so the raw password never crosses the wire.
- Password policy: minimum 12 characters, upper + lower + number + symbol.
- MFA is `OPTIONAL` with TOTP enabled; `prevent_user_existence_errors` is
  `ENABLED`; token revocation is on. Access and ID tokens live 1 hour, refresh
  tokens 30 days.
- Deletion protection is `ACTIVE` only in prod.
- **Cost note:** `advanced_security_mode = "AUDIT"` records risk telemetry and
  stays inside the Cognito free tier. `"ENFORCED"` (adaptive authentication) is
  billed **per monthly active user on top of the normal MAU price**, so AUDIT
  is the default here. Switch deliberately, not by habit.
- `cognito_callback_urls` / `cognito_logout_urls` are exact URIs (dev:
  `http://localhost:5175`), never wildcards. Keep them in step with
  `allowed_origins`.
- The user pool id, app client id, issuer and JWKS URI are **public by design**
  — the SPA ships them in its bundle — so none of the `cognito_*` outputs is
  marked `sensitive`.

`lambda/api/handler.py` derives `owner_id` **exclusively** from
`event.requestContext.authorizer.jwt.claims.sub`, i.e. a claim API Gateway has
already verified. If it is missing the handler returns **401**. There is no
anonymous fallback and the owner id is never read from the body, query string
or a header.

### Known gaps to close before real tenants

- `lambda/api/handler.py` is a working skeleton, not the production
  implementation.
- The worker container image is not built by Terraform. Build and push
  `backend/Dockerfile` to ECR first (see step 2 above), then pass the tag via
  `-var="worker_image_tag=<tag>"`. Until an image exists, the ECS service runs
  zero healthy tasks.
- The `worker-task-failures` alarm reads `ECS/ContainerInsights`
  `RunningTaskCount`, which only publishes when `enable_container_insights` is
  true (prod). In dev that alarm stays in `INSUFFICIENT_DATA`, which is why it
  is configured `treat_missing_data = "notBreaching"`.
- The CloudFront `5xxErrorRate` alarm is created **only when `aws_region` is
  `us-east-1`**, because CloudFront publishes metrics solely to that region
  under the fixed dimension `Region = "Global"`. Deploying the stack elsewhere
  means adding an aliased `us-east-1` provider to `modules/observability`;
  today it is skipped rather than created against a dimension pair that would
  never report.
- The CloudFront domain must be added to the Cognito callback/logout URLs by
  hand after the first apply (see "Two-step apply" above), or a custom domain
  used to avoid the second pass.
