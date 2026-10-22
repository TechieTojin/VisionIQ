data "aws_caller_identity" "current" {}

locals {
  name_prefix = "${var.project_name}-${var.environment}"

  # Bucket names are globally unique but must not leak the account id. A short
  # hash of the account id plus region gives a stable, non-identifying suffix.
  bucket_suffix = substr(
    sha256("${data.aws_caller_identity.current.account_id}-${var.aws_region}-${var.environment}"),
    0, 10
  )

  log_group_prefix = "/aws/${var.project_name}/${var.environment}"

  ecr_repository_name = "${local.name_prefix}-worker"

  upload_prefix  = "uploads/"
  results_prefix = "results/"

  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
    Component   = "visioniq-platform"
  }
}

# -----------------------------------------------------------------------------
# Data plane
# -----------------------------------------------------------------------------

module "storage" {
  source = "./modules/storage"

  name_prefix           = local.name_prefix
  bucket_suffix         = local.bucket_suffix
  upload_prefix         = local.upload_prefix
  results_prefix        = local.results_prefix
  image_expiration_days = var.image_expiration_days
  allowed_origins       = var.allowed_origins
}

module "database" {
  source = "./modules/database"

  name_prefix                   = local.name_prefix
  enable_point_in_time_recovery = var.environment == "prod"
  deletion_protection_enabled   = var.environment == "prod"
}

module "queue" {
  source = "./modules/queue"

  name_prefix                       = local.name_prefix
  worker_processing_timeout_seconds = var.worker_processing_timeout_seconds
}

# -----------------------------------------------------------------------------
# IAM (depends only on data-plane ARNs, so no module cycle)
# -----------------------------------------------------------------------------

module "security" {
  source = "./modules/security"

  name_prefix         = local.name_prefix
  bucket_arn          = module.storage.bucket_arn
  upload_prefix       = local.upload_prefix
  results_prefix      = local.results_prefix
  table_arn           = module.database.table_arn
  table_index_arn     = module.database.index_arn
  queue_arn           = module.queue.queue_arn
  dlq_arn             = module.queue.dlq_arn
  ecr_repository_name = local.ecr_repository_name
  enable_bedrock      = var.enable_bedrock
  bedrock_model_id    = var.bedrock_model_id
  log_group_prefix    = local.log_group_prefix
}

# -----------------------------------------------------------------------------
# Compute
# -----------------------------------------------------------------------------

module "network" {
  source = "./modules/network"

  name_prefix = local.name_prefix
}

module "auth" {
  source = "./modules/auth"

  name_prefix                = local.name_prefix
  enable_deletion_protection = var.environment == "prod"
  callback_urls              = var.cognito_callback_urls
  logout_urls                = var.cognito_logout_urls
}

module "api" {
  source = "./modules/api"

  # Every route is protected by this authorizer; the client id is public.
  jwt_issuer   = module.auth.issuer
  jwt_audience = [module.auth.user_pool_client_id]

  name_prefix        = local.name_prefix
  log_group_prefix   = local.log_group_prefix
  log_retention_days = var.log_retention_days
  lambda_role_arn    = module.security.lambda_role_arn
  lambda_source_dir  = "${path.module}/lambda/api"

  allowed_origins      = var.allowed_origins
  throttle_rate_limit  = var.api_throttle_rate_limit
  throttle_burst_limit = var.api_throttle_burst_limit

  bucket_name      = module.storage.bucket_name
  upload_prefix    = local.upload_prefix
  table_name       = module.database.table_name
  table_index_name = module.database.index_name
  queue_url        = module.queue.queue_url
  enable_bedrock   = var.enable_bedrock
  bedrock_model_id = var.bedrock_model_id
}

module "worker" {
  source = "./modules/worker"

  name_prefix         = local.name_prefix
  ecr_repository_name = local.ecr_repository_name
  image_tag           = var.worker_image_tag
  log_group_prefix    = local.log_group_prefix
  log_retention_days  = var.log_retention_days

  subnet_ids        = module.network.public_subnet_ids
  security_group_id = module.network.worker_security_group_id
  assign_public_ip  = true # no NAT Gateway: see modules/network/main.tf

