variable "name_prefix" {
  description = "Prefix for resource names, e.g. visioniq-dev."
  type        = string
}

variable "budget_limit_usd" {
  description = "Monthly cost limit in USD."
  type        = number
}

variable "notification_topic_arn" {
  description = "SNS topic notified when a threshold is crossed."
  type        = string
}

variable "alarm_email" {
  description = "Additional email notified directly by Budgets. Empty disables it."
  type        = string
  default     = ""
}

variable "cost_filter_tag_key" {
  description = "Cost allocation tag key used to scope the budget to this project."
  type        = string
  default     = "Project"
}

variable "cost_filter_tag_value" {
  description = "Cost allocation tag value used to scope the budget to this project."
  type        = string
}

variable "thresholds" {
  description = "Percent-of-budget thresholds that trigger a notification."
  type        = list(number)
  default     = [50, 80, 100]
}
