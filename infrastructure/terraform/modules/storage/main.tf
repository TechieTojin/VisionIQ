# S3 bucket holding client-uploaded shelf images and worker-rendered artifacts.
# Private in every dimension: public access blocked, encrypted at rest,
# TLS required, ownership enforced so ACLs cannot grant access.

resource "aws_s3_bucket" "images" {
  bucket = "${var.name_prefix}-images-${var.bucket_suffix}"
}

resource "aws_s3_bucket_public_access_block" "images" {
  bucket = aws_s3_bucket.images.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "images" {
  bucket = aws_s3_bucket.images.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "images" {
  bucket = aws_s3_bucket.images.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "images" {
  bucket = aws_s3_bucket.images.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "images" {
  bucket     = aws_s3_bucket.images.id
  depends_on = [aws_s3_bucket_versioning.images]

  rule {
    id     = "expire-uploads"
    status = "Enabled"

    filter {
      prefix = var.upload_prefix
    }

    expiration {
      days = var.image_expiration_days
    }
  }

  rule {
    id     = "expire-results"
    status = "Enabled"

    filter {
      prefix = var.results_prefix
    }

    expiration {
      days = var.image_expiration_days
    }
  }

  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = var.abort_incomplete_multipart_days
    }
  }

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_expiration_days
    }
  }
}

# CORS is required for browser-issued presigned PUT uploads. PUT/GET/HEAD only;
# no DELETE from the browser. Origins are configurable and never "*".
resource "aws_s3_bucket_cors_configuration" "images" {
  bucket = aws_s3_bucket.images.id

  cors_rule {
    allowed_methods = ["PUT", "GET", "HEAD"]
    allowed_origins = var.allowed_origins
    allowed_headers = ["content-type", "content-length", "x-amz-*"]
    expose_headers  = ["ETag", "x-amz-request-id"]
    max_age_seconds = 3000
  }
}

data "aws_iam_policy_document" "bucket" {
  # Reject anything not arriving over TLS.
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.images.arn,
      "${aws_s3_bucket.images.arn}/*",
    ]

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

  # Reject uploads that would land unencrypted.
  statement {
    sid       = "DenyUnencryptedObjectUploads"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.images.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["AES256"]
    }

    condition {
      test     = "Null"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "images" {
  bucket = aws_s3_bucket.images.id
  policy = data.aws_iam_policy_document.bucket.json

  # The public access block must exist first, otherwise a policy touching
  # principal "*" can be rejected as public.
  depends_on = [aws_s3_bucket_public_access_block.images]
}
