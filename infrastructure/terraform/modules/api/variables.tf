variable "name_prefix" {
  description = "Prefix for resource names, e.g. visioniq-dev."
  type        = string
}

variable "log_group_prefix" {
  description = "CloudWatch Logs group name prefix owned by this stack."
  type        = string
}

variable "log_retention_days" {
  description = "Retention for API and Lambda log groups."
  type        = number
}

variable "lambda_role_arn" {
  description = "Execution role ARN for the API Lambda functions (from the security module)."
  type        = string
}

variable "lambda_source_dir" {
  description = "Directory containing the API Lambda handler source."
  type        = string
}

variable "lambda_runtime" {
  description = "Python runtime for the API Lambda functions."
  type        = string
  default     = "python3.11"
}

variable "lambda_memory_mb" {
  description = "Memory for the lightweight API Lambda functions."
  type        = number
  default     = 256
}

variable "lambda_timeout_seconds" {
  description = "Timeout for the API Lambda functions."
  type        = number
  default     = 15
}

variable "allowed_origins" {
  description = "Browser origins allowed by the HTTP API CORS configuration."
  type        = list(string)
}

variable "throttle_rate_limit" {
  description = "Steady-state requests/second for the default stage."
  type        = number
}

variable "throttle_burst_limit" {
  description = "Burst capacity for the default stage."
  type        = number
}

variable "bucket_name" {
  description = "Image bucket name, passed to the handlers as an env var."
  type        = string
}

variable "upload_prefix" {
  description = "Upload key prefix the presign handler is allowed to sign for."
  type        = string
}

variable "table_name" {
  description = "Analyses table name."
  type        = string
}

variable "table_index_name" {
  description = "Analyses GSI name used for listing."
  type        = string
}

variable "queue_url" {
  description = "Inference queue URL the create-job handler sends to."
  type        = string
}

variable "enable_bedrock" {
  description = "Exposed to handlers so they know whether narrative insights are available."
  type        = bool
}

variable "bedrock_model_id" {
  description = "Model id handlers should invoke when Bedrock is enabled."
  type        = string
}

variable "presign_expiry_seconds" {
  description = <<-DESC
    Lifetime of a presigned PUT URL, in seconds.

    Matches the FastAPI backend's VISIONIQ_PRESIGN_TTL default (300) so the
    two implementations behave identically, not just return the same shape.
    Five minutes is ample for an upload, and a shorter window means less
    time for an intercepted URL to be replayed.
  DESC
  type        = number
  default     = 300
}

variable "jwt_issuer" {
  description = "OIDC issuer URL the HTTP API JWT authorizer validates the `iss` claim against, e.g. the Cognito user pool issuer."
  type        = string

  validation {
    condition     = can(regex("^https://", var.jwt_issuer))
    error_message = "jwt_issuer must be an https URL."
  }
}

variable "jwt_audience" {
  description = "Accepted `aud` claim values for the JWT authorizer. For Cognito this is the app client id (public, not a secret)."
  type        = list(string)

  validation {
    condition     = length(var.jwt_audience) > 0
    error_message = "jwt_audience must contain at least one app client id."
  }
}