  task_execution_role_arn = module.security.task_execution_role_arn
  task_role_arn           = module.security.task_role_arn

  worker_cpu                = var.worker_cpu
  worker_memory             = var.worker_memory
  worker_desired_count      = var.worker_desired_count
  worker_max_count          = var.worker_max_count
  enable_container_insights = var.environment == "prod"

  queue_url                         = module.queue.queue_url
  queue_name                        = module.queue.queue_name
  bucket_name                       = module.storage.bucket_name
  upload_prefix                     = local.upload_prefix
  results_prefix                    = local.results_prefix
  table_name                        = module.database.table_name
  enable_bedrock                    = var.enable_bedrock
  bedrock_model_id                  = var.bedrock_model_id
  worker_processing_timeout_seconds = var.worker_processing_timeout_seconds
}

# -----------------------------------------------------------------------------
# Frontend delivery
#
# Depends on api/auth/storage for the origins the CSP must allow. Nothing feeds
# back into those modules, so there is no cycle - which is exactly why the
# CloudFront URL has to be added to Cognito's callback/logout URLs by hand on a
# second apply (see modules/frontend/main.tf and README.md).
# -----------------------------------------------------------------------------

module "frontend" {
  source = "./modules/frontend"

  name_prefix   = local.name_prefix
  environment   = var.environment
  bucket_suffix = local.bucket_suffix

  api_origin               = replace(module.api.api_endpoint, "/(https://[^/]+).*/", "$1")
  cognito_hosted_ui_origin = module.auth.hosted_ui_domain
  cognito_idp_origin       = "https://cognito-idp.${var.aws_region}.amazonaws.com"
  upload_bucket_origin     = "https://${module.storage.bucket_regional_domain_name}"

  extra_connect_src = var.frontend_extra_connect_src
  price_class       = var.frontend_price_class

  acm_certificate_arn = var.frontend_acm_certificate_arn
  aliases             = var.frontend_aliases

  log_retention_days = var.log_retention_days
}

# -----------------------------------------------------------------------------
# Operations
# -----------------------------------------------------------------------------

module "observability" {
  source = "./modules/observability"

  name_prefix = local.name_prefix
  aws_region  = var.aws_region
  alarm_email = var.alarm_email

  queue_name = module.queue.queue_name
  dlq_name   = module.queue.dlq_name

  api_id                       = module.api.api_id
  api_p99_latency_threshold_ms = var.api_p99_latency_threshold_ms
  queue_age_alarm_seconds      = var.queue_age_alarm_seconds

  cluster_name = module.worker.cluster_name
  service_name = module.worker.service_name
  table_name   = module.database.table_name

  lambda_function_names = module.api.function_names

  cloudfront_distribution_id        = module.frontend.distribution_id
  cloudfront_5xx_error_rate_percent = var.cloudfront_5xx_error_rate_percent
}

module "budget" {
  source = "./modules/budget"

  name_prefix            = local.name_prefix
  budget_limit_usd       = var.budget_limit_usd
  notification_topic_arn = module.observability.sns_topic_arn
  alarm_email            = var.alarm_email
  cost_filter_tag_key    = "Project"
  cost_filter_tag_value  = var.project_name
}

# -----------------------------------------------------------------------------
# Guardrails
# -----------------------------------------------------------------------------

# Prod must run an immutable, traceable image tag. The deploy workflow passes
# the git SHA; "latest" would make a rollback unreproducible.
check "prod_uses_immutable_image_tag" {
  assert {
    condition     = var.environment != "prod" || var.worker_image_tag != "latest"
    error_message = "environment=prod must set worker_image_tag to an immutable tag (e.g. the git SHA), not \"latest\"."
  }
}

# Cognito redirect URIs must line up with the browser origins the API and S3
# CORS rules allow, or sign-in succeeds and every subsequent XHR is blocked.
check "cognito_urls_are_not_wildcards" {
  assert {
    condition = length([
      for u in concat(var.cognito_callback_urls, var.cognito_logout_urls) :
      u if can(regex("[*]", u))
    ]) == 0
    error_message = "cognito_callback_urls and cognito_logout_urls must be exact URIs, never wildcards."
  }
}
