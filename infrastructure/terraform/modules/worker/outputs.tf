output "ecr_repository_url" {
  description = "URL to docker push the worker image to."
  value       = aws_ecr_repository.worker.repository_url
}

output "ecr_repository_arn" {
  description = "ARN of the worker ECR repository."
  value       = aws_ecr_repository.worker.arn
}

output "cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.this.name
}

output "cluster_arn" {
  description = "ECS cluster ARN."
  value       = aws_ecs_cluster.this.arn
}

output "service_name" {
  description = "ECS service name for the worker."
  value       = aws_ecs_service.worker.name
}

output "task_definition_arn" {
  description = "ARN of the worker task definition."
  value       = aws_ecs_task_definition.worker.arn
}

output "log_group_name" {
  description = "Worker CloudWatch log group."
  value       = aws_cloudwatch_log_group.worker.name
}
