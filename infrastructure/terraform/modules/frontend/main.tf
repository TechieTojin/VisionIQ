# -----------------------------------------------------------------------------
# Frontend hosting: private S3 origin + CloudFront with Origin Access Control.
#
# The bucket is NEVER public and has NO website endpoint. The only way to read
# an object is through this distribution, which presents a SigV4-signed request
# via OAC; the bucket policy accepts exactly one principal (CloudFront) and
# exactly one source ARN (this distribution).
#
# The point of the module is the response headers policy further down: it is
# the only place in the stack that can attach a Content-Security-Policy to the
# SPA, because the SPA is static and there is no server to set headers.
#
# TWO-STEP APPLY (read this before the first apply):
#   The CloudFront domain name is only known after the distribution exists, but
#   Cognito's callback/logout URLs must contain it for hosted-UI sign-in to
#   work. Wiring module.frontend.spa_url into module.auth would create a cycle
#   only if auth fed the frontend - it does (cognito_hosted_ui_origin) - so the
#   CloudFront URL is deliberately NOT passed back into Cognito.
#
#   1. terraform apply  -> distribution is created; note `frontend_url`.
#   2. Append that URL to cognito_callback_urls / cognito_logout_urls (and to
#      allowed_origins) in environments/<env>.tfvars, then apply again.
#
#   With a custom domain the URL is known up front and one apply suffices.
# -----------------------------------------------------------------------------

locals {
  bucket_name = "${var.name_prefix}-frontend-${var.bucket_suffix}"

  # connect-src: every origin the SPA may open an XHR/fetch/WebSocket to.
  #   - the HTTP API (all data calls)
  #   - the Cognito hosted UI origin (token endpoint on the authorization-code
  #     + PKCE exchange)
  #   - the Cognito IDP origin (the identity SDK calls it directly)
  #   - the image bucket origin (presigned PUT of the shelf photo goes straight
  #     to S3, never through the API)
  connect_src = concat(
    [
      "'self'",
      var.api_origin,
      var.cognito_hosted_ui_origin,
      var.cognito_idp_origin,
      var.upload_bucket_origin,
    ],
    var.extra_connect_src,
  )

  # Each directive is one list element so the policy stays readable, diffable
  # and testable; they are joined with "; " to form the header value.
  csp_directives = [
    # Deny everything by default, then open only what the SPA provably needs.
    "default-src 'none'",

    # No 'unsafe-inline' and no 'unsafe-eval': a Vite production build emits
    # external, hashed module scripts only, so neither is needed.
    "script-src 'self'",

    # The ONE exception. Vite injects the stylesheet at runtime and the
    # dashboard uses React inline `style` props, both of which are inline
    # styles. Removing 'unsafe-inline' here requires per-build style hashes or
    # a per-request nonce; CloudFront's response headers policy is static and
    # cannot generate a nonce per request, so hashes (and a build step that
    # emits them) would be the only route. Inline *styles* carry far less risk
    # than inline scripts, so this is accepted deliberately.
    "style-src 'self' 'unsafe-inline'",

    # blob: is required: the dashboard previews the selected image with
    # URL.createObjectURL() before the presigned upload completes.
    "img-src 'self' data: blob:",

    "connect-src ${join(" ", local.connect_src)}",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "form-action 'self' ${var.cognito_hosted_ui_origin}",
    "upgrade-insecure-requests",
  ]

  content_security_policy = join("; ", local.csp_directives)
}

# -----------------------------------------------------------------------------
# Private origin bucket
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "spa" {
  bucket = local.bucket_name

  tags = {
    Name = local.bucket_name
  }
}

