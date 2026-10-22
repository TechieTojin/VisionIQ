# Containerized YOLO inference worker on ECS Fargate.
#
# Why not Lambda: torch plus model weights exceed the practical Lambda package
# budget and the cold start would dominate request latency. Fargate bills only
# while a task runs, so with worker_desired_count = 0 an idle environment costs
# nothing for compute.

data "aws_region" "current" {}

locals {
  image_uri = "${aws_ecr_repository.worker.repository_url}:${var.image_tag}"
}

# -----------------------------------------------------------------------------
# Image registry
# -----------------------------------------------------------------------------

resource "aws_ecr_repository" "worker" {
  name                 = var.ecr_repository_name
  image_tag_mutability = "MUTABLE"
  force_delete         = true # so `terraform destroy` does not strand the repo

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "worker" {
  repository = aws_ecr_repository.worker.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = var.ecr_untagged_expiry_days
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Retain only the most recent tagged images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = var.ecr_max_tagged_images
        }
        action = { type = "expire" }
      },
    ]
  })
}

# -----------------------------------------------------------------------------
# Cluster, logs, task definition
# -----------------------------------------------------------------------------

resource "aws_ecs_cluster" "this" {
  name = "${var.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = var.enable_container_insights ? "enabled" : "disabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 0
  }
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "${var.log_group_prefix}/worker"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name_prefix}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = var.task_execution_role_arn
  task_role_arn            = var.task_role_arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name      = "worker"
      image     = local.image_uri
      essential = true

      readonlyRootFilesystem = false # torch writes to a cache dir
      user                   = "1000:1000"

      environment = [
        { name = "INFERENCE_QUEUE_URL", value = var.queue_url },
        { name = "IMAGE_BUCKET", value = var.bucket_name },
        { name = "UPLOAD_PREFIX", value = var.upload_prefix },
        { name = "RESULTS_PREFIX", value = var.results_prefix },
        { name = "ANALYSES_TABLE", value = var.table_name },
        { name = "AWS_REGION", value = data.aws_region.current.name },
        { name = "ENABLE_BEDROCK", value = tostring(var.enable_bedrock) },
        { name = "BEDROCK_MODEL_ID", value = var.bedrock_model_id },
        { name = "PROCESSING_TIMEOUT_SECONDS", value = tostring(var.worker_processing_timeout_seconds) },
        { name = "SQS_WAIT_TIME_SECONDS", value = "20" },
        { name = "LOG_LEVEL", value = "INFO" },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.worker.name
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-stream-prefix" = "worker"
        }
      }

      stopTimeout = 120
    }
  ])
}

resource "aws_ecs_service" "worker" {
  name            = "${var.name_prefix}-worker"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_desired_count
  launch_type     = "FARGATE"

  enable_execute_command = false
  propagate_tags         = "SERVICE"

  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 200

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [var.security_group_id]
    assign_public_ip = var.assign_public_ip
  }

  # Autoscaling owns desired_count after the first apply.
  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_ecs_cluster_capacity_providers.this]
}

# -----------------------------------------------------------------------------
# Autoscaling on queue depth
#
# Step scaling (not target tracking) because target tracking cannot scale a
# service away from zero: the backlog-per-task metric is undefined with no
# running tasks.
# -----------------------------------------------------------------------------

resource "aws_appautoscaling_target" "worker" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.worker.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.worker_desired_count
  max_capacity       = var.worker_max_count
}

resource "aws_appautoscaling_policy" "scale_out" {
  name               = "${var.name_prefix}-worker-scale-out"
  service_namespace  = aws_appautoscaling_target.worker.service_namespace
  resource_id        = aws_appautoscaling_target.worker.resource_id
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension
  policy_type        = "StepScaling"

  step_scaling_policy_configuration {
    adjustment_type         = "ExactCapacity"
    cooldown                = 60
    metric_aggregation_type = "Maximum"

    # Backlog 1-9 messages -> 1 task; 10-49 -> 2; 50+ -> max.
    step_adjustment {
      metric_interval_lower_bound = 0
      metric_interval_upper_bound = 9
      scaling_adjustment          = 1
    }

    step_adjustment {
      metric_interval_lower_bound = 9
      metric_interval_upper_bound = 49
      scaling_adjustment          = min(2, var.worker_max_count)
    }

    step_adjustment {
      metric_interval_lower_bound = 49
      scaling_adjustment          = var.worker_max_count
    }
  }
}

resource "aws_appautoscaling_policy" "scale_in" {
  name               = "${var.name_prefix}-worker-scale-in"
  service_namespace  = aws_appautoscaling_target.worker.service_namespace
  resource_id        = aws_appautoscaling_target.worker.resource_id
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension
  policy_type        = "StepScaling"

  step_scaling_policy_configuration {
    adjustment_type         = "ExactCapacity"
    cooldown                = 300
    metric_aggregation_type = "Maximum"

    step_adjustment {
      metric_interval_upper_bound = 0
      scaling_adjustment          = var.worker_desired_count
    }
  }
}

# Both alarms measure visible PLUS not-visible (in-flight) messages. Using the
# visible count alone would read 0 the moment a worker receives a message, and
# the scale-in alarm would then terminate the task mid-inference; the message
# would reappear after the visibility timeout and, after maxReceiveCount
# attempts, land on the DLQ. Backlog = Visible + NotVisible is the only safe
# signal for a scale-to-zero consumer.

resource "aws_cloudwatch_metric_alarm" "queue_has_work" {
  alarm_name          = "${var.name_prefix}-worker-queue-has-work"
  alarm_description   = "Inference queue has pending or in-flight messages; scale the worker out."
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "backlog"
    expression  = "visible + inflight"
    label       = "Messages visible plus in flight"
    return_data = true
  }

  metric_query {
    id = "visible"

    metric {
      namespace   = "AWS/SQS"
      metric_name = "ApproximateNumberOfMessagesVisible"
      period      = 60
      stat        = "Maximum"

      dimensions = {
        QueueName = var.queue_name
      }
    }
  }

  metric_query {
    id = "inflight"

    metric {
      namespace   = "AWS/SQS"
      metric_name = "ApproximateNumberOfMessagesNotVisible"
      period      = 60
      stat        = "Maximum"

      dimensions = {
        QueueName = var.queue_name
      }
    }
  }

  alarm_actions = [aws_appautoscaling_policy.scale_out.arn]
}

resource "aws_cloudwatch_metric_alarm" "queue_drained" {
  alarm_name          = "${var.name_prefix}-worker-queue-drained"
  alarm_description   = "Inference queue has had no pending or in-flight messages for 5 minutes; scale the worker back down."
  evaluation_periods  = 5
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "backlog"
    expression  = "visible + inflight"
    label       = "Messages visible plus in flight"
    return_data = true
  }

  metric_query {
    id = "visible"

    metric {
      namespace   = "AWS/SQS"
      metric_name = "ApproximateNumberOfMessagesVisible"
      period      = 60
      stat        = "Maximum"

      dimensions = {
        QueueName = var.queue_name
      }
    }
  }

  metric_query {
    id = "inflight"

    metric {
      namespace   = "AWS/SQS"
      metric_name = "ApproximateNumberOfMessagesNotVisible"
      period      = 60
      stat        = "Maximum"

      dimensions = {
        QueueName = var.queue_name
      }
    }
  }

  alarm_actions = [aws_appautoscaling_policy.scale_in.arn]
}
