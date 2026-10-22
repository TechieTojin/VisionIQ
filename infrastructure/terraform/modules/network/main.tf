# Deliberately NAT-Gateway-free networking.
#
# A NAT Gateway costs roughly $32/month per AZ before a single byte of data
# processing, which would dominate this stack's bill. Instead the Fargate
# worker runs in PUBLIC subnets with assign_public_ip = true, so it reaches
# ECR, S3, SQS, DynamoDB, CloudWatch and Bedrock over the internet gateway at
# no hourly charge. Inbound is still impossible: the task security group has
# NO ingress rules at all, and nothing routes traffic to the tasks - they are
# pull-based SQS consumers, not servers.
#
# S3 and DynamoDB additionally use free Gateway VPC endpoints so that bulk
# image and item traffic never leaves the AWS network.

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${var.name_prefix}-vpc"
  }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${var.name_prefix}-igw"
  }
}

resource "aws_subnet" "public" {
  count = var.public_subnet_count

  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = false # tasks request a public IP explicitly instead

  tags = {
    Name = "${var.name_prefix}-public-${count.index}"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${var.name_prefix}-public"
  }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count = var.public_subnet_count

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Free gateway endpoints - no hourly charge, no data processing charge.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.name}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.public.id]

  tags = {
    Name = "${var.name_prefix}-s3-endpoint"
  }
}

resource "aws_vpc_endpoint" "dynamodb" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.name}.dynamodb"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.public.id]

  tags = {
    Name = "${var.name_prefix}-dynamodb-endpoint"
  }
}

data "aws_region" "current" {}

# Egress-only security group for the worker tasks: no ingress whatsoever.
resource "aws_security_group" "worker" {
  name        = "${var.name_prefix}-worker"
  description = "VisionIQ inference worker: outbound only, no inbound."
  vpc_id      = aws_vpc.this.id

  tags = {
    Name = "${var.name_prefix}-worker"
  }
}

resource "aws_vpc_security_group_egress_rule" "worker_https" {
  security_group_id = aws_security_group.worker.id
  description       = "HTTPS to AWS service endpoints (ECR, S3, SQS, DynamoDB, Logs, Bedrock)."
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}
