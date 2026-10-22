# Lightweight control-plane API: API Gateway HTTP API in front of six small
# Lambda functions. These operations are I/O-bound, sub-second and tiny, so
# Lambda is the right fit here. Inference itself is NOT here - it runs on
# Fargate because torch + model weights blow past Lambda's package and
# cold-start budget.

locals {
  functions = {
    presign = {
      handler     = "handler.presign"
      description = "Issue a presigned S3 PUT URL scoped to the upload prefix."
      route       = "POST /api/uploads/presign"
    }
    create_job = {
      handler     = "handler.create_job"
      description = "Create an analysis job record and enqueue it for inference."
      route       = "POST /api/jobs"
    }
    get_job = {
      handler     = "handler.get_job"
      description = "Return a single analysis job's status and results."
      route       = "GET /api/jobs/{id}"
    }
    list_jobs = {
      handler     = "handler.list_jobs"
      description = "List an owner's analyses newest-first via the GSI."
      route       = "GET /api/jobs"
    }
    cancel_job = {
      handler     = "handler.cancel_job"
      description = "Cancel a queued job that no worker has claimed yet."
      route       = "POST /api/jobs/{id}/cancel"
    }
    delete_job = {
      handler     = "handler.delete_job"
      description = "Delete an analysis record and its uploaded image."
      route       = "DELETE /api/jobs/{id}"
    }
  }

  common_env = {
    IMAGE_BUCKET           = var.bucket_name
    UPLOAD_PREFIX          = var.upload_prefix
    ANALYSES_TABLE         = var.table_name
    ANALYSES_INDEX         = var.table_index_name
    INFERENCE_QUEUE_URL    = var.queue_url
    PRESIGN_EXPIRY_SECONDS = tostring(var.presign_expiry_seconds)
    ENABLE_BEDROCK         = tostring(var.enable_bedrock)
    BEDROCK_MODEL_ID       = var.bedrock_model_id
    LOG_LEVEL              = "INFO"
  }
}

data "archive_file" "api" {
  type        = "zip"
  source_dir  = var.lambda_source_dir
  output_path = "${path.module}/.build/api-lambda.zip"
  excludes    = ["__pycache__", "*.pyc", ".pytest_cache"]
}

resource "aws_cloudwatch_log_group" "lambda" {
  for_each = local.functions

  name              = "${var.log_group_prefix}/lambda/${replace(each.key, "_", "-")}"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "api" {
  for_each = local.functions

  function_name = "${var.name_prefix}-${replace(each.key, "_", "-")}"
  description   = each.value.description
  role          = var.lambda_role_arn
  handler       = each.value.handler
  runtime       = var.lambda_runtime
  architectures = ["arm64"] # cheaper per GB-second than x86_64

  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256

  memory_size = var.lambda_memory_mb
  timeout     = var.lambda_timeout_seconds

  environment {
    variables = local.common_env
  }

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.lambda[each.key].name
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.lambda]
}

# -----------------------------------------------------------------------------
# HTTP API
# -----------------------------------------------------------------------------

resource "aws_apigatewayv2_api" "this" {
  name          = "${var.name_prefix}-api"
  protocol_type = "HTTP"
  description   = "VisionIQ control-plane API (presign, create job, poll job)."

  cors_configuration {
    allow_origins     = var.allowed_origins
    allow_methods     = ["GET", "POST", "OPTIONS"]
    allow_headers     = ["content-type", "authorization", "x-amz-date", "x-amz-security-token"]
    expose_headers    = ["x-request-id"]
    allow_credentials = false
    max_age           = 300
  }
}

resource "aws_cloudwatch_log_group" "access" {
  name              = "${var.log_group_prefix}/apigw/access"
  retention_in_days = var.log_retention_days
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_rate_limit    = var.throttle_rate_limit
    throttling_burst_limit   = var.throttle_burst_limit
    detailed_metrics_enabled = true
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn

    format = jsonencode({
      requestId          = "$context.requestId"
      ip                 = "$context.identity.sourceIp"
      requestTime        = "$context.requestTime"
      httpMethod         = "$context.httpMethod"
      routeKey           = "$context.routeKey"
      status             = "$context.status"
      protocol           = "$context.protocol"
      responseLength     = "$context.responseLength"
      integrationLatency = "$context.integrationLatency"
      integrationStatus  = "$context.integrationStatus"
      errorMessage       = "$context.error.message"
    })
  }
}

resource "aws_apigatewayv2_integration" "api" {
  for_each = local.functions

  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api[each.key].invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = var.lambda_timeout_seconds * 1000
}

# -----------------------------------------------------------------------------
# Authentication
#
# A JWT authorizer validates the Cognito-issued access token on EVERY route
# below before the request ever reaches a Lambda. API Gateway checks the
# signature against the issuer's JWKS, the `aud` claim against the app client
# id, and `exp`/`iss`, then passes the verified claims to the integration at
# event.requestContext.authorizer.jwt.claims.
#
# PUBLIC ROUTES: none. All four routes (presign, create job, get job, list jobs)
# are protected. There is no health/status route on this API - if one is added
# later it is the only route that should omit authorizer_id, and the automatic
# CORS preflight OPTIONS responses are served by API Gateway itself and are
# never authorized.
# -----------------------------------------------------------------------------

resource "aws_apigatewayv2_authorizer" "jwt" {
  api_id           = aws_apigatewayv2_api.this.id
  name             = "${var.name_prefix}-jwt"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    audience = var.jwt_audience
    issuer   = var.jwt_issuer
  }
}

resource "aws_apigatewayv2_route" "api" {
  for_each = local.functions

  api_id    = aws_apigatewayv2_api.this.id
  route_key = each.value.route
  target    = "integrations/${aws_apigatewayv2_integration.api[each.key].id}"

  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

resource "aws_lambda_permission" "apigw" {
  for_each = local.functions

  statement_id  = "AllowInvokeFromHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api[each.key].function_name
  principal     = "apigateway.amazonaws.com"

  # Scoped to this API and this route only.
  source_arn = "${aws_apigatewayv2_api.this.execution_arn}/*/${replace(replace(each.value.route, " ", ""), "{id}", "*")}"
}
