output "api_id" {
  description = "Id of the HTTP API (CloudWatch ApiId dimension)."
  value       = aws_apigatewayv2_api.this.id
}

output "api_endpoint" {
  description = "Invoke URL of the HTTP API default stage."
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "api_name" {
  description = "Name of the HTTP API."
  value       = aws_apigatewayv2_api.this.name
}

output "function_names" {
  description = "Map of logical function key to deployed Lambda function name."
  value       = { for k, f in aws_lambda_function.api : k => f.function_name }
}

output "log_group_names" {
  description = "Log groups created by this module."
  value = concat(
    [for g in aws_cloudwatch_log_group.lambda : g.name],
    [aws_cloudwatch_log_group.access.name],
  )
}

output "authorizer_id" {
  description = "Id of the JWT authorizer protecting every route."
  value       = aws_apigatewayv2_authorizer.jwt.id
}
