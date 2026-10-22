variable "project_name" {
  description = "Short lowercase project identifier used as a prefix for every resource name."
  type        = string
  default     = "visioniq"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.project_name))
    error_message = "project_name must be 2-21 chars, lowercase letters/digits/hyphens, starting with a letter."
  }
}

variable "environment" {
  description = "Deployment environment name. Drives resource naming and sizing."
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "aws_region" {
  description = "AWS region to deploy into. Must be a region where Amazon Bedrock is available if enable_bedrock is true."
  type        = string
  default     = "us-east-1"
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention in days for all log groups. Lower values cost less."
  type        = number
  default     = 14

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "log_retention_days must be a retention value CloudWatch Logs accepts."
  }
}

variable "image_expiration_days" {
  description = "Number of days after which uploaded shelf images are expired from S3 by lifecycle rule."
  type        = number
  default     = 30

  validation {
    condition     = var.image_expiration_days >= 1 && var.image_expiration_days <= 3650
    error_message = "image_expiration_days must be between 1 and 3650."
  }
}

variable "allowed_origins" {
  description = "Browser origins permitted to perform presigned PUT uploads (S3 CORS) and to call the HTTP API."
  type        = list(string)
  default     = ["http://localhost:5175"]
}

variable "enable_bedrock" {
  description = "Whether to grant bedrock:InvokeModel on the configured model and enable narrative insight generation."
  type        = bool
  default     = false
}

variable "bedrock_model_id" {
  description = "Bedrock foundation model id used for narrative insights when enable_bedrock is true."
  type        = string
  default     = "anthropic.claude-3-5-haiku-20241022-v1:0"
}

variable "worker_cpu" {
  description = "Fargate task CPU units for the YOLO inference worker (1024 = 1 vCPU)."
  type        = number
  default     = 1024
}

variable "worker_memory" {
  description = "Fargate task memory in MiB for the inference worker. Must be a valid pairing with worker_cpu."
  type        = number
  default     = 4096
}

variable "worker_desired_count" {
  description = "Baseline number of running worker tasks. 0 means scale-to-zero (tasks start only when the queue has work)."
  type        = number
  default     = 0

  validation {
    condition     = var.worker_desired_count >= 0 && var.worker_desired_count <= 50
    error_message = "worker_desired_count must be between 0 and 50."
  }
}

variable "worker_max_count" {
  description = "Maximum number of worker tasks application autoscaling may run."
  type        = number
  default     = 4
}

variable "worker_processing_timeout_seconds" {
  description = "Worst-case seconds a worker spends on one image. SQS visibility timeout is derived from this with headroom."
  type        = number
  default     = 300
}

variable "alarm_email" {
  description = "Email address subscribed to the SNS alarm topic. Empty string disables the subscription. The address owner must confirm the subscription by email."
  type        = string
  default     = ""
}

variable "budget_limit_usd" {
  description = "Monthly AWS Budgets limit in USD for this project's tagged resources."
  type        = number
  default     = 25

  validation {
    condition     = var.budget_limit_usd > 0
    error_message = "budget_limit_usd must be greater than zero."
  }
}

variable "api_throttle_rate_limit" {
  description = "Steady-state request rate (requests/second) for the HTTP API default stage."
  type        = number
  default     = 20
}

variable "api_throttle_burst_limit" {
  description = "Burst request capacity for the HTTP API default stage."
  type        = number
  default     = 40
}

variable "api_p99_latency_threshold_ms" {
  description = "Alarm threshold for API Gateway p99 integration latency, in milliseconds."
  type        = number
  default     = 3000
}

variable "queue_age_alarm_seconds" {
  description = "Alarm threshold for the age of the oldest message on the inference queue, in seconds."
  type        = number
  default     = 900
}

variable "worker_image_tag" {
  description = <<-DESC
    Container image tag the ECS worker service runs. The deploy workflow passes
    the git SHA so each deployment is immutable and traceable; "latest" is only
    appropriate for local experimentation.
  DESC
  type        = string
  default     = "latest"
}

variable "cognito_callback_urls" {
  description = "Exact redirect URIs the Cognito hosted UI may return an authorization code to. Must match the deployed frontend origin."
  type        = list(string)
  default     = ["http://localhost:5175"]
}

variable "cognito_logout_urls" {
  description = "Exact URIs the Cognito hosted UI may redirect to after sign-out."
  type        = list(string)
  default     = ["http://localhost:5175"]
}

# -----------------------------------------------------------------------------
# Frontend delivery (CloudFront + private S3 origin)
# -----------------------------------------------------------------------------

variable "frontend_price_class" {
  description = "CloudFront price class for the SPA distribution. PriceClass_100 (default) serves from North American and European edge locations only - the cheapest option; viewers elsewhere are still served, from a farther edge."
  type        = string
  default     = "PriceClass_100"
}

variable "frontend_extra_connect_src" {
  description = "Extra origins appended to the SPA's Content-Security-Policy connect-src. Keep empty unless something genuinely needs it: each entry widens the policy."
  type        = list(string)
  default     = []
}

variable "frontend_acm_certificate_arn" {
  description = "ARN of a us-east-1 ACM certificate for a custom SPA domain. Empty uses the *.cloudfront.net certificate (AWS fixes its TLS floor and the SPA URL is then only known after apply)."
  type        = string
  default     = ""
}

variable "frontend_aliases" {
  description = "Custom domain names for the SPA distribution. Only used when frontend_acm_certificate_arn is set."
  type        = list(string)
  default     = []
}

variable "cloudfront_5xx_error_rate_percent" {
  description = "Alarm threshold for the percentage of CloudFront viewer requests answered with a 5xx."
  type        = number
  default     = 5
}
