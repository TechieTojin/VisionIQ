"""VisionIQ control-plane Lambda handlers.

Small, I/O-bound operations fronted by the API Gateway HTTP API:

    presign     POST   /api/uploads/presign   -> presigned S3 PUT URL
    create_job  POST   /api/jobs              -> DynamoDB record + SQS message
    get_job     GET    /api/jobs/{id}         -> job status/results
    list_jobs   GET    /api/jobs              -> owner's jobs, paginated
    cancel_job  POST   /api/jobs/{id}/cancel  -> cancel a job not yet claimed
    delete_job  DELETE /api/jobs/{id}         -> remove a record and its image

Dependency-free (boto3 ships in the Lambda runtime) so the Terraform
`archive_file` package stays a few kilobytes.

===========================================================================
CROSS-COMPONENT CONTRACTS — change these only in lockstep
===========================================================================

1. STORAGE KEY:  "{UPLOAD_PREFIX}{owner_id}/{analysis_id}.{ext}"
   Mirrors backend/app/storage/base.py::build_key. The worker's IAM policy
   grants s3:GetObject on "<bucket>/{UPLOAD_PREFIX}*" only, so a key built
   any other way is unreadable by the worker.

2. SQS MESSAGE:  {"analysis_id", "owner_id", "image_key"}
   Mirrors backend/app/cloud/jobs.py::enqueue. The worker
   (backend/app/cloud/worker.py::process_message) requires analysis_id and
   owner_id; "image_key" is included so both producers agree.

3. DYNAMODB ITEM: promoted query attributes PLUS a "payload" attribute
   holding the full AnalysisRecord JSON. The worker reads records through
   backend/app/repositories/dynamo_repo.py, which does
   `AnalysisRecord.model_validate(item["payload"])` — an item without a
   parseable "payload" makes every job fail and land on the DLQ.

Floats are avoided entirely in the payload (0 rather than 0.0) because
DynamoDB rejects float and would otherwise require Decimal conversion.

===========================================================================
OWNERSHIP
===========================================================================
`owner_id` is the `sub` claim of the Cognito access token, as verified by the
API Gateway JWT authorizer and handed to us at
`event.requestContext.authorizer.jwt.claims.sub`. There is no fallback: if the
claim is absent the request is rejected with 401. The owner id is NEVER read
from the body, the query string or a header — those are caller-controlled and
would let anyone address another tenant's partition key.
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
import os
import re
import uuid
from datetime import datetime, timedelta, timezone

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

LOG = logging.getLogger()
LOG.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

IMAGE_BUCKET = os.environ["IMAGE_BUCKET"]
UPLOAD_PREFIX = os.environ["UPLOAD_PREFIX"]
ANALYSES_TABLE = os.environ["ANALYSES_TABLE"]
ANALYSES_INDEX = os.environ["ANALYSES_INDEX"]
INFERENCE_QUEUE_URL = os.environ["INFERENCE_QUEUE_URL"]
# Fallback matches the FastAPI backend's VISIONIQ_PRESIGN_TTL default, so the
# two implementations agree on behaviour and not merely on response shape.
PRESIGN_EXPIRY_SECONDS = int(os.environ.get("PRESIGN_EXPIRY_SECONDS", "300"))
RECORD_TTL_DAYS = int(os.environ.get("RECORD_TTL_DAYS", "90"))
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", str(10 * 1024 * 1024)))

# Mirrors backend/app/config.py ALLOWED_FORMATS.
CONTENT_TYPE_TO_FORMAT = {
    "image/jpeg": "JPEG",
    "image/png": "PNG",
    "image/webp": "WEBP",
}
FORMAT_TO_EXT = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp"}

# Terminal states a job can never leave.
TERMINAL_STATUSES = {"completed", "failed", "cancelled"}

_ANALYSIS_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$")

s3 = boto3.client("s3")
sqs = boto3.client("sqs")
table = boto3.resource("dynamodb").Table(ANALYSES_TABLE)


# --------------------------------------------------------------------------- #
# responses
# --------------------------------------------------------------------------- #


def _response(status: int, body: dict) -> dict:
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json",
            # Defence in depth; CloudFront sets these for the SPA, but API
            # responses should not be sniffable or framable either.
            "x-content-type-options": "nosniff",
            "cache-control": "no-store",
        },
        "body": json.dumps(body, default=str),
    }


# --------------------------------------------------------------------------- #
# canonical response projections
#
# FastAPI's successful response schemas are THE contract (Phase 3.8). This
# Lambda returns the same shapes for equivalent resources, so a client can
# talk to either backend without branching on response format:
#
#   get/create/cancel job -> bare AnalysisRecord   (backend/app/schemas/analysis.py)
#   list jobs             -> bare AnalysisPage     {items, next_cursor, has_more}
#   presign               -> PresignResponse       {analysis_id, upload{...}}
#   delete                -> 204, no body
#
# Error envelopes are NOT part of this change: they already matched and are
# deliberately left as {success, error, detail}.
# --------------------------------------------------------------------------- #

# Fields of AnalysisSummary, in schema order. The DynamoDB item's promoted
# attributes are exactly this set, which is why listing needs no lookup.
_SUMMARY_FIELDS = (
    "analysis_id",
    "created_at",
    "status",
    "filename",
    "detection_count",
    "distinct_categories",
    "top_labels",
    "execution_mode",
)


def _record(item: dict):
    """Project a DynamoDB item to a bare AnalysisRecord, or None.

    The full record lives in `payload`; the surrounding attributes are
    storage concerns (owner_id, expires_at) that are not part of the API.

    Returns None when `payload` is absent or malformed. Callers must turn
    that into an explicit error: answering 200 with `{}` would hand the
    client something that fails to parse as an AnalysisRecord, which is
    worse than an honest failure.
    """
    payload = item.get("payload")
    if not isinstance(payload, dict) or not payload:
        return None
    return payload


def _corrupt_record(analysis_id: str) -> dict:
    LOG.error("record_missing_payload", extra={"analysis_id": analysis_id})
    return _error(
        500,
        "corrupt_record",
        "the stored analysis could not be read",
    )


def _summary(item: dict) -> dict:
    """Project a DynamoDB item to a bare AnalysisSummary."""
    summary = {field: item.get(field) for field in _SUMMARY_FIELDS}
    # Defaults matching the Pydantic model, for items written by older code.
    if summary.get("top_labels") is None:
        summary["top_labels"] = []
    if summary.get("execution_mode") is None:
        summary["execution_mode"] = "cloud"
    for numeric in ("detection_count", "distinct_categories"):
        if summary.get(numeric) is None:
            summary[numeric] = 0
    return summary


def _no_content() -> dict:
    """A 204 response with no body, as RFC 9110 requires."""
    return {
        "statusCode": 204,
        "headers": {
            "x-content-type-options": "nosniff",
            "cache-control": "no-store",
        },
    }


def _error(status: int, code: str, detail: str) -> dict:
    """Consistent error envelope, matching the FastAPI backend's shape."""
    return _response(status, {"success": False, "error": code, "detail": detail})


