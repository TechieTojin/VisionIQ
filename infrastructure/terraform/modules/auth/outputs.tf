# None of these values are secrets. A public SPA client has no client secret,
# and the pool id, client id, issuer and JWKS URI are all published to every
# browser that loads the app - they are identifiers, not credentials. So none of
# them is marked `sensitive`.

output "user_pool_id" {
  description = "Cognito user pool id. Public by design (the SPA needs it)."
  value       = aws_cognito_user_pool.this.id
}

output "user_pool_arn" {
  description = "Cognito user pool ARN (for anything that needs to reference the pool)."
  value       = aws_cognito_user_pool.this.arn
}

output "user_pool_client_id" {
  description = "Public SPA app client id. Not a secret: generate_secret = false."
  value       = aws_cognito_user_pool_client.spa.id
}

output "issuer" {
  description = "OIDC issuer URL. This is the `iss` claim the API Gateway JWT authorizer validates against. Public by design."
  value       = "https://cognito-idp.${data.aws_region.current.name}.amazonaws.com/${aws_cognito_user_pool.this.id}"
}

output "jwks_uri" {
  description = "JWKS endpoint holding the pool's public signing keys. Public by design."
  value       = "https://cognito-idp.${data.aws_region.current.name}.amazonaws.com/${aws_cognito_user_pool.this.id}/.well-known/jwks.json"
}

output "hosted_ui_domain" {
  description = "Hosted UI domain for sign-in/sign-up."
  value       = "https://${aws_cognito_user_pool_domain.this.domain}.auth.${data.aws_region.current.name}.amazoncognito.com"
}
