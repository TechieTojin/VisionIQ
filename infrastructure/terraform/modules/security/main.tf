# Least-privilege IAM for the whole stack. Every data-plane statement names an
# explicit resource ARN; no `"*"` resource is used on S3, DynamoDB, SQS or
# Bedrock actions. Account id and partition come from the caller identity, so
# nothing here is environment- or account-specific.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  region     = data.aws_region.current.name

  ecr_repository_arn = "arn:${local.partition}:ecr:${local.region}:${local.account_id}:repository/${var.ecr_repository_name}"

  # Foundation-model ARNs are account-less by design.
  bedrock_model_arns = [
    "arn:${local.partition}:bedrock:${local.region}::foundation-model/${var.bedrock_model_id}",
    "arn:${local.partition}:bedrock:${local.region}:${local.account_id}:inference-profile/${var.bedrock_model_id}",
  ]

  log_group_arns = [
    "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:${var.log_group_prefix}/*",
    "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:${var.log_group_prefix}/*:log-stream:*",
  ]
}

# -----------------------------------------------------------------------------
# Trust policies
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "lambda_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    # Confused-deputy guard: only tasks in this account may assume the role.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

# -----------------------------------------------------------------------------
# API Lambda role: presign to the upload prefix, read/write its own job items.
# -----------------------------------------------------------------------------

resource "aws_iam_role" "lambda" {
  name               = "${var.name_prefix}-api-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

data "aws_iam_policy_document" "lambda" {
  statement {
    sid    = "LambdaLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = local.log_group_arns
  }

  # The API Lambdas run with tracing_config mode = "Active". X-Ray's write
  # actions support no resource-level permissions (there is no trace ARN to
  # name) and carry no data access; without this the functions silently drop
  # every segment.
  statement {
    sid    = "XRayTracing"
    effect = "Allow"
    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
    ]
    resources = ["*"]
  }

  # Presigning is a local signing operation, but the role must actually hold
  # the permission for the generated URL to be honoured.
  #
  # s3:DeleteObject is required by two paths, both of which only ever touch a
  # key the caller owns (the handler enforces the "{prefix}{owner}/" guard):
  #   - create_job rejecting an upload that fails server-side validation,
  #     so a bad object is not left to accrue storage charges
  #   - delete_job removing the image alongside the record
  # Still scoped to the upload prefix; never bucket-wide, and never the
  # results prefix, which only the worker writes.
  statement {
    sid    = "PresignUploadPrefix"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:DeleteObject",
    ]
    resources = ["${var.bucket_arn}/${var.upload_prefix}*"]
  }

  statement {
    sid       = "ReadResultArtifacts"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${var.bucket_arn}/${var.results_prefix}*"]
  }

  statement {
    sid    = "JobItemAccess"
    effect = "Allow"
    actions = [
      "dynamodb:PutItem",
      "dynamodb:GetItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
      # delete_job. The key is always {owner_id, analysis_id} with owner_id
      # taken from the verified JWT, so a caller can only delete their own.
      "dynamodb:DeleteItem",
    ]
    resources = [
      var.table_arn,
      var.table_index_arn,
    ]
  }

  statement {
    sid    = "EnqueueInferenceJob"
    effect = "Allow"
    actions = [
      "sqs:SendMessage",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
    ]
    resources = [var.queue_arn]
  }

  dynamic "statement" {
    for_each = var.enable_bedrock ? [1] : []

    content {
      sid       = "InvokeNarrativeModel"
      effect    = "Allow"
      actions   = ["bedrock:InvokeModel"]
      resources = local.bedrock_model_arns
    }
  }
}

resource "aws_iam_role_policy" "lambda" {
  name   = "${var.name_prefix}-api-lambda"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda.json
}

# -----------------------------------------------------------------------------
# Worker task execution role: pull the image, write logs. No data access.
# -----------------------------------------------------------------------------

resource "aws_iam_role" "task_execution" {
  name               = "${var.name_prefix}-worker-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

data "aws_iam_policy_document" "task_execution" {
  # GetAuthorizationToken has no resource-level support; it grants nothing on
  # its own and the pull itself is scoped to this one repository below.
  statement {
    sid       = "EcrAuth"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "EcrPullThisRepositoryOnly"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
    ]
    resources = [local.ecr_repository_arn]
  }

  statement {
    sid    = "WorkerLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = local.log_group_arns
  }
}

resource "aws_iam_role_policy" "task_execution" {
  name   = "${var.name_prefix}-worker-execution"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.task_execution.json
}

# -----------------------------------------------------------------------------
# Worker task role: read uploads, write results + job records, consume queue.
# -----------------------------------------------------------------------------

resource "aws_iam_role" "task" {
  name               = "${var.name_prefix}-worker-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

data "aws_iam_policy_document" "task" {
  statement {
    sid       = "ReadUploadedImagesOnly"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${var.bucket_arn}/${var.upload_prefix}*"]
  }

  statement {
    sid    = "WriteRenderedArtifactsOnly"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:GetObject",
    ]
    resources = ["${var.bucket_arn}/${var.results_prefix}*"]
  }

  statement {
    sid    = "UpdateJobRecords"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:UpdateItem",
      "dynamodb:PutItem",
    ]
    resources = [var.table_arn]
  }

  statement {
    sid    = "ConsumeInferenceQueue"
    effect = "Allow"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
    ]
    resources = [var.queue_arn]
  }

  statement {
    sid    = "WorkerLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = local.log_group_arns
  }

  dynamic "statement" {
    for_each = var.enable_bedrock ? [1] : []

    content {
      sid       = "InvokeNarrativeModel"
      effect    = "Allow"
      actions   = ["bedrock:InvokeModel"]
      resources = local.bedrock_model_arns
    }
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "${var.name_prefix}-worker-task"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

# -----------------------------------------------------------------------------
# Read-only role policy for operators to inspect the DLQ without draining it.
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "dlq_read" {
  statement {
    sid    = "InspectDeadLetterQueue"
    effect = "Allow"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
    ]
    resources = [var.dlq_arn]
  }
}

resource "aws_iam_policy" "dlq_read" {
  name        = "${var.name_prefix}-dlq-read"
  description = "Inspect the VisionIQ inference dead-letter queue (no delete)."
  policy      = data.aws_iam_policy_document.dlq_read.json
}
