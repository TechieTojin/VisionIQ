output "vpc_id" {
  description = "Id of the VisionIQ VPC."
  value       = aws_vpc.this.id
}

output "public_subnet_ids" {
  description = "Public subnet ids the Fargate worker runs in."
  value       = aws_subnet.public[*].id
}

output "worker_security_group_id" {
  description = "Egress-only security group for worker tasks."
  value       = aws_security_group.worker.id
}