def _unauthorized() -> dict:
    return _error(
        401,
        "unauthenticated",
        "a valid Authorization: Bearer <access token> header is required",
    )


def _not_found() -> dict:
    # Deliberately identical whether the record is absent or owned by someone
    # else, so existence is never leaked across tenants.
    return _error(404, "not_found", "no such analysis for this owner")


# --------------------------------------------------------------------------- #
# request helpers
# --------------------------------------------------------------------------- #


def _owner_id(event: dict):
    """Return the verified subject of the caller, or None."""
    request_context = event.get("requestContext") or {}
    authorizer = request_context.get("authorizer") or {}
    jwt_context = authorizer.get("jwt") or {}
    claims = jwt_context.get("claims") or {}

    sub = claims.get("sub")
    if isinstance(sub, str) and sub.strip():
        return sub.strip()

    LOG.warning("rejecting request with no verified JWT sub claim")
    return None


def _body(event: dict) -> dict:
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        try:
            raw = base64.b64decode(raw).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError):
            return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _path_id(event: dict):
    return ((event.get("pathParameters") or {}).get("id") or "").strip()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ttl() -> int:
    return int((datetime.now(timezone.utc) + timedelta(days=RECORD_TTL_DAYS)).timestamp())


def _valid_analysis_id(value: str) -> bool:
    """Accept only opaque ids we could have issued.

    Keeps traversal characters and absurd lengths out of key construction.
    """
    return bool(_ANALYSIS_ID_RE.match(value))


def build_key(owner_id: str, analysis_id: str, image_format: str) -> str:
    """Mirror of backend/app/storage/base.py::build_key."""
    ext = FORMAT_TO_EXT.get(image_format.upper(), "bin")
    return f"{UPLOAD_PREFIX}{owner_id}/{analysis_id}.{ext}"


