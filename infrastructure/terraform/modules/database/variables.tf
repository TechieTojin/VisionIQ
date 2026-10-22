variable "name_prefix" {
  description = "Prefix for resource names, e.g. visioniq-dev."
  type        = string
}

variable "enable_point_in_time_recovery" {
  description = "Whether to enable DynamoDB point-in-time recovery. Adds continuous-backup cost."
  type        = bool
  default     = true
}

variable "ttl_attribute_name" {
  description = "Attribute holding the epoch-seconds expiry for an analysis record."
  type        = string
  default     = "expires_at"
}

variable "deletion_protection_enabled" {
  description = "Whether DynamoDB deletion protection is enabled. Keep false in dev so terraform destroy works."
  type        = bool
  default     = false
}
