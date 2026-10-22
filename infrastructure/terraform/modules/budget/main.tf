# Monthly cost budget scoped to this project's cost-allocation tag.
#
# The tag filter only works once `Project` has been activated as a cost
# allocation tag in Billing -> Cost allocation tags. Until then the budget
# still reports, but across the whole account rather than this project.
#
# Thresholds fire on ACTUAL spend at 50/80/100%, plus a FORECASTED alert at
# 100% so you hear about an overrun before the month ends.

resource "aws_budgets_budget" "monthly" {
  name         = "${var.name_prefix}-monthly"
  budget_type  = "COST"
  limit_amount = format("%.2f", var.budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = [format("user:%s$%s", var.cost_filter_tag_key, var.cost_filter_tag_value)]
  }

  cost_types {
    include_credit             = false
    include_refund             = false
    include_discount           = true
    include_subscription       = true
    include_support            = true
    include_tax                = true
    include_upfront            = true
    include_recurring          = true
    include_other_subscription = true
    use_amortized              = false
    use_blended                = false
  }

  dynamic "notification" {
    for_each = toset(var.thresholds)

    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_sns_topic_arns  = [var.notification_topic_arn]
      subscriber_email_addresses = var.alarm_email == "" ? [] : [var.alarm_email]
    }
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_sns_topic_arns  = [var.notification_topic_arn]
    subscriber_email_addresses = var.alarm_email == "" ? [] : [var.alarm_email]
  }
}
