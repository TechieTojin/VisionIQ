# Alarms, notifications and a single-pane dashboard.
#
# Note on log groups: each log group is declared by the module that produces
# the logs (api -> Lambda + API access logs, worker -> container logs), so the
# producing resource can reference it directly and retention is never left at
# "never expire". Retention for all of them is driven by the one
# log_retention_days variable.

resource "aws_sns_topic" "alarms" {
  name = "${var.name_prefix}-alarms"

  # Encrypted at rest with the AWS-managed SNS key (no KMS key charge).
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sns_topic_subscription" "email" {
  count = var.alarm_email == "" ? 0 : 1

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

data "aws_iam_policy_document" "topic" {
  statement {
    sid    = "AllowCloudWatchAlarmsToPublish"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com", "budgets.amazonaws.com"]
    }

    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.alarms.arn]
  }

  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.alarms.arn]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_sns_topic_policy" "alarms" {
  arn    = aws_sns_topic.alarms.arn
  policy = data.aws_iam_policy_document.topic.json
}

# -----------------------------------------------------------------------------
# Alarms
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  alarm_name          = "${var.name_prefix}-dlq-not-empty"
  alarm_description   = "One or more inference jobs failed three times and landed on the DLQ."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = var.dlq_name
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "queue_age" {
  alarm_name          = "${var.name_prefix}-queue-age-of-oldest-message"
  alarm_description   = "Jobs are sitting in the queue too long: the worker is down, starved or too slow."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.queue_age_alarm_seconds
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = var.queue_name
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "worker_task_failures" {
  alarm_name          = "${var.name_prefix}-worker-task-failures"
  alarm_description   = "Worker tasks are exiting: running task count fell to zero while the queue still had work."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  threshold           = 1
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "failures"
    expression  = "IF(backlog > 0 AND running < 1, 1, 0)"
    label       = "Backlog with no running worker"
    return_data = true
  }

  metric_query {
    id = "backlog"

    metric {
      namespace   = "AWS/SQS"
      metric_name = "ApproximateNumberOfMessagesVisible"
      period      = 300
      stat        = "Maximum"

      dimensions = {
        QueueName = var.queue_name
      }
    }
  }

  metric_query {
    id = "running"

    metric {
      namespace   = "ECS/ContainerInsights"
      metric_name = "RunningTaskCount"
      period      = 300
      stat        = "Maximum"

      dimensions = {
        ClusterName = var.cluster_name
        ServiceName = var.service_name
      }
    }
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${var.name_prefix}-api-5xx"
  alarm_description   = "API Gateway is returning server errors."
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.api_5xx_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    ApiId = var.api_id
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "api_p99_latency" {
  alarm_name          = "${var.name_prefix}-api-p99-latency"
  alarm_description   = "API p99 latency exceeded its budget."
  namespace           = "AWS/ApiGateway"
  metric_name         = "Latency"
  extended_statistic  = "p99"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.api_p99_latency_threshold_ms
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    ApiId = var.api_id
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = var.lambda_function_names

  alarm_name          = "${var.name_prefix}-lambda-errors-${each.key}"
  alarm_description   = "The ${each.key} Lambda is throwing errors."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 3
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = each.value
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
}

# -----------------------------------------------------------------------------
# Dashboard
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "${var.name_prefix}-overview"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "API requests and errors"
          region = var.aws_region
          view   = "timeSeries"
          stat   = "Sum"
          period = 300
          metrics = [
            ["AWS/ApiGateway", "Count", "ApiId", var.api_id],
            [".", "4xx", ".", "."],
            [".", "5xx", ".", "."],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "API latency (p50 / p99)"
          region = var.aws_region
          view   = "timeSeries"
          period = 300
          metrics = [
            ["AWS/ApiGateway", "Latency", "ApiId", var.api_id, { stat = "p50" }],
            ["...", { stat = "p99" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Inference queue depth and age"
          region = var.aws_region
          view   = "timeSeries"
          period = 300
          metrics = [
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", var.queue_name, { stat = "Maximum" }],
            ["...", var.dlq_name, { stat = "Maximum", label = "DLQ depth" }],
            ["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", var.queue_name, { stat = "Maximum", yAxis = "right" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Worker service utilisation"
          region = var.aws_region
          view   = "timeSeries"
          period = 300
          metrics = [
            ["ECS/ContainerInsights", "RunningTaskCount", "ClusterName", var.cluster_name, "ServiceName", var.service_name, { stat = "Maximum" }],
            ["AWS/ECS", "CPUUtilization", "ClusterName", var.cluster_name, "ServiceName", var.service_name, { stat = "Average" }],
            ["AWS/ECS", "MemoryUtilization", "ClusterName", var.cluster_name, "ServiceName", var.service_name, { stat = "Average" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "DynamoDB consumed capacity and throttles"
          region = var.aws_region
          view   = "timeSeries"
          stat   = "Sum"
          period = 300
          metrics = [
            ["AWS/DynamoDB", "ConsumedReadCapacityUnits", "TableName", var.table_name],
            [".", "ConsumedWriteCapacityUnits", ".", "."],
            [".", "ThrottledRequests", ".", "."],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "API Lambda errors"
          region = var.aws_region
          view   = "timeSeries"
          stat   = "Sum"
          period = 300
          metrics = [
            for name in values(var.lambda_function_names) :
            ["AWS/Lambda", "Errors", "FunctionName", name]
          ]
        }
      },
    ]
  })
}

# -----------------------------------------------------------------------------
# CloudFront 5xx error rate
#
# CloudFront publishes its metrics ONLY to us-east-1, under the fixed
# dimension Region = "Global". This module creates resources with the default
# provider, so the alarm can only be created when the stack itself is deployed
# to us-east-1; in any other region it is skipped rather than silently created
# against a dimension pair that will never report. Moving the stack to another
# region means adding an aliased us-east-1 provider here.
#
# 5xxErrorRate is a percentage, so the threshold is region/volume independent.
# treat_missing_data = "notBreaching": an idle distribution publishes nothing,
# and no traffic is not an outage.
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "cloudfront_5xx_rate" {
  count = var.cloudfront_distribution_id != "" && var.aws_region == "us-east-1" ? 1 : 0

  alarm_name          = "${var.name_prefix}-cloudfront-5xx-rate"
  alarm_description   = "CloudFront is answering SPA requests with server errors (origin unreachable, OAC/bucket-policy mismatch, or a bad deploy)."
  namespace           = "AWS/CloudFront"
  metric_name         = "5xxErrorRate"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.cloudfront_5xx_error_rate_percent
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    DistributionId = var.cloudfront_distribution_id
    Region         = "Global"
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]
}
