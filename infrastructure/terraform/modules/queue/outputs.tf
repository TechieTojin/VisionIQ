output "queue_url" {
  description = "URL of the main inference queue."
  value       = aws_sqs_queue.inference.id
}

output "queue_arn" {
  description = "ARN of the main inference queue."
  value       = aws_sqs_queue.inference.arn
}

output "queue_name" {
  description = "Name of the main inference queue (used as a CloudWatch dimension)."
  value       = aws_sqs_queue.inference.name
}

output "dlq_url" {
  description = "URL of the dead-letter queue."
  value       = aws_sqs_queue.dlq.id
}

output "dlq_arn" {
  description = "ARN of the dead-letter queue."
  value       = aws_sqs_queue.dlq.arn
}

output "dlq_name" {
  description = "Name of the dead-letter queue (used as a CloudWatch dimension)."
  value       = aws_sqs_queue.dlq.name
}

output "visibility_timeout_seconds" {
  description = "Effective visibility timeout on the main queue."
  value       = local.visibility_timeout
}