resource "aws_s3_bucket_public_access_block" "spa" {
  bucket = aws_s3_bucket.spa.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ACLs are disabled outright; access is decided by the bucket policy alone.
resource "aws_s3_bucket_ownership_controls" "spa" {
  bucket = aws_s3_bucket.spa.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "spa" {
  bucket = aws_s3_bucket.spa.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    # Bucket keys cut per-object encryption call costs and are free.
    bucket_key_enabled = true
  }
}

# Versioning gives an instant rollback for a bad SPA deploy.
resource "aws_s3_bucket_versioning" "spa" {
  bucket = aws_s3_bucket.spa.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Old bundle versions are dead weight after a couple of deploys.
resource "aws_s3_bucket_lifecycle_configuration" "spa" {
  bucket     = aws_s3_bucket.spa.id
  depends_on = [aws_s3_bucket_versioning.spa]

  rule {
    id     = "expire-noncurrent-bundles"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# -----------------------------------------------------------------------------
# Origin Access Control (SigV4) - the modern replacement for OAI.
# -----------------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "spa" {
  name                              = "${var.name_prefix}-frontend-oac"
  description                       = "SigV4 OAC for the ${var.environment} VisionIQ SPA bucket."
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_iam_policy_document" "spa_bucket" {
  statement {
    sid       = "AllowCloudFrontOACReadOnly"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.spa.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    # Scoped to THIS distribution: no other distribution, in this account or
    # any other, can read the bundle.
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.spa.arn]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.spa.arn, "${aws_s3_bucket.spa.arn}/*"]

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

resource "aws_s3_bucket_policy" "spa" {
  bucket = aws_s3_bucket.spa.id
  policy = data.aws_iam_policy_document.spa_bucket.json

  # The public access block must be in place before any policy is attached.
  depends_on = [aws_s3_bucket_public_access_block.spa]
}

# -----------------------------------------------------------------------------
# Response headers policy - the security headers the SPA is served with.
# -----------------------------------------------------------------------------

resource "aws_cloudfront_response_headers_policy" "security" {
  name    = "${var.name_prefix}-frontend-security-headers"
  comment = "CSP and security headers for the ${var.environment} VisionIQ SPA."

  security_headers_config {
    content_security_policy {
      content_security_policy = local.content_security_policy
      override                = true
    }

    strict_transport_security {
      access_control_max_age_sec = 63072000 # 2 years
      include_subdomains         = true
      preload                    = true
      override                   = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    xss_protection {
      # X-XSS-Protection is obsolete and its filter has its own bypasses; the
      # CSP above is the real defence. Explicitly set to 0 rather than left to
      # a browser default.
      protection = false
      override   = true
    }
  }

  # Headers CloudFront has no first-class field for.
  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()"
      override = true
    }

    items {
      header   = "Cross-Origin-Opener-Policy"
      value    = "same-origin"
      override = true
    }

    items {
      header   = "X-Permitted-Cross-Domain-Policies"
      value    = "none"
      override = true
    }
  }
}

# -----------------------------------------------------------------------------
# Distribution
# -----------------------------------------------------------------------------

# AWS-managed CachingOptimized policy. Referenced by its well-known id rather
# than a data source so the plan does not need an extra API call; the id is
# identical in every commercial region.
locals {
  managed_cache_policy_caching_optimized_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
}

resource "aws_cloudfront_distribution" "spa" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${var.name_prefix} SPA"
  default_root_object = "index.html"
  price_class         = var.price_class

  origin {
    origin_id                = "s3-${aws_s3_bucket.spa.id}"
    domain_name              = aws_s3_bucket.spa.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.spa.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-${aws_s3_bucket.spa.id}"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = local.managed_cache_policy_caching_optimized_id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  # SPA routing. React Router owns every path, including the OAuth callback
  # which lands on the root path with ?code=... - but any deep link the user
  # refreshes (e.g. /analyses/<id>) is a key that does not exist in the
  # bucket, so S3 answers 403 (OAC hides the 404). Both must be rewritten to
  # index.html with a 200 so the router can resolve the route client-side.
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  aliases = var.acm_certificate_arn == "" ? [] : var.aliases

  # TLS floor.
  #
  # CloudFront's API REJECTS MinimumProtocolVersion for anything other than
  # "TLSv1" while the default *.cloudfront.net certificate is in use - the
  # default certificate's own floor is fixed by AWS and cannot be raised. So
  # TLSv1.2_2021 is set on the branch that can actually carry it: a custom ACM
  # certificate. Supply acm_certificate_arn + aliases and this distribution
  # negotiates nothing below TLS 1.2 (2021 cipher suites).
  dynamic "viewer_certificate" {
    for_each = var.acm_certificate_arn == "" ? [1] : []

    content {
      cloudfront_default_certificate = true
    }
  }

  dynamic "viewer_certificate" {
    for_each = var.acm_certificate_arn == "" ? [] : [1]

    content {
      acm_certificate_arn      = var.acm_certificate_arn
      ssl_support_method       = "sni-only"
      minimum_protocol_version = var.minimum_protocol_version
    }
  }

  tags = {
    Name = "${var.name_prefix}-frontend"
  }
}

# Pre-created with an explicit retention so CloudFront logging (standard
# logging v2 to CloudWatch Logs, or a CloudFront Function) never lands in a
# never-expire group.
resource "aws_cloudwatch_log_group" "frontend" {
  name              = "/aws/cloudfront/${var.name_prefix}-frontend"
  retention_in_days = var.log_retention_days
}
