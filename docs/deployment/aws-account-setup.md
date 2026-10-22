# AWS account setup — prerequisites before any deployment

**Status: no AWS account exists yet.** Nothing in this document has been
executed. It is the checklist to work through *before* the deployment runbook
in [`aws.md`](aws.md) becomes possible.

Everything here is done by you in a browser. None of it can be automated from
this machine, and none of it should be: it involves account creation, billing
details and MFA enrolment.

---

## 0. What this will cost

Creating an account costs nothing. Deploying the dev stack is estimated at
**≈ $1.50/month idle** (see [`../cost/README.md`](../cost/README.md)).

Two honest warnings:

- **Free Tier is not zero cost.** Do not assume this account qualifies. Since
  mid-2025 new accounts get a credit-based free plan rather than the old
  12-month per-service allowances, and the terms differ by signup date. Verify
  your own account's status in the Billing console rather than trusting any
  figure in this repository.
- **Some resources bill while completely idle**: S3 storage, DynamoDB storage,
  CloudWatch Logs retention, ECR image storage. The design deliberately avoids
  the expensive idle resources — there is no NAT Gateway (~$32/AZ/month), no
  interface VPC endpoints (~$7/month each) and no always-on compute.

---

## 1. Create the account

1. Go to <https://portal.aws.amazon.com/billing/signup>.
2. Use an email address you control and will keep. A distribution list or
   `+aws` alias is better than a personal inbox that may be lost.
3. Provide payment details. A small temporary authorisation charge is normal.
4. Choose the **Basic (free)** support plan unless you need more.

## 2. Secure the root user — do this immediately

The root user can close the account and change billing. It must never be used
for deployment.

- [ ] Enable **MFA on the root user** (Security Credentials → MFA).
- [ ] Do **not** create root access keys. If any exist, delete them.
- [ ] Store the root password in a password manager.
- [ ] Set up alternate contacts (Account → Alternate Contacts) so billing and
      security notices do not go to one inbox.

After this, sign out of root and do not use it again except for tasks that
genuinely require it (closing the account, changing the support plan).

## 3. Billing safeguards — before you deploy anything

Do this **before** the first `terraform apply`, not after.

- [ ] Billing console → **Billing preferences** → enable *Receive Free Tier
      alerts* and *Receive CloudWatch billing alerts*.
- [ ] **Budgets** → create a zero-spend or low-value budget (e.g. $5) with an
      email alert. This is independent of the Terraform budget module and acts
      as a backstop if Terraform is never applied or is destroyed.
- [ ] Cost Explorer → enable it (takes ~24h to populate).
- [ ] Billing → **Cost allocation tags** → activate the `Project` tag once the
      stack exists, so the Terraform budget's tag filter works. Until then that
      budget reports account-wide.

> The Terraform stack also creates a budget (`budget_limit_usd = 10` in
> `dev.tfvars`). That is a second layer, not a replacement for the manual one.

## 4. Set up IAM Identity Center (SSO)

This gives short-lived credentials instead of long-lived access keys. It is
free and is the recommended path.

1. IAM Identity Center console → **Enable**. Note the region it enables in.
2. Create a user for yourself (Users → Add user) and enrol MFA.
3. **Permission sets** → create one for deployment.
   - To get moving: `AdministratorAccess`. Acceptable for a personal
     development account; **not** acceptable for anything shared.
   - Better: start from `PowerUserAccess` and add the IAM permissions the
     stack needs (it creates roles and policies). Expect to iterate — a plan
     will tell you exactly what is missing.
   - Set the **session duration to 1–4 hours**, not the 12-hour maximum.
4. **AWS accounts** → assign your user + permission set to the account.
5. Note the **AWS access portal URL** (`https://d-xxxxxxxxxx.awsapps.com/start`).

### Configure the CLI

The AWS CLI is already installed on this machine (v2.38.4, verified). In a
**new** terminal — the PATH is only picked up by newly started shells:

```powershell
aws configure sso
```

You will be prompted for:

| Prompt | Value |
|---|---|
| SSO session name | `visioniq` (any label) |
| SSO start URL | your access portal URL from step 5 |
| SSO region | the region Identity Center was enabled in |
| SSO registration scopes | accept the default |
| CLI default client Region | `us-east-1` (matches `dev.tfvars`) |
| CLI default output format | `json` |
| CLI profile name | `visioniq-dev` |

A browser window opens for you to approve the device. Then:

```powershell
aws sso login --profile visioniq-dev
aws sts get-caller-identity --profile visioniq-dev
```

The second command is read-only and free. It prints the account id, the
assumed role ARN and your user id — the first real confirmation that access
works.

> Credentials expire with the session. Re-run `aws sso login` when they do;
> there is nothing long-lived to leak or rotate.

### If you cannot use Identity Center

Fall back to an **IAM user with MFA** and a short-lived session, not raw
long-term keys in a config file:

- Create an IAM user with no console access and a least-privilege policy.
- Enable MFA on it.
- Use `aws sts get-session-token` or an assumed role for actual work.

Never paste access keys, secret keys, session tokens or MFA codes into a chat.
Configure them yourself with `aws configure --profile visioniq-dev`.

## 5. Choose a region

`dev.tfvars` is set to **`us-east-1`**. Two reasons to keep it:

- CloudFront publishes its metrics only to `us-east-1`, so the CloudFront 5xx
  alarm is only created there (the observability module skips it otherwise).
- An ACM certificate for a CloudFront custom domain must live in `us-east-1`.

If you move regions, change `aws_region` in `dev.tfvars` and read the
"Known gaps" section of `infrastructure/terraform/README.md` first.

## 6. GitHub repository (for the container build)

The worker image cannot be built on this machine (no Docker, no WSL, ~600 MB
free RAM). The build runs on GitHub Actions instead.

- [ ] Create a repository (private is fine).
- [ ] Add it as a remote and push:
      ```powershell
      git remote add origin https://github.com/<you>/<repo>.git
      git push -u origin master
      ```
- [ ] The `Worker image (build + scan, no push)` workflow runs immediately and
      needs **no AWS account** — it proves the Dockerfile builds and scans the
      image. Run this before deploying anything.

Later, for pushing images to ECR, configure GitHub OIDC (no stored AWS keys):

- [ ] IAM → Identity providers → add `token.actions.githubusercontent.com`.
- [ ] Create a deploy role trusting that provider, scoped to your repository
      (and ideally to `environment:prod` for the prod role).
- [ ] Repository → Settings → Environments → create `dev` and `prod`.
      **Enable required reviewers on `prod`** — that is the only thing making
      the apply job pause for human approval.
- [ ] Add the secret `AWS_DEPLOY_ROLE_ARN` and the variables `AWS_REGION` and
      `ECR_REPOSITORY` per environment.

## 7. Readiness check

Before opening [`aws.md`](aws.md):

- [ ] `aws sts get-caller-identity` succeeds and is **not** the root user
- [ ] Root has MFA and no access keys
- [ ] A manual budget with an email alert exists
- [ ] Billing alerts enabled
- [ ] Region decided (`us-east-1` unless you changed it)
- [ ] `alarm_email` set to a real address in `dev.tfvars` (currently empty —
      it is deliberately not filled in for you)
- [ ] Repository pushed to GitHub and the image workflow is green

Only then is the first `terraform plan` meaningful.
