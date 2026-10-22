# Prod: sturdier retention, real headroom, alarms that page someone.
# Still NAT-Gateway-free; the worker remains scale-to-zero-capable but keeps a
# warm baseline task so the first analysis of the day is not a cold pull of a
# multi-gigabyte torch image.

project_name = "visioniq"
environment  = "prod"
aws_region   = "us-east-1"

# Longer retention for incident forensics; images live a month.
log_retention_days    = 90
image_expiration_days = 30

# Replace with the real deployed frontend origin before applying.
allowed_origins = [
  "https://visioniq.example.com",
]

enable_bedrock   = true
bedrock_model_id = "anthropic.claude-3-5-sonnet-20241022-v2:0"

# One warm task, room to burst. Bigger memory for full-resolution shelf images.
worker_cpu                        = 2048
worker_memory                     = 8192
worker_desired_count              = 1
worker_max_count                  = 6
worker_processing_timeout_seconds = 300

# Set a real distribution list; the subscription must be confirmed by email.
alarm_email = "visioniq-alerts@example.com"

budget_limit_usd = 250

api_throttle_rate_limit      = 100
api_throttle_burst_limit     = 200
api_p99_latency_threshold_ms = 2000
queue_age_alarm_seconds      = 600

# Cognito hosted-UI redirect targets. Replace with the real frontend origin
# alongside allowed_origins before applying.
cognito_callback_urls = [
  "https://visioniq.example.com",
]
cognito_logout_urls = [
  "https://visioniq.example.com",
]

# worker_image_tag is deliberately NOT set here: prod must never run a mutable
# "latest" tag. The deploy workflow passes the immutable git SHA with
# -var="worker_image_tag=<sha>". A `check` block in main.tf fails loudly if an
# apply to prod is attempted without one.

# ---------------------------------------------------------------------------
# Frontend (CloudFront + private S3 origin)
# ---------------------------------------------------------------------------
# PriceClass_100 = North America + Europe edge locations only. Raise to
# PriceClass_200/All only if there are real users outside that footprint.
frontend_price_class = "PriceClass_100"

frontend_extra_connect_src = []

# Set the real us-east-1 ACM certificate ARN and domain before applying. With a
# custom domain the SPA URL is known up front, so allowed_origins and the
# Cognito callback/logout URLs above can be correct on the FIRST apply and no
# second apply is needed. Left empty, prod falls back to the *.cloudfront.net
# domain and needs the two-step apply described in README.md.
frontend_acm_certificate_arn = ""
frontend_aliases             = []

cloudfront_5xx_error_rate_percent = 5
