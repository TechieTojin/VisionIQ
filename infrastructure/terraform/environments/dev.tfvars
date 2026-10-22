# Dev: cheapest configuration that still exercises the full async flow.
# Idle cost is dominated by S3 storage and CloudWatch Logs only - there is no
# NAT Gateway, no always-on compute and no provisioned DynamoDB capacity.

project_name = "visioniq"
environment  = "dev"
aws_region   = "us-east-1"

# Short retention: logs and images do not need to outlive a debugging session.
log_retention_days    = 7
image_expiration_days = 7

# Browser origins allowed to presign-upload and call the API.
allowed_origins = [
  "http://localhost:5175",
  "http://127.0.0.1:5175",
]

# Bedrock off by default in dev - turn on deliberately when testing narratives.
enable_bedrock   = false
bedrock_model_id = "anthropic.claude-3-5-haiku-20241022-v1:0"

# Scale-to-zero: no task runs until a message lands on the queue.
worker_cpu                        = 1024
worker_memory                     = 2048
worker_desired_count              = 0
worker_max_count                  = 1
worker_processing_timeout_seconds = 300

# Leave empty to skip the email subscription, or set your address and confirm
# the subscription email AWS sends.
alarm_email = ""

budget_limit_usd = 10

api_throttle_rate_limit      = 10
api_throttle_burst_limit     = 20
api_p99_latency_threshold_ms = 5000
queue_age_alarm_seconds      = 1800

# Cognito hosted-UI redirect targets: the local Vite dev server.
cognito_callback_urls = [
  "http://localhost:5175",
  "http://127.0.0.1:5175",
]
cognito_logout_urls = [
  "http://localhost:5175",
  "http://127.0.0.1:5175",
]

# ---------------------------------------------------------------------------
# Frontend (CloudFront + private S3 origin)
# ---------------------------------------------------------------------------
# Cheapest edge footprint; dev traffic is one developer.
frontend_price_class = "PriceClass_100"

# No extra CSP connect-src origins in dev: the API, Cognito and the image
# bucket are added by the module automatically.
frontend_extra_connect_src = []

# No custom domain in dev - the SPA is served from *.cloudfront.net, so its URL
# is only known after the first apply. See README.md -> "Two-step apply": after
# applying, append the `frontend_url` output to allowed_origins,
# cognito_callback_urls and cognito_logout_urls below and apply again.
frontend_acm_certificate_arn = ""
frontend_aliases             = []

cloudfront_5xx_error_rate_percent = 10
