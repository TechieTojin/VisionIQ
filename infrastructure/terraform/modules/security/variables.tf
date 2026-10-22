variable "name_prefix" {
  description = "Prefix for resource names, e.g. visioniq-dev."
  type        = string
}

variable "bucket_arn" {
  description = "ARN of the image bucket."
  type        = string
}

variable "upload_prefix" {
  description = "Key prefix clients upload to. Access is scoped to this prefix only."
  type        = string
}

variable "results_prefix" {
  description = "Key prefix the worker writes artifacts to."
  type        = string
}

variable "table_arn" {
  description = "ARN of the analyses DynamoDB table."
  type        = string
}

variable "table_index_arn" {
  description = "ARN of the analyses GSI."
  type        = string
}

variable "queue_arn" {
  description = "ARN of the main inference queue."
  type        = string
}

variable "dlq_arn" {
  description = "ARN of the dead-letter queue."
  type        = string
}

variable "ecr_repository_name" {
  description = "Name of the ECR repository the worker image is pulled from. The ARN is derived, never hardcoded."
  type        = string
}

variable "enable_bedrock" {
  description = "Whether to grant bedrock:InvokeModel on the configured model."
  type        = bool
}

variable "bedrock_model_id" {
  description = "Bedrock foundation model id to scope the invoke permission to."
  type        = string
}

variable "log_group_prefix" {
  description = "CloudWatch Logs group name prefix owned by this stack, e.g. /aws/visioniq/dev."
  type        = string
}
