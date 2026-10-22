variable "name_prefix" {
  description = "Prefix for resource names, e.g. visioniq-dev."
  type        = string
}

variable "environment" {
  description = "Deployment environment name. Used for tagging and comments only."
  type        = string
}

variable "bucket_suffix" {
  description = "Short non-identifying suffix that makes the globally-unique bucket name stable without leaking the account id."
  type        = string
}

variable "api_origin" {
  description = "Scheme+host of the HTTP API the SPA calls, e.g. https://abc123.execute-api.us-east-1.amazonaws.com. Added to connect-src."
  type        = string

  validation {
    condition     = can(regex("^https://[^/]+$", var.api_origin))
    error_message = "api_origin must be an https origin with no path or trailing slash."
  }
}

variable "cognito_hosted_ui_origin" {
  description = "Cognito hosted-UI origin, e.g. https://visioniq-dev.auth.us-east-1.amazoncognito.com. Added to connect-src and form-action."
  type        = string

  validation {
    condition     = can(regex("^https://[^/]+$", var.cognito_hosted_ui_origin))
    error_message = "cognito_hosted_ui_origin must be an https origin with no path or trailing slash."
  }
}

variable "cognito_idp_origin" {
  description = "Cognito IDP API origin, e.g. https://cognito-idp.us-east-1.amazonaws.com. The amazon-cognito-identity-js SDK talks to this directly."
  type        = string

  validation {
    condition     = can(regex("^https://[^/]+$", var.cognito_idp_origin))
    error_message = "cognito_idp_origin must be an https origin with no path or trailing slash."
  }
}

variable "upload_bucket_origin" {
  description = "Origin of the private image bucket, e.g. https://bucket.s3.us-east-1.amazonaws.com. Required in connect-src so presigned PUT uploads are not blocked."
  type        = string

  validation {
    condition     = can(regex("^https://[^/]+$", var.upload_bucket_origin))
    error_message = "upload_bucket_origin must be an https origin with no path or trailing slash."
  }
}

variable "extra_connect_src" {
  description = "Additional origins to append to connect-src (e.g. an error reporting endpoint). Empty by default: every addition widens the policy."
  type        = list(string)
  default     = []
}

variable "price_class" {
  description = "CloudFront price class. PriceClass_100 is the cheapest: edge locations in North America and Europe only. Viewers elsewhere are still served, just from a farther edge."
  type        = string
  default     = "PriceClass_100"

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.price_class)
    error_message = "price_class must be PriceClass_100, PriceClass_200 or PriceClass_All."
  }
}

variable "log_retention_days" {
  description = "Retention in days for this module's CloudWatch log group (CloudFront real-time/function logs if enabled later). Keeps retention from defaulting to never-expire."
  type        = number
  default     = 14
}

variable "acm_certificate_arn" {
  description = <<-DESC
    ARN of an ACM certificate in us-east-1 for a custom domain. Empty (the
    default) uses the *.cloudfront.net certificate, whose TLS floor is fixed by
    AWS and cannot be raised - CloudFront rejects a minimum_protocol_version
    other than TLSv1 in that case. Set this (with `aliases`) to enforce
    minimum_protocol_version, and to make the SPA URL known before apply so the
    Cognito callback URLs need no second apply.
  DESC
  type        = string
  default     = ""
}

variable "aliases" {
  description = "Custom domain names served by the distribution. Only used when acm_certificate_arn is set."
  type        = list(string)
  default     = []
}

variable "minimum_protocol_version" {
  description = "TLS floor applied when a custom ACM certificate is used."
  type        = string
  default     = "TLSv1.2_2021"

  validation {
    condition     = contains(["TLSv1.2_2018", "TLSv1.2_2019", "TLSv1.2_2021"], var.minimum_protocol_version)
    error_message = "minimum_protocol_version must be a TLS 1.2+ policy."
  }
}
