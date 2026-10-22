variable "name_prefix" {
  description = "Prefix for resource names, e.g. visioniq-dev."
  type        = string
}

variable "enable_deletion_protection" {
  description = "Whether the user pool is protected against accidental deletion. Keep false outside prod so terraform destroy works."
  type        = bool
  default     = false
}

variable "advanced_security_mode" {
  description = <<-DESC
    Cognito advanced security. "AUDIT" only records risk telemetry and is
    free-tier friendly; "ENFORCED" adds adaptive authentication and is billed
    per monthly active user on top of the normal MAU price. "OFF" disables it.
  DESC
  type        = string
  default     = "AUDIT"

  validation {
    condition     = contains(["OFF", "AUDIT", "ENFORCED"], var.advanced_security_mode)
    error_message = "advanced_security_mode must be one of: OFF, AUDIT, ENFORCED."
  }
}

variable "mfa_configuration" {
  description = "Pool MFA setting. OPTIONAL lets users enrol a TOTP authenticator without locking out existing accounts."
  type        = string
  default     = "OPTIONAL"

  validation {
    condition     = contains(["OFF", "OPTIONAL", "ON"], var.mfa_configuration)
    error_message = "mfa_configuration must be one of: OFF, OPTIONAL, ON."
  }
}

variable "password_minimum_length" {
  description = "Minimum password length enforced by the user pool."
  type        = number
  default     = 12

  validation {
    condition     = var.password_minimum_length >= 12 && var.password_minimum_length <= 99
    error_message = "password_minimum_length must be between 12 and 99."
  }
}

variable "temporary_password_validity_days" {
  description = "How long an admin-created temporary password stays usable."
  type        = number
  default     = 7
}

variable "callback_urls" {
  description = "Exact redirect URIs the hosted UI may return an authorization code to. Never wildcards."
  type        = list(string)

  validation {
    condition     = length(var.callback_urls) > 0
    error_message = "At least one callback URL is required."
  }
}

variable "logout_urls" {
  description = "Exact URIs the hosted UI may redirect to after sign-out."
  type        = list(string)

  validation {
    condition     = length(var.logout_urls) > 0
    error_message = "At least one logout URL is required."
  }
}

variable "domain_prefix" {
  description = <<-DESC
    Hosted-UI domain prefix. Cognito domain prefixes are globally unique, so an
    empty value (the default) derives one from name_prefix plus a short hash of
    the caller account id and region. No literal account id ever appears in it.
  DESC
  type        = string
  default     = ""
}

variable "access_token_validity_hours" {
  description = "Access token lifetime in hours."
  type        = number
  default     = 1
}

variable "id_token_validity_hours" {
  description = "ID token lifetime in hours."
  type        = number
  default     = 1
}

variable "refresh_token_validity_days" {
  description = "Refresh token lifetime in days."
  type        = number
  default     = 30
}
