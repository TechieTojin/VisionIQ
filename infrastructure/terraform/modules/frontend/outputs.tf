output "bucket_name" {
  description = "Private S3 bucket the built SPA is synced to. Not publicly readable; only this distribution can read it."
  value       = aws_s3_bucket.spa.id
}

output "bucket_arn" {
  description = "ARN of the SPA origin bucket (for a deploy role's s3:PutObject scope)."
  value       = aws_s3_bucket.spa.arn
}

output "distribution_id" {
  description = "CloudFront distribution id. Needed to create an invalidation after each deploy."
  value       = aws_cloudfront_distribution.spa.id
}

output "distribution_domain_name" {
  description = "The *.cloudfront.net domain name of the distribution."
  value       = aws_cloudfront_distribution.spa.domain_name
}

output "spa_url" {
  description = "Base URL the SPA is served from. This value must be added to cognito_callback_urls, cognito_logout_urls and allowed_origins (see the two-step apply in README.md)."
  value       = length(aws_cloudfront_distribution.spa.aliases) > 0 ? "https://${tolist(aws_cloudfront_distribution.spa.aliases)[0]}" : "https://${aws_cloudfront_distribution.spa.domain_name}"
}

output "response_headers_policy_id" {
  description = "Id of the response headers policy carrying the CSP and security headers."
  value       = aws_cloudfront_response_headers_policy.security.id
}

output "content_security_policy" {
  description = "The exact Content-Security-Policy header value this module serves. Exposed so it can be asserted against in tests."
  value       = local.content_security_policy
}
