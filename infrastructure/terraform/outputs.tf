output "image_bucket_name" {
  description = "Private S3 bucket holding uploaded shelf images and rendered artifacts."
  value       = module.storage.bucket_name
}

output "analyses_table_name" {
  description = "DynamoDB table holding analysis job records."
  value       = module.database.table_name
}

output "api_endpoint" {
  description = "Base invoke URL of the VisionIQ HTTP API. Point the frontend's API base at this."
  value       = module.api.api_endpoint
}

output "inference_queue_url" {
  description = "SQS queue URL the worker long-polls. Treated as sensitive: it embeds the account id."
  value       = module.queue.queue_url
  sensitive   = true
}

output "inference_dlq_url" {
  description = "Dead-letter queue URL. Treated as sensitive: it embeds the account id."
  value       = module.queue.dlq_url
  sensitive   = true
}

output "worker_ecr_repository_url" {
  description = "ECR repository to docker push the worker image to. Treated as sensitive: it embeds the account id."
  value       = module.worker.ecr_repository_url
  sensitive   = true
}

output "worker_cluster_name" {
  description = "ECS cluster running the inference worker."
  value       = module.worker.cluster_name
}

output "worker_service_name" {
  description = "ECS service name for the inference worker."
  value       = module.worker.service_name
}

output "alarm_topic_arn" {
  description = "SNS topic that alarm and budget notifications publish to. Sensitive: embeds the account id."
  value       = module.observability.sns_topic_arn
  sensitive   = true
}

output "dashboard_name" {
  description = "CloudWatch dashboard giving a single-pane view of the pipeline."
  value       = module.observability.dashboard_name
}

output "log_group_prefix" {
  description = "Prefix under which every log group for this stack lives."
  value       = local.log_group_prefix
}

# Cognito identifiers are public by design: the SPA embeds them in its bundle.
output "cognito_user_pool_id" {
  description = "Cognito user pool id for the frontend auth configuration."
  value       = module.auth.user_pool_id
}

output "cognito_client_id" {
  description = "Public SPA app client id (no client secret exists)."
  value       = module.auth.user_pool_client_id
}

output "cognito_issuer" {
  description = "OIDC issuer the API Gateway JWT authorizer trusts."
  value       = module.auth.issuer
}

output "cognito_hosted_ui_domain" {
  description = "Hosted UI base URL for sign-in and sign-up."
  value       = module.auth.hosted_ui_domain
}

# -----------------------------------------------------------------------------
# Frontend
# -----------------------------------------------------------------------------

output "frontend_bucket_name" {
  description = "Private S3 bucket to sync the built SPA into (`aws s3 sync dist/ s3://<name>/ --delete`)."
  value       = module.frontend.bucket_name
}

output "frontend_distribution_id" {
  description = "CloudFront distribution id. Invalidate /index.html after each deploy."
  value       = module.frontend.distribution_id
}

output "frontend_url" {
  description = "URL the SPA is served from. Add this to cognito_callback_urls, cognito_logout_urls and allowed_origins, then apply a second time (see README.md -> Two-step apply)."
  value       = module.frontend.spa_url
}

output "frontend_content_security_policy" {
  description = "The exact Content-Security-Policy header CloudFront serves the SPA with."
  value       = module.frontend.content_security_policy
}
