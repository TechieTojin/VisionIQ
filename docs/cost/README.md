# Cost Model

What a VisionIQ deployment costs, what costs money even when nobody is using it,
and how to turn it off.

> **Nothing is deployed.** `terraform plan` has never been run — there are no AWS
> credentials on this machine — so there is no bill to compare against. Every
> figure here is a **us-east-1 list price used as a planning aid, not a quote**.
> Confirm against the AWS pricing pages and your own Cost Explorer before
> committing to a budget. Figures are drawn from the cost table in
> [`infrastructure/terraform/README.md`](../../infrastructure/terraform/README.md),
> which is the source of truth.

---

## 1. The two big costs this design avoids

Before the line items, the two decisions that dominate everything else:

| Avoided | Why it matters |
|---|---|
| **No NAT Gateway** | Roughly **$32/month per AZ before a single byte of traffic**, plus ~$0.045/GB processed. It would have been the largest line item in the whole stack. Avoided by running Fargate tasks in **public subnets with `assign_public_ip = true`**, behind an egress-only security group with **zero ingress rules**, plus **free gateway VPC endpoints** for S3 and DynamoDB so bulk traffic never leaves the AWS network. |
| **No interface VPC endpoints** | Each costs roughly **$7/month per AZ** plus per-GB charges. SQS, ECR (api + dkr) and CloudWatch Logs are reached over the internet gateway on 443 from a task with a public IP. For this workload the public TLS path is equivalent in security — the security group has no ingress at all. |

Gateway endpoints (S3, DynamoDB) are a different product from interface
endpoints and are **free**. Those are the ones the stack uses.

---

## 2. What bills while completely idle

"Idle" means no requests, no analyses, `worker_desired_count = 0`.

| Resource | What you pay for | Dev (~$/mo) | Prod (~$/mo) |
|---|---|---|---|
| **S3 storage** | $0.023/GB-mo for whatever uploads have not yet aged out. Versioning is on, so **noncurrent versions count**. | ~$0.10 | ~$2.00 |
| **DynamoDB storage** | $0.25/GB-mo. On-demand billing means no provisioned capacity charge. | ~$0.05 | ~$1.00 |
| **DynamoDB PITR** | $0.20/GB-mo of continuous backup. Prod only; disabled in dev. | $0.00 | ~$0.25 |
| **CloudWatch Logs storage** | $0.03/GB-mo, bounded by `log_retention_days` (7 dev / 90 prod). | ~$0.05 | ~$1.00 |
| **ECR storage** | $0.10/GB-mo. A torch image is ~5 GB and the lifecycle policy keeps 10 tags — this is the single largest idle cost in dev. | ~$0.50 | ~$1.00 |
| **CloudWatch alarms** | $0.10/alarm/mo standard; **$0.30** for metric-math or extended-statistic alarms — and the worker autoscaling alarms are now metric-math. | ~$0.60 | ~$1.00 |
| **CloudWatch dashboard** | First 3 per account are free, $3 each after. | $0.00 | ~$3.00 |
| **Container Insights** | Custom metrics at $0.30 each. Prod only. | $0.00 | ~$2.00 |
| **SNS** | 1,000 email notifications/month free; the topic itself is free. | ~$0.00 | ~$0.00 |
| **AWS Budgets** | First 2 budgets per account are free. | $0.00 | $0.00 |
| **Cognito** | Free up to the **50,000 monthly active users** free tier; above that, per-MAU. `advanced_security_mode = "AUDIT"` stays inside the free tier. | $0.00 | $0.00 |
| **ECS Fargate (warm task)** | Prod keeps 1 warm 2 vCPU / 8 GB task ≈ $0.04/h. Dev runs zero. | ~$0.00 | ~$30.00 |
| **CloudFront (SPA delivery)** | The distribution itself is free. The perpetual free tier covers **1 TB/month of data transfer out and 10,000,000 HTTP/HTTPS requests**; a SPA that nobody is loading consumes neither. | $0.00 | $0.00 |
| **S3 storage for the SPA bundle** | $0.023/GB-mo. The whole production bundle is ~264 kB (253.03 kB JS + 10.15 kB CSS + `index.html`), so this rounds to nothing. | ~$0.00 | ~$0.00 |
| **VPC, subnets, IGW, gateway endpoints** | Nothing. | $0.00 | $0.00 |
| **Idle total** | | **≈ $1.50/mo** | **≈ $45/mo** |

