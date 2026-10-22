variable "name_prefix" {
  description = "Prefix for resource names, e.g. visioniq-dev."
  type        = string
}

variable "bucket_suffix" {
  description = "Suffix appended to the bucket name to make it globally unique (derived from the caller account id hash, never a literal account id)."
  type        = string
}

variable "upload_prefix" {
  description = "Key prefix under which clients upload shelf images via presigned PUT."
  type        = string
  default     = "uploads/"
}

variable "results_prefix" {
  description = "Key prefix under which the worker writes rendered/annotated artifacts."
  type        = string
  default     = "results/"
}

variable "image_expiration_days" {
  description = "Days after which uploaded images are expired."
  type        = number
}

variable "allowed_origins" {
  description = "Origins permitted to issue presigned PUT/GET requests from a browser."
  type        = list(string)
}

variable "abort_incomplete_multipart_days" {
  description = "Days after which incomplete multipart uploads are aborted."
  type        = number
  default     = 7
}

variable "noncurrent_version_expiration_days" {
  description = "Days after which noncurrent object versions are expired."
  type        = number
  default     = 7
}
