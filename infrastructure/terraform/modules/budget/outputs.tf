output "budget_name" {
  description = "Name of the monthly cost budget."
  value       = aws_budgets_budget.monthly.name
}

output "budget_arn" {
  description = "ARN of the monthly cost budget."
  value       = aws_budgets_budget.monthly.arn
}
