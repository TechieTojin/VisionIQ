variable "name_prefix" {
  description = "Prefix for resource names, e.g. visioniq-dev."
  type        = string
}

variable "worker_processing_timeout_seconds" {
  description = "Worst-case worker processing time for one message. Visibility timeout is this plus headroom."
  type        = number
}

variable "visibility_timeout_headroom_seconds" {
  description = "Extra seconds added to the processing timeout to form the visibility timeout."
  type        = number
  default     = 60
}

variable "max_receive_count" {
  description = "Deliveries attempted before a message is moved to the DLQ."
  type        = number
  default     = 3
}

variable "message_retention_seconds" {
  description = "How long an unconsumed message is retained on the main queue."
  type        = number
  default     = 345600 # 4 days
}

variable "dlq_message_retention_seconds" {
  description = "How long a message is retained on the dead-letter queue."
  type        = number
  default     = 1209600 # 14 days
}
