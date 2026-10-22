# Inference work queue. The API enqueues one message per analysis job; the
# Fargate worker long-polls with ReceiveMessage(WaitTimeSeconds=20).
#
# Visibility timeout MUST exceed the worst-case worker processing time, or a
# second worker will pick up an in-flight image and duplicate the inference.

locals {
  visibility_timeout = var.worker_processing_timeout_seconds + var.visibility_timeout_headroom_seconds
}

resource "aws_sqs_queue" "dlq" {
  name                      = "${var.name_prefix}-inference-dlq"
  message_retention_seconds = var.dlq_message_retention_seconds

  # SSE with the AWS-managed SQS key: encrypted at rest, no KMS key charge.
  sqs_managed_sse_enabled = true
}

resource "aws_sqs_queue" "inference" {
  name                       = "${var.name_prefix}-inference"
  visibility_timeout_seconds = local.visibility_timeout
  message_retention_seconds  = var.message_retention_seconds
  receive_wait_time_seconds  = 20 # long polling
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = var.max_receive_count
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  queue_url = aws_sqs_queue.dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.inference.arn]
  })
}

data "aws_iam_policy_document" "inference_tls" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["sqs:*"]
    resources = [aws_sqs_queue.inference.arn]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_sqs_queue_policy" "inference" {
  queue_url = aws_sqs_queue.inference.id
  policy    = data.aws_iam_policy_document.inference_tls.json
}
