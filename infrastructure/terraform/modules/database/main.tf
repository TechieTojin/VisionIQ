# Analysis job records.
#   PK  owner_id      - the authenticated principal that owns the analysis
#   SK  analysis_id   - ULID/UUID of the analysis job
#   GSI owner_created - list an owner's analyses newest-first by created_at
#
# On-demand billing: no idle cost, pay per request. Encrypted at rest with the
# AWS-owned DynamoDB key by default (no KMS key charge); set a CMK only if a
# compliance requirement demands it.

resource "aws_dynamodb_table" "analyses" {
  name         = "${var.name_prefix}-analyses"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "owner_id"
  range_key    = "analysis_id"

  deletion_protection_enabled = var.deletion_protection_enabled

  attribute {
    name = "owner_id"
    type = "S"
  }

  attribute {
    name = "analysis_id"
    type = "S"
  }

  attribute {
    name = "created_at"
    type = "S"
  }

  global_secondary_index {
    name            = "owner_created_at_index"
    hash_key        = "owner_id"
    range_key       = "created_at"
    projection_type = "ALL"
  }

  server_side_encryption {
    enabled = true
  }

  point_in_time_recovery {
    enabled = var.enable_point_in_time_recovery
  }

  ttl {
    attribute_name = var.ttl_attribute_name
    enabled        = true
  }

  lifecycle {
    prevent_destroy = false
  }
}
