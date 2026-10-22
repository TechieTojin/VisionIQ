output "bucket_name" {
  description = "Name of the private image bucket."
  value       = aws_s3_bucket.images.id
}

output "bucket_arn" {
  description = "ARN of the private image bucket."
  value       = aws_s3_bucket.images.arn
}

output "bucket_regional_domain_name" {
  description = "Regional domain name used when constructing presigned URLs."
  value       = aws_s3_bucket.images.bucket_regional_domain_name
}

output "upload_prefix" {
  description = "Key prefix clients may upload to."
  value       = var.upload_prefix
}

output "results_prefix" {
  description = "Key prefix the worker writes artifacts to."
  value       = var.results_prefix
}