def _owns_key(key: str, owner_id: str) -> bool:
    """Mirror of backend/app/storage/base.py::assert_owned."""
    if ".." in key or key.startswith("/") or "\\" in key:
        return False
    prefix = f"{UPLOAD_PREFIX}{owner_id}/"
    return key.startswith(prefix) and bool(key[len(prefix) :].strip())


# --------------------------------------------------------------------------- #
# record construction — must stay parseable by AnalysisRecord
# --------------------------------------------------------------------------- #


def _queued_item(owner_id: str, analysis_id: str, image_key: str, content_type: str) -> dict:
    """Build a DynamoDB item the backend repository can read back.

    Image dimensions are unknown until the worker decodes the bytes, so they
    are placeholders — exactly as backend/app/routes/cloud.py does when it
    creates a job. The worker overwrites the record on completion.
    """
    image_format = CONTENT_TYPE_TO_FORMAT.get(content_type, "JPEG")
    created_at = _now()

    payload = {
        "analysis_id": analysis_id,
        "owner_id": owner_id,
        "created_at": created_at,
        "status": "queued",
        "image": {
            "filename": image_key.rsplit("/", 1)[-1],
            "content_type": content_type,
            "format": image_format,
            # Integers, not floats: DynamoDB rejects float outright.
            "width": 0,
            "height": 0,
            "mode": "unknown",
            "aspect_ratio": 0,
            "size_bytes": 0,
            "megapixels": 0,
        },
        "image_key": image_key,
        "detection": None,
        "retail": None,
        "insights": None,
        "processing_ms": None,
        "error": None,
        "execution_mode": "cloud",
    }

    return {
        # Primary key
        "owner_id": owner_id,
        "analysis_id": analysis_id,
        # Promoted attributes the repository's list() projects
        "created_at": created_at,
        "status": "queued",
        "filename": payload["image"]["filename"],
        "detection_count": 0,
        "distinct_categories": 0,
        "top_labels": [],
        "execution_mode": "cloud",
        # Full record for the worker and the detail endpoint
        "payload": payload,
        "expires_at": _ttl(),
    }


# --------------------------------------------------------------------------- #
# pagination — must match dynamo_repo.py's cursor format
# --------------------------------------------------------------------------- #


def _encode_cursor(last_key) -> str | None:
    if not last_key:
        return None
    plain = {k: (int(v) if isinstance(v, (int, float)) else str(v)) for k, v in last_key.items()}
    return base64.urlsafe_b64encode(json.dumps(plain, sort_keys=True).encode()).decode()


def _decode_cursor(cursor: str, owner_id: str):
    """Decode a cursor, refusing one that points at another tenant."""
    try:
        key = json.loads(base64.urlsafe_b64decode(cursor.encode()).decode())
    except (binascii.Error, ValueError, UnicodeDecodeError):
        return None
    if not isinstance(key, dict) or key.get("owner_id") != owner_id:
        return None
    return key


# --------------------------------------------------------------------------- #
# handlers
# --------------------------------------------------------------------------- #


def presign(event, _context):
    """Return a presigned PUT URL scoped to this owner's upload prefix."""
    owner = _owner_id(event)
    if owner is None:
        return _unauthorized()

    body = _body(event)
    content_type = str(body.get("content_type", "image/jpeg")).strip().lower()

    if content_type not in CONTENT_TYPE_TO_FORMAT:
        return _error(
            400,
            "unsupported_format",
            f"supported types: {', '.join(sorted(CONTENT_TYPE_TO_FORMAT))}",
        )

    # The declared size is advisory — the client can lie — but rejecting an
    # obviously oversized upload here avoids paying for the transfer.
    declared = body.get("size_bytes")
    if declared is not None:
        try:
            if int(declared) > MAX_UPLOAD_BYTES:
                return _error(
                    413,
                    "file_too_large",
                    f"declared size exceeds the {MAX_UPLOAD_BYTES} byte limit",
                )
        except (TypeError, ValueError):
            return _error(400, "invalid_request", "size_bytes must be an integer")

    analysis_id = uuid.uuid4().hex
    key = build_key(owner, analysis_id, CONTENT_TYPE_TO_FORMAT[content_type])

    try:
        url = s3.generate_presigned_url(
            ClientMethod="put_object",
            Params={
                "Bucket": IMAGE_BUCKET,
                "Key": key,
                "ContentType": content_type,
                "ServerSideEncryption": "AES256",
            },
            ExpiresIn=PRESIGN_EXPIRY_SECONDS,
        )
    except ClientError:
        LOG.exception("presign_failed")
        return _error(503, "storage_unavailable", "could not create an upload URL")

    # PresignResponse: {analysis_id, upload} — the `upload` dict mirrors
    # backend/app/storage/s3_storage.py::presign_put exactly.
    return _response(
        200,
        {
            "analysis_id": analysis_id,
            "upload": {
                "url": url,
                "key": key,
                "expires_in": PRESIGN_EXPIRY_SECONDS,
                "required_headers": {
                    "Content-Type": content_type,
                    "x-amz-server-side-encryption": "AES256",
                },
                "max_bytes": MAX_UPLOAD_BYTES,
            },
        },
    )


