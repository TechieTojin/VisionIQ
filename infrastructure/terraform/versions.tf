terraform {
  required_version = ">= 1.6.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.70"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # ---------------------------------------------------------------------------
  # Remote state. Intentionally a PARTIAL configuration: no bucket, table or
  # account identifiers are committed. Supply them at init time, e.g.
  #
  #   terraform init \
  #     -backend-config=backend.hcl \
  #     -reconfigure
  #
  # where backend.hcl (gitignored) contains:
  #
  #   bucket         = "<your-tfstate-bucket>"
  #   key            = "visioniq/<env>/terraform.tfstate"
  #   region         = "<your-region>"
  #   dynamodb_table = "<your-tfstate-lock-table>"
  #   encrypt        = true
  #
  # See README.md -> "State backend" for bootstrap instructions.
  # ---------------------------------------------------------------------------
  backend "s3" {
    encrypt = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.common_tags
  }
}