Dev idle is essentially **ECR storage + logs + alarms**. CloudFront and the SPA
bucket add nothing measurable at rest — the distribution has no hourly charge and
the bundle is a few hundred kilobytes.

**`price_class` is the CloudFront cost lever.** `modules/frontend` defaults to
**`PriceClass_100`**, the cheapest: edge locations in North America and Europe
only. Viewers elsewhere are still served — just from a farther edge, with higher
latency. `PriceClass_200` adds Asia/Middle East/Africa and `PriceClass_All`
adds South America and Oceania, both at higher per-GB and per-request rates.
Raise it only when you have users whose latency justifies it.

### Cognito, specifically

The user pool is free up to **50,000 MAU**. Switching
`advanced_security_mode` from `AUDIT` to `"ENFORCED"` (adaptive authentication)
is billed **per monthly active user on top of the normal MAU price**, so AUDIT is
the default in `modules/auth`. Change it deliberately, not by habit. The hosted
UI domain and the app client cost nothing.

---

## 3. What bills only per use

| Resource | Unit price | Notes |
|---|---|---|
| **ECS Fargate (per analysis)** | ~$0.00002/vCPU-second, billed **per second** while the task runs | A 30 s 1-vCPU inference is well under a cent. The cost is the task's *uptime*, not the number of messages — a task kept warm for an hour costs an hour. |
| **SQS requests** | 1M requests/month free, $0.40/M after | Long polling (20 s) keeps the receive count low; an idle queue is not a billing event. |
| **API Gateway HTTP API** | $1.00/M requests | Cheaper than REST API; the authorizer adds no separate charge. |
| **Lambda (control plane)** | 1M requests + 400k GB-s/month free tier | arm64 is cheaper still. |
| **S3 requests** | PUT $0.005/1k, GET $0.0004/1k | Browsers PUT directly via presigned URLs, so these are per upload. |
| **DynamoDB requests** | $1.25/M writes, $0.25/M reads (on-demand) | Polling `GET /api/jobs/{id}` is a read per poll — tune the client's poll interval. |
| **CloudWatch Logs ingest** | **$0.50/GB ingested** | The sneaky one: ingest usually costs more than storage. Keep the worker at `INFO`, never `DEBUG`. |
| **Bedrock** | Per input/output token, model-dependent | Off in dev (`enable_bedrock = false`). Prod cost depends entirely on volume. |
| **CloudFront data transfer out** | **Free to 1 TB/month**, then ~**$0.085/GB** in North America/Europe (higher elsewhere) | The SPA bundle is ~264 kB, so 1 TB is on the order of millions of cold page loads. Assets are content-hashed and served `max-age=31536000,immutable`, so repeat visitors re-fetch only `index.html`. |
| **CloudFront requests** | **Free to 10M/month**, then ~$0.0075–$0.01 per 10,000 HTTPS requests | A page load is a handful of requests, not one. |
| **CloudFront invalidations** | **Free to 1,000 paths/month**, then ~$0.005 per path | Invalidate `/index.html` on each deploy, not `/*`: with content-hashed assets a single path is sufficient, and `/*` spends the same allowance for nothing. |
| **Data transfer out** | ~$0.09/GB to the internet after the free tier | Presigned GETs of shelf images go straight from S3 to the browser; S3↔worker traffic rides the free gateway endpoints. |

---

## 4. Minimum-cost dev deployment

The `environments/dev.tfvars` profile is already shaped for this. The levers, in
order of effect:

```hcl
# environments/dev.tfvars — the cost-relevant settings
worker_desired_count  = 0      # the only always-on compute in the stack
worker_max_count      = 1
log_retention_days    = 7      # caps Logs storage; ingest is the bigger cost
image_expiration_days = 7      # shelf images are large and rarely needed twice
enable_bedrock        = false  # no per-token spend
budget_limit_usd      = 10
```

