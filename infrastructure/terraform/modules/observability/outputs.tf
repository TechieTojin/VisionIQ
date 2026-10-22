output "sns_topic_arn" {
  description = "ARN of the alarm notification topic."
  value       = aws_sns_topic.alarms.arn
}

output "dashboard_name" {
  description = "Name of the CloudWatch overview dashboard."
  value       = aws_cloudwatch_dashboard.main.dashboard_name
}

output "alarm_names" {
  description = "All alarm names created by this module."
  value = concat(
    [
      aws_cloudwatch_metric_alarm.dlq_not_empty.alarm_name,
      aws_cloudwatch_metric_alarm.queue_age.alarm_name,
      aws_cloudwatch_metric_alarm.worker_task_failures.alarm_name,
      aws_cloudwatch_metric_alarm.api_5xx.alarm_name,
      aws_cloudwatch_metric_alarm.api_p99_latency.alarm_name,
    ],
    [for a in aws_cloudwatch_metric_alarm.lambda_errors : a.alarm_name],
    [for a in aws_cloudwatch_metric_alarm.cloudfront_5xx_rate : a.alarm_name],
  )
}