def create_job(event, _context):
    """Verify the uploaded object, write a queued record, then enqueue it."""
    owner = _owner_id(event)
    if owner is None:
        return _unauthorized()

    body = _body(event)
    analysis_id = str(body.get("analysis_id") or "").strip()
    # Accept either name: "object_key" is what presign returns.
    object_key = str(body.get("object_key") or body.get("image_key") or "").strip()

    if not analysis_id or not object_key:
        return _error(400, "invalid_request", "analysis_id and object_key are required")
    if not _valid_analysis_id(analysis_id):
        return _error(400, "invalid_request", "analysis_id is malformed")

    # Never trust a client-supplied key outside this owner's own prefix.
    if not _owns_key(object_key, owner):
        return _error(403, "forbidden", "object_key is outside the caller's prefix")

    # Server-side verification: the object must really exist, be within the
    # size limit, and be a supported type. A client can lie at presign time.
    try:
        head = s3.head_object(Bucket=IMAGE_BUCKET, Key=object_key)
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code in {"404", "NoSuchKey", "NotFound"}:
            return _error(404, "not_found", "no uploaded object for that key")
        LOG.exception("head_object_failed")
        return _error(503, "storage_unavailable", "could not verify the upload")

    size = int(head.get("ContentLength", 0))
    content_type = str(head.get("ContentType", "")).strip().lower()

    if size > MAX_UPLOAD_BYTES:
        _delete_object(object_key)
        return _error(413, "file_too_large", "the uploaded object exceeds the size limit")
    if size == 0:
        _delete_object(object_key)
        return _error(400, "empty_file", "the uploaded object is empty")
    if content_type not in CONTENT_TYPE_TO_FORMAT:
        _delete_object(object_key)
        return _error(400, "unsupported_format", "the uploaded object is not a supported image")

    item = _queued_item(owner, analysis_id, object_key, content_type)

    # Idempotent: a retried create for the same id must not enqueue twice.
    try:
        table.put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(analysis_id)",
        )
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            existing = table.get_item(Key={"owner_id": owner, "analysis_id": analysis_id})
            record = _record(existing.get("Item") or item)
            if record is None:
                return _corrupt_record(analysis_id)
            return _response(202, record)
        LOG.exception("put_item_failed")
        return _error(503, "storage_unavailable", "could not create the analysis record")

    try:
        sqs.send_message(
            QueueUrl=INFERENCE_QUEUE_URL,
            MessageBody=json.dumps(
                {
                    "analysis_id": analysis_id,
                    "owner_id": owner,
                    "image_key": object_key,
                }
            ),
        )
    except ClientError:
        # The record exists but no worker will pick it up; say so rather than
        # leaving the caller polling a job that will never start.
        LOG.exception("enqueue_failed")
        _set_status(owner, analysis_id, "failed", "could not enqueue for processing")
        return _error(503, "queue_unavailable", "could not queue the analysis")

    record = _record(item)
    if record is None:
        return _corrupt_record(analysis_id)
    return _response(202, record)


def get_job(event, _context):
    """Return one job. Clients poll this until status is terminal."""
    owner = _owner_id(event)
    if owner is None:
        return _unauthorized()

    analysis_id = _path_id(event)
    if not analysis_id:
        return _error(400, "invalid_request", "path parameter id is required")

    result = table.get_item(Key={"owner_id": owner, "analysis_id": analysis_id})
    item = result.get("Item")
    if item is None:
        return _not_found()

    record = _record(item)
    if record is None:
        return _corrupt_record(analysis_id)
    return _response(200, record)


