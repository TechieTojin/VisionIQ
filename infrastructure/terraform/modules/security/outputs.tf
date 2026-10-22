output "lambda_role_arn" {
  description = "ARN of the API Lambda execution role."
  value       = aws_iam_role.lambda.arn
}

output "lambda_role_name" {
  description = "Name of the API Lambda execution role."
  value       = aws_iam_role.lambda.name
}

output "task_execution_role_arn" {
  description = "ARN of the Fargate task execution role (image pull + logs)."
  value       = aws_iam_role.task_execution.arn
}

output "task_role_arn" {
  description = "ARN of the Fargate task role (application permissions)."
  value       = aws_iam_role.task.arn
}

output "dlq_read_policy_arn" {
  description = "ARN of the operator DLQ read-only policy."
  value       = aws_iam_policy.dlq_read.arn
}
