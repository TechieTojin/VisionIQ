# Amazon Cognito user pool backing the VisionIQ SPA.
#
# The API Gateway JWT authorizer validates tokens minted here, and the verified
# `sub` claim becomes the DynamoDB partition key (owner_id). Nothing else in the
# stack may decide who the caller is.
#
# Cost note: the user pool itself is free up to the Cognito MAU free tier.
# `advanced_security_mode = "AUDIT"` only records risk telemetry and stays in
# that free tier; "ENFORCED" (adaptive authentication) is billed per MAU on top
# of the normal price, so AUDIT is the default here.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  # Cognito domain prefixes are globally unique across all AWS accounts. A short
  # hash of account id + region gives a stable, non-identifying suffix - the
  # account id itself never appears in the name.
  derived_domain_prefix = substr(
    "${var.name_prefix}-${substr(sha256("${data.aws_caller_identity.current.account_id}-${data.aws_region.current.name}"), 0, 8)}",
    0, 63
  )

  domain_prefix = var.domain_prefix != "" ? var.domain_prefix : local.derived_domain_prefix
}

resource "aws_cognito_user_pool" "this" {
  name = "${var.name_prefix}-users"

  # Email is the username. alias_attributes + email in auto_verified_attributes
  # means a user signs in with the address they verified.
  alias_attributes         = ["email", "preferred_username"]
  auto_verified_attributes = ["email"]

  deletion_protection = var.enable_deletion_protection ? "ACTIVE" : "INACTIVE"

  mfa_configuration = var.mfa_configuration

  dynamic "software_token_mfa_configuration" {
    for_each = var.mfa_configuration == "OFF" ? [] : [1]

    content {
      enabled = true
    }
  }

  password_policy {
    minimum_length                   = var.password_minimum_length
    require_uppercase                = true
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = var.temporary_password_validity_days
  }

  user_pool_add_ons {
    advanced_security_mode = var.advanced_security_mode
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  admin_create_user_config {
    # Self-service sign-up stays on; this only governs admin-created users.
    allow_admin_create_user_only = false
  }

  username_configuration {
    case_sensitive = false
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
  }

  # Default Cognito email sending is rate limited but free; wire SES here if
  # volume ever exceeds it.
  email_configuration {
    email_sending_account = "COGNITO_DEFAULT"
  }

  schema {
    name                     = "email"
    attribute_data_type      = "String"
    required                 = true
    mutable                  = true
    developer_only_attribute = false

    string_attribute_constraints {
      min_length = 5
      max_length = 256
    }
  }

  tags = {
    Name = "${var.name_prefix}-users"
  }
}

# Public SPA client. A browser cannot keep a secret, so no client secret is
# generated and SRP is the only password-bearing flow permitted:
# ALLOW_USER_PASSWORD_AUTH would put the raw password on the wire.
resource "aws_cognito_user_pool_client" "spa" {
  name         = "${var.name_prefix}-spa"
  user_pool_id = aws_cognito_user_pool.this.id

  generate_secret = false

  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  supported_identity_providers = ["COGNITO"]

  allowed_oauth_flows                  = ["code"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_scopes                 = ["openid", "email", "profile"]

  # Exact URIs only - no wildcards, no "*".
  callback_urls = var.callback_urls
  logout_urls   = var.logout_urls

  access_token_validity  = var.access_token_validity_hours
  id_token_validity      = var.id_token_validity_hours
  refresh_token_validity = var.refresh_token_validity_days

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }

  # The client may read only what the SPA renders and write only the one
  # attribute a user may change about themselves.
  read_attributes  = ["email", "email_verified", "preferred_username"]
  write_attributes = ["email", "preferred_username"]
}

resource "aws_cognito_user_pool_domain" "this" {
  domain       = local.domain_prefix
  user_pool_id = aws_cognito_user_pool.this.id
}
