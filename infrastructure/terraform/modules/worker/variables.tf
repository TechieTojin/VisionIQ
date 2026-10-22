variable "name_prefix" {
  description = "Prefix for resource names, e.g. visioniq-dev."
  type        = string
}

variable "ecr_repository_name" {
  description = "Name of the ECR repository holding the worker image."
  type        = string
}

variable "image_tag" {
  description = "Image tag the service runs. Use an immutable tag or digest in prod."
  type        = string
  default     = "latest"
}

variable "ecr_untagged_expiry_days" {
  description = "Days after which untagged ECR images are expired."
  type        = number
  default     = 7
}

variable "ecr_max_tagged_images" {
  description = "Number of tagged images to retain in ECR."
  type        = number
  default     = 10
}

variable "log_group_prefix" {
  description = "CloudWatch Logs group name prefix owned by this stack."
  type        = string
}

variable "log_retention_days" {
  description = "Retention for the worker log group."
  type        = number
}

variable "subnet_ids" {
  description = "Subnets the Fargate tasks run in (public subnets, to avoid NAT Gateway cost)."
  type        = list(string)
}

variable "security_group_id" {
  description = "Egress-only security group for the tasks."
  type        = string
}

variable "assign_public_ip" {
  description = "Whether tasks get a public IP. Required when running in public subnets without a NAT Gateway."
  type        = bool
  default     = true
}

variable "task_execution_role_arn" {
  description = "Execution role ARN (image pull + logs)."
  type        = string
}

variable "task_role_arn" {
  description = "Task role ARN (application permissions)."
  type        = string
}

variable "worker_cpu" {
  description = "Task CPU units."
  type        = number
}

variable "worker_memory" {
  description = "Task memory in MiB."
  type        = number
}

variable "worker_desired_count" {
  description = "Baseline running task count. 0 enables scale-to-zero."
  type        = number
}

variable "worker_max_count" {
  description = "Maximum task count autoscaling may reach."
  type        = number
}

variable "enable_container_insights" {
  description = "Whether to enable ECS Container Insights. Adds CloudWatch metric cost."
  type        = bool
  default     = false
}

variable "queue_url" {
  description = "Inference queue URL the worker long-polls."
  type        = string
}

variable "queue_name" {
  description = "Inference queue name, used as the autoscaling alarm dimension."
  type        = string
}

variable "bucket_name" {
  description = "Image bucket name."
  type        = string
}

variable "upload_prefix" {
  description = "Prefix the worker reads uploaded images from."
  type        = string
}

variable "results_prefix" {
  description = "Prefix the worker writes rendered artifacts to."
  type        = string
}

variable "table_name" {
  description = "Analyses table name."
  type        = string
}

variable "enable_bedrock" {
  description = "Whether narrative insight generation is enabled."
  type        = bool
}

variable "bedrock_model_id" {
  description = "Bedrock model id for narrative insights."
  type        = string
}

variable "worker_processing_timeout_seconds" {
  description = "Worst-case per-image processing budget, passed to the container."
  type        = number
}