Three more savings are **not** tfvars — `main.tf` derives them from
`var.environment`, so any environment other than `"prod"` gets them
automatically: Container Insights (`enable_container_insights = var.environment
== "prod"`, custom metrics at $0.30 each), DynamoDB PITR, and deletion
protection on the table and the Cognito pool.

Applied:

```bash
cd infrastructure/terraform
terraform plan -var-file=environments/dev.tfvars \
  -var="worker_image_tag=$(git rev-parse --short HEAD)" -out=dev.tfplan
terraform apply dev.tfplan
```

**Estimated idle cost: ≈ $1.50/month**, essentially ECR image storage, a little
log storage and the CloudWatch alarms. Per-analysis cost on top of that is
fractions of a cent, dominated by how long the Fargate task stays up rather than
by the inference itself.

To stop paying without destroying anything — scale the worker to zero:

```bash
terraform apply -var-file=environments/dev.tfvars -var worker_desired_count=0
```

The budget module enforces `budget_limit_usd` (10 dev / 250 prod) with alerts at
50/80/100% of actual spend plus a forecasted 100% alert. Those **notify**; they
do not block spending. The budget filter only works once the `Project` cost
allocation tag is activated in Billing → Cost allocation tags — otherwise it
matches nothing and reports account-wide.

---

## 5. Teardown

```bash
cd infrastructure/terraform

# Empty the versioned image bucket FIRST — terraform cannot delete a non-empty
# bucket, and with versioning on, "empty" includes noncurrent versions and
# delete markers. Both commands are needed.
BUCKET=$(terraform output -raw image_bucket_name)
aws s3api delete-objects --bucket "$BUCKET" --delete "$(aws s3api list-object-versions \
  --bucket "$BUCKET" --output json \
  --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}')" 2>/dev/null || true
aws s3api delete-objects --bucket "$BUCKET" --delete "$(aws s3api list-object-versions \
  --bucket "$BUCKET" --output json \
  --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}')" 2>/dev/null || true

terraform destroy -var-file=environments/dev.tfvars
```

### Things `terraform destroy` will not handle for you

| Resource | What to do |
|---|---|
| **Versioned S3 image bucket** | Must be emptied first, **including noncurrent versions and delete markers** — the two `delete-objects` calls above. A bucket that looks empty in the console can still hold versions you are paying for. |
| **Versioned SPA bucket** | `modules/frontend` enables versioning (instant rollback of a bad SPA deploy) and a lifecycle rule to expire old bundle versions. Like the image bucket, it must be emptied **including noncurrent versions and delete markers** before the destroy will succeed. The objects are tiny, so this is an obstacle rather than a cost. |
| **CloudFront distribution** | Destroying one is slow: Terraform disables it and waits for the change to propagate to every edge before the delete completes. Budget several minutes, and do not interrupt it. |
| **ECR images** | The repository is created with `force_delete = true`, so images do not block the destroy. If you keep the repo, delete old images by hand — ~5 GB per torch image at $0.10/GB-mo adds up. |
| **CloudWatch log groups** | Destroyed with the stack. If you set a long `log_retention_days` and keep any group, its stored data keeps billing at $0.03/GB-mo. |
| **DynamoDB deletion protection (prod)** | `deletion_protection_enabled` is true on the prod table. Turn it off before destroying prod — deliberately annoying. |
| **Cognito deletion protection (prod)** | The prod user pool has `deletion_protection = ACTIVE`. Turn it off before destroying prod; the destroy fails otherwise. Deleting the pool deletes every user. |
| **Terraform state bucket and lock table** | **Not managed by this stack.** They were bootstrapped out of band (see `infrastructure/terraform/README.md` §State backend) and must be removed by hand if you are tearing the whole account down. The state bucket is versioned, so it needs the same noncurrent-version cleanup. |

---

## 6. Caveat

Every number on this page is a **us-east-1 list price**, collected as a planning
aid. It is not a quote. It does not account for your region, your Savings Plans
or committed-use discounts, free-tier consumption elsewhere in the account, data
transfer patterns, or support plan charges. No deployment has ever been made from
this repository, so none of it has been checked against a real invoice. Treat the
AWS pricing pages and Cost Explorer as authoritative.
