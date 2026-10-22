variable "name_prefix" {
  description = "Prefix for resource names, e.g. visioniq-dev."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.40.0.0/16"
}

variable "public_subnet_count" {
  description = "Number of public subnets (one per AZ) to create for Fargate tasks."
  type        = number
  default     = 2
}
