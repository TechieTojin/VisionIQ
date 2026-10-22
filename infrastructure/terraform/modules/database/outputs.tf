output "table_name" {
  description = "Name of the analyses DynamoDB table."
  value       = aws_dynamodb_table.analyses.name
}

output "table_arn" {
  description = "ARN of the analyses DynamoDB table."
  value       = aws_dynamodb_table.analyses.arn
}

output "index_name" {
  description = "Name of the owner+created_at GSI used for listing."
  value       = "owner_created_at_index"
}

output "index_arn" {
  description = "ARN of the owner+created_at GSI."
  value       = "${aws_dynamodb_table.analyses.arn}/index/owner_created_at_index"
}
