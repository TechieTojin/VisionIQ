variable "name_prefix" {
  description = "Prefix for resource names, e.g. visioniq-dev."
  type        = string
}

variable "aws_region" {
  description = "Region the dashboard widgets query."
  type        = string
}

variable "alarm_email" {
  description = "Email subscribed to the alarm topic. Empty disables the subscription."
  type        = string
}

variable "queue_name" {
  description = "Main inference queue name."
  type        = string
}

variable "dlq_name" {
  description = "Dead-letter queue name."
  type        = string
}

variable "api_id" {
  description = "HTTP API id, used as the ApiId metric dimension."
  type        = string
}

variable "api_p99_latency_threshold_ms" {
  description = "Alarm threshold for API p99 latency in milliseconds."
  type        = number
}

variable "queue_age_alarm_seconds" {
  description = "Alarm threshold for age of the oldest queued message."
  type        = number
}

variable "cluster_name" {
  description = "ECS cluster name."
  type        = string
}

variable "service_name" {
  description = "ECS worker service name."
  type        = string
}

variable "table_name" {
  description = "DynamoDB analyses table name."
  type        = string
}

variable "lambda_function_names" {
  description = "Map of logical key to Lambda function name for error alarms."
  type        = map(string)
}

variable "api_5xx_threshold" {
  description = "Number of 5xx responses in the evaluation window that trips the alarm."
  type        = number
  default     = 5
}

variable "cloudfront_distribution_id" {
  description = "CloudFront distribution id for the SPA. Empty disables the CloudFront alarm."
  type        = string
  default     = ""
}

variable "cloudfront_5xx_error_rate_percent" {
  description = "Percentage of CloudFront viewer requests answered with a 5xx that trips the alarm."
  type        = number
  default     = 5
}