def list_jobs(event, _context):
    """List this owner's analyses newest-first, with keyset pagination."""
    owner = _owner_id(event)
    if owner is None:
        return _unauthorized()

    params = event.get("queryStringParameters") or {}

    raw_limit = params.get("limit", "25")
    try:
        limit = int(raw_limit)
    except (TypeError, ValueError):
        return _error(400, "invalid_request", "limit must be an integer")
    if limit < 1 or limit > 100:
        return _error(400, "invalid_request", "limit must be between 1 and 100")

    query = {
        "IndexName": ANALYSES_INDEX,
        "KeyConditionExpression": Key("owner_id").eq(owner),
        "ScanIndexForward": False,
        "Limit": limit,
    }

    cursor = params.get("cursor")
    if cursor:
        start_key = _decode_cursor(cursor, owner)
        if start_key is None:
            return _error(400, "invalid_request", "invalid pagination cursor")
        query["ExclusiveStartKey"] = start_key

    status_filter = params.get("status")
    if status_filter:
        query["FilterExpression"] = Key("status").eq(status_filter)

    try:
        result = table.query(**query)
    except ClientError:
        LOG.exception("query_failed")
        return _error(503, "storage_unavailable", "could not list analyses")

    next_cursor = _encode_cursor(result.get("LastEvaluatedKey"))

    # AnalysisPage: {items, next_cursor, has_more}. Items are projected to
    # AnalysisSummary so the response carries no storage internals
    # (owner_id, expires_at) and no heavy payload.
    return _response(
        200,
        {
            "items": [_summary(item) for item in result.get("Items", [])],
            "next_cursor": next_cursor,
            "has_more": next_cursor is not None,
        },
    )


def cancel_job(event, _context):
    """Cancel a job that no worker has claimed yet."""
    owner = _owner_id(event)
    if owner is None:
        return _unauthorized()

    analysis_id = _path_id(event)
    if not analysis_id:
        return _error(400, "invalid_request", "path parameter id is required")

    try:
        updated = table.update_item(
            Key={"owner_id": owner, "analysis_id": analysis_id},
            UpdateExpression="SET #s = :cancelled, payload.#s = :cancelled",
            # Only a queued job may be cancelled: once a worker has claimed
            # it, cancelling would leave the record lying about reality.
            ConditionExpression="attribute_exists(analysis_id) AND #s = :queued",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":cancelled": "cancelled", ":queued": "queued"},
            ReturnValues="ALL_NEW",
        )
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            existing = table.get_item(Key={"owner_id": owner, "analysis_id": analysis_id})
            if existing.get("Item") is None:
                return _not_found()
            current = existing["Item"].get("status", "unknown")
            return _error(
                409,
                "invalid_state",
                f"a job in state '{current}' cannot be cancelled",
            )
        LOG.exception("cancel_failed")
        return _error(503, "storage_unavailable", "could not cancel the analysis")

    record = _record(updated.get("Attributes") or {})
    if record is None:
        return _corrupt_record(analysis_id)
    return _response(200, record)


def delete_job(event, _context):
    """Delete a record and best-effort delete its uploaded image."""
    owner = _owner_id(event)
    if owner is None:
        return _unauthorized()

    analysis_id = _path_id(event)
    if not analysis_id:
        return _error(400, "invalid_request", "path parameter id is required")

    existing = table.get_item(Key={"owner_id": owner, "analysis_id": analysis_id})
    item = existing.get("Item")
    if item is None:
        return _not_found()

    image_key = (item.get("payload") or {}).get("image_key") or item.get("object_key")
    if isinstance(image_key, str) and _owns_key(image_key, owner):
        _delete_object(image_key)

    try:
        table.delete_item(Key={"owner_id": owner, "analysis_id": analysis_id})
    except ClientError:
        LOG.exception("delete_failed")
        return _error(503, "storage_unavailable", "could not delete the analysis")

    # 204 means "no content": RFC 9110 forbids a body, and some clients and
    # proxies mishandle one. Return the status bare, matching the FastAPI
    # backend's DELETE /api/analyses/{id}.
    return _no_content()


# --------------------------------------------------------------------------- #
# internal helpers
# --------------------------------------------------------------------------- #


def _delete_object(key: str) -> None:
    """Best-effort S3 cleanup. Never raises into a request path."""
    try:
        s3.delete_object(Bucket=IMAGE_BUCKET, Key=key)
    except ClientError:
        LOG.warning("object_delete_failed", extra={"key": key})


def _set_status(owner_id: str, analysis_id: str, status: str, error: str) -> None:
    try:
        table.update_item(
            Key={"owner_id": owner_id, "analysis_id": analysis_id},
            UpdateExpression="SET #s = :s, payload.#s = :s, payload.#e = :e",
            ExpressionAttributeNames={"#s": "status", "#e": "error"},
            ExpressionAttributeValues={":s": status, ":e": error},
        )
    except ClientError:
        LOG.warning("status_update_failed")
