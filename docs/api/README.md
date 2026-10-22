# VisionIQ API Reference

FastAPI app `VisionIQ API`, version `2.0.0` (`backend/app/main.py`).
Local base URL: `http://127.0.0.1:8080`. The frontend calls absolute `/api/...`
paths, prefixed with `VITE_API_BASE_URL` when one is set; with none set they are
same-origin and Vite proxies them (see `docs/deployment/local.md`).

- Allowed methods (CORS): `GET, POST, DELETE, OPTIONS`
- Allowed headers (CORS): `Content-Type`, `X-Correlation-Id`, `X-VisionIQ-User`
- Every response carries `x-correlation-id` (echoes your request header, or a
  fresh 16-hex id).
- Interactive docs: `/docs` and `/openapi.json` (FastAPI defaults).

---

## Error payload shapes — read this first

There are **two** error envelopes in this codebase, because two different
mechanisms produce them.

**(a) Flat** — returned by `routes/images.py`, which builds an `ErrorResponse`
and returns it as a `JSONResponse`:

```json
{
  "success": false,
  "error": "file_too_large",
  "detail": "File exceeds the 10 MB limit (12.40 MB received)."
}
```

**(b) Nested** — returned by `routes/analyses.py` and `routes/cloud.py`, which
`raise HTTPException(detail={...})`. FastAPI serialises `detail` as-is under a
`detail` key:

```json
{
  "detail": {
    "success": false,
    "error": "not_found",
    "detail": "Analysis 'abc123' was not found."
  }
}
```

Clients should read `body.error ?? body.detail?.error`. The inner object is
identical in both cases.

**(c) Pydantic validation** — a malformed JSON body or out-of-range query
parameter is rejected by FastAPI before any handler runs, with the standard
`422 Unprocessable Entity` and a list-shaped `detail`. This is not one of the
application error codes below.

### Error code catalogue

| Code | HTTP | Raised by | Meaning |
|---|---|---|---|
| `empty_file` | 400 | `image_analyzer.analyze_image` | Uploaded file is 0 bytes. |
| `invalid_image` | 400 | `image_analyzer.analyze_image` | Bytes could not be decoded by Pillow — not a real image regardless of extension or MIME header. |
| `unsupported_format` | 400 | `image_analyzer.analyze_image`, `POST /api/uploads/presign`, `POST /api/jobs` | Decoded format is not JPEG/PNG/WEBP, or the declared/actual S3 content-type is not `image/jpeg\|png\|webp`. |
| `image_too_large` | 400 | `image_analyzer.analyze_image` | Decoded pixel count exceeds `VISIONIQ_MAX_PIXELS` (default 50,000,000). Decompression-bomb guard. |
| `file_too_large` | 413 | `routes/images.py`, `image_analyzer`, presign, create job | Bytes exceed 10 MB. On `POST /api/jobs` the offending S3 object is **deleted** first. |
| `invalid_comparison` | 400 | `GET /api/analyses/{base}/compare/{target}` | `base_id == target_id`. |
| `bad_request` | 400 | `GET /api/analyses` | `RepositoryError` — in practice a malformed or foreign pagination cursor. |
| `not_found` | 404 | get/delete/compare analysis, get/cancel/delete job | No record for this `(owner_id, analysis_id)`. Cross-tenant reads are indistinguishable from missing, by design. |
| `not_comparable` | 409 | compare | One or both analyses have no `retail` block (detection never completed). |
| `invalid_state` | 409 | `POST /api/jobs/{id}/cancel` | Job is already `completed`/`failed`/`cancelled`, or already `processing`. |
| `rate_limited` | 429 | `security.rate_limit` dependency | More than `VISIONIQ_RATE_LIMIT` (default 60) requests/minute from one client IP. |
| `forbidden` | 403 | `POST /api/jobs` | `assert_owned()` failed — the object key does not start with `{upload_prefix}{owner_id}/` (default prefix `uploads/`), or contains traversal characters. |
| `cloud_disabled` | 503 | presign, create job | `VISIONIQ_STORAGE` is not `s3`. |
| `unauthenticated` | 401 | `security.get_owner_id` | Cloud mode is on and no verified JWT `sub` claim is present. |

`rate_limit` is applied to: `POST /api/images/detect`, `GET /api/analyses`,
`POST /api/uploads/presign`, `POST /api/jobs`. It is **not** applied to
`/api/images/analyze`, the single-analysis GET/DELETE, compare, job polling, or
`/api/system/status`.

### Identity

`get_owner_id` (`backend/app/security.py`):

- **Local mode** (default): every request is owner `"local"`. No authentication.
- **Cloud mode** (`VISIONIQ_CLOUD_MODE=1`): reads
  `request.scope["aws.event"].requestContext.authorizer.jwt.claims.sub`, i.e.
  the subject an API Gateway JWT authorizer already verified. Missing → `401
  unauthenticated`. A client-supplied owner id is **never** trusted in cloud
  mode.

---

## `GET /`

Service banner.

**200**
```json
{"message": "VisionIQ Cloud AI API is running", "version": "2.0.0"}
```

---

## `GET /health`

Liveness probe. Deliberately touches neither the model nor the database.

**200**
```json
{"status": "healthy"}
```

---

## `POST /api/images/analyze`

Validate an uploaded image and return structural metadata. **No inference is
performed.** Not rate limited.

**Request:** `multipart/form-data`, field `file`.

```bash
curl -F "file=@shelf.jpg" http://127.0.0.1:8080/api/images/analyze
```

**200 — `AnalyzeResponse`**
```json
{
  "success": true,
  "message": "Image validated successfully.",
  "metadata": {
    "filename": "shelf.jpg",
    "content_type": "image/jpeg",
    "format": "JPEG",
    "width": 810,
    "height": 1080,
    "mode": "RGB",
    "aspect_ratio": 0.75,
    "size_bytes": 241763,
    "megapixels": 0.87
  }
}
```

`content_type` is derived from the **decoded pixel format**, not from the
`Content-Type` header the client sent.

**Errors (flat envelope):** `400 empty_file`, `400 invalid_image`,
`400 unsupported_format`, `400 image_too_large`, `413 file_too_large`.

---

## `POST /api/images/detect`

The full local pipeline: validate → detect → aggregate → narrate → persist.
Rate limited.

**Request:** `multipart/form-data`, field `file`.

```bash
curl -F "file=@shelf.jpg" http://127.0.0.1:8080/api/images/detect
```

**200 — `AnalysisRecord`.** Note it is `200`, not `201`, and the record is
returned even when the model is unavailable.

```json
{
  "analysis_id": "9f1c2b6a4d8e4f3b9a7c0d1e2f3a4b5c",
  "owner_id": "local",
  "created_at": "2026-10-22T09:14:02.481233+00:00",
  "status": "completed",
  "image": {
    "filename": "shelf.jpg",
    "content_type": "image/jpeg",
    "format": "JPEG",
    "width": 810,
    "height": 1080,
    "mode": "RGB",
    "aspect_ratio": 0.75,
    "size_bytes": 241763,
    "megapixels": 0.87
  },
  "image_key": "uploads/local/9f1c2b6a4d8e4f3b9a7c0d1e2f3a4b5c.jpg",
  "detection": {
    "analysis_id": "9f1c2b6a4d8e4f3b9a7c0d1e2f3a4b5c",
    "image_width": 810,
    "image_height": 1080,
    "model": {
      "provider": "yolo",
      "name": "yolov8n.pt",
      "version": "8.4.183",
      "task": "object-detection",
      "taxonomy": "COCO-80",
      "device": "cpu"
    },
    "detections": [
      {
        "id": 0,
        "label": "bottle",
        "class_id": 39,
        "confidence": 0.9183,
        "box": {
          "x1": 120.0, "y1": 340.5, "x2": 198.25, "y2": 512.0,
          "width": 78.25, "height": 171.5, "area": 13419.88
        }
      },
      {
        "id": 1,
        "label": "cup",
        "class_id": 41,
        "confidence": 0.4421,
        "box": {
          "x1": 410.0, "y1": 360.0, "x2": 470.0, "y2": 455.0,
          "width": 60.0, "height": 95.0, "area": 5700.0
        }
      }
    ],
    "detection_count": 2,
    "processing_ms": 7512.4,
    "status": "ok",
    "confidence_threshold": 0.25,
    "warnings": [
      "Generic COCO-80 model: labels are object categories, not retail SKUs."
    ]
  },
  "retail": {
    "total_detections": 2,
    "categories": [
      {"label": "bottle", "count": 1, "mean_confidence": 0.9183,
       "min_confidence": 0.9183, "max_confidence": 0.9183},
      {"label": "cup", "count": 1, "mean_confidence": 0.4421,
       "min_confidence": 0.4421, "max_confidence": 0.4421}
    ],
    "distinct_categories": 2,
    "mean_confidence": 0.6802,
    "low_confidence_count": 1,
    "occupancy": {
      "reliability": "unsupported",
      "covered_fraction": null,
      "note": "Too few detections to estimate occupancy (need at least 3)."
    },
    "shelf_gaps": {
      "reliability": "unsupported",
      "regions": [],
      "note": "Shelf-gap detection requires a planogram reference or a model trained on empty-space annotations. Not enabled in this build."
    },
    "sku": {
      "status": "unsupported",
      "matched_skus": [],
      "reason": "The active model uses a generic COCO-80 taxonomy and cannot identify individual retail SKUs. A retail fine-tuned model is required."
    },
    "caveats": [
      "Labels come from a generic COCO-80 taxonomy, not a retail product catalogue. Counts reflect detected objects, not verified stock levels.",
      "1 detection(s) fall below 50% confidence and warrant human review."
    ]
  },
  "insights": {
    "source": "rules",
    "summary": "Detected 2 objects across 2 categories. Most frequent: bottle (1).",
    "observations": [
      {"text": "1 x bottle detected (mean confidence 92%).", "source": "rules", "confidence": "informational"},
      {"text": "1 x cup detected (mean confidence 44%).", "source": "rules", "confidence": "informational"},
      {"text": "Overall mean detection confidence is 68%.", "source": "rules", "confidence": "informational"},
      {"text": "1 detection(s) are low confidence and should be visually verified.", "source": "rules", "confidence": "advisory"},
      {"text": "Product-level (SKU) identity is not available: the active model uses a generic object taxonomy.", "source": "rules", "confidence": "informational"}
    ],
    "suggested_actions": ["Manually verify the low-confidence detections."],
    "disclaimer": "Observations are derived from generic object detection and are not verified inventory data. Human review is required before acting.",
    "model_id": null,
    "token_usage": null,
    "degraded": false
  },
  "processing_ms": 7589.1,
  "error": null,
  "execution_mode": "local"
}
```

**200 with no model available.** When no detection provider can run (e.g. the
32-bit venv without torch), the request still succeeds and reports the truth:

```json
{
  "status": "completed",
  "detection": {
    "model": {"provider": "yolo", "name": "yolov8n.pt", "version": "unknown",
              "task": "object-detection", "taxonomy": "COCO-80", "device": "cpu"},
    "detections": [],
    "detection_count": 0,
    "status": "unavailable",
    "processing_ms": 3.1,
    "confidence_threshold": 0.25,
    "warnings": [
      "Detection unavailable: Ultralytics/PyTorch is not installed in this interpreter. Local inference requires 64-bit Python; see docs/deployment/local.md.",
      "Generic COCO-80 model: labels are object categories, not retail SKUs."
    ]
  },
  "retail": {
    "total_detections": 0,
    "caveats": [
      "Labels come from a generic COCO-80 taxonomy, not a retail product catalogue. Counts reflect detected objects, not verified stock levels.",
      "No detection model ran for this image; all counts are zero because nothing was analysed, not because the shelf is empty."
    ]
  },
  "insights": {
    "source": "unavailable",
    "summary": "No detection model was available for this image, so no observations can be made. The image itself was validated successfully.",
    "observations": [],
    "suggested_actions": ["Enable a detection provider to analyse shelf contents."]
  }
}
```

**This is the honesty guarantee in the wire format: zero detections with
`status: "unavailable"` never means "empty shelf", and the caveats say so.**

`status` is `failed` only when detection raised `InferenceFailed`; in that case
`error` carries the joined detection warnings.

**Errors:** `400 empty_file`, `400 invalid_image`, `400 unsupported_format`,
`400 image_too_large`, `413 file_too_large` (flat envelope);
`429 rate_limited` (nested).

A persistence failure does **not** fail the request: the record is returned with
`" (result was not saved to history)"` appended to `error`.

---

## `GET /api/analyses`

List this owner's analyses, newest first, keyset-paginated. Rate limited.

**Query parameters**

| Name | Type | Default | Constraints |
|---|---|---|---|
| `limit` | int | 20 | 1–100 |
| `cursor` | string | — | max 512 chars; opaque base64 from `next_cursor` |
| `search` | string | — | max 120 chars; SQLite matches `filename` **or** `top_labels`; DynamoDB matches `filename` only |
| `status` | enum | — | `queued\|processing\|completed\|failed\|cancelled` |

**200 — `AnalysisPage`**
```json
{
  "items": [
    {
      "analysis_id": "9f1c2b6a4d8e4f3b9a7c0d1e2f3a4b5c",
      "created_at": "2026-10-22T09:14:02.481233+00:00",
      "status": "completed",
      "filename": "shelf.jpg",
      "detection_count": 6,
      "distinct_categories": 2,
      "top_labels": ["bottle", "cup"],
      "execution_mode": "local"
    }
  ],
  "next_cursor": "MjAyNi0xMC0yMlQwOToxNDowMi40ODEyMzMrMDA6MDB8OWYxYzJiNmE=",
  "has_more": true
}
```

`top_labels` is the first three category labels by count. Pass `next_cursor`
back as `cursor` for the next page; stop when `has_more` is `false`.

> DynamoDB caveat (documented in `dynamo_repo.py`): `status`/`search` filtering
> is a `FilterExpression` applied *after* read, so a page may come back shorter
> than `limit` while `has_more` is still `true`. That is the correct keyset
> contract — keep following the cursor.

**Errors:** `400 bad_request` (invalid cursor, or a cursor belonging to another
tenant), `429 rate_limited`.

---

## `GET /api/analyses/{analysis_id}`

Retrieve one full analysis, scoped to the caller's tenant. Not rate limited.

**200** — the same `AnalysisRecord` object as `POST /api/images/detect`.

**Errors:** `404 not_found` (nested envelope). Another tenant's analysis also
returns `404`, not `403` — existence is not disclosed across tenants.

---

## `DELETE /api/analyses/{analysis_id}`

Delete the record and its stored image.

**204** — empty body.

Image cleanup is best effort: a storage delete failure is swallowed and the
record deletion still proceeds (the record is authoritative).

**Errors:** `404 not_found`.

---

## `GET /api/analyses/{base_id}/compare/{target_id}`

Diff detected category counts between two of this owner's scans.

**200 — `ComparisonResult`**
```json
{
  "base_analysis_id": "9f1c2b6a4d8e4f3b9a7c0d1e2f3a4b5c",
  "target_analysis_id": "1a2b3c4d5e6f7081920a1b2c3d4e5f60",
  "comparable": true,
  "categories": [
    {"label": "bottle", "before": 6, "after": 2, "delta": -4},
    {"label": "cup",    "before": 1, "after": 1, "delta": 0}
  ],
  "total_before": 7,
  "total_after": 3,
  "total_delta": -4,
  "notable_changes": ["bottle: 6 -> 2 (-4)"],
  "caveats": [
    "A change in detected counts can reflect lighting, angle, or occlusion differences rather than an actual change in stock.",
    "Labels come from a generic COCO-80 taxonomy, not a retail product catalogue. Counts reflect detected objects, not verified stock levels."
  ]
}
```

`categories` is sorted by `|delta|` descending then label. `notable_changes` is
capped at 10 non-zero deltas, or the single line *"No change in detected
category counts between the two scans."*

`comparable` is `false` when the two analyses used **different model names**; an
extra caveat about mismatched label spaces is prepended and the numbers are
still returned.

**Errors:** `400 invalid_comparison` (`base_id == target_id`), `404 not_found`,
`409 not_comparable` (either analysis has no `retail` block).

---

## `POST /api/uploads/presign`

Issue a short-lived, owner-scoped presigned S3 `PUT`. Rate limited.
**Requires `VISIONIQ_STORAGE=s3`.**

**Request**
```json
{
  "filename": "shelf.jpg",
  "content_type": "image/jpeg",
  "size_bytes": 241763
}
```
`filename` 1–255 chars; `size_bytes > 0`.

**200 — `PresignResponse`**
```json
{
  "analysis_id": "9f1c2b6a4d8e4f3b9a7c0d1e2f3a4b5c",
  "upload": {
    "url": "https://visioniq-images-xxxx.s3.amazonaws.com/uploads/local/9f1c...jpg?X-Amz-Algorithm=...",
    "key": "uploads/local/9f1c2b6a4d8e4f3b9a7c0d1e2f3a4b5c.jpg",
    "expires_in": 300,
    "required_headers": {
      "Content-Type": "image/jpeg",
      "x-amz-server-side-encryption": "AES256"
    },
    "max_bytes": 10485760
  }
}
```

The client must `PUT` the bytes with exactly those headers — `ContentType` and
`ServerSideEncryption` are **signed into** the URL. `max_bytes` is advisory: a
presigned PUT cannot enforce a maximum length, so the real check happens
server-side at `POST /api/jobs`.

**Errors:** `400 unsupported_format`, `413 file_too_large`, `429 rate_limited`,
`503 cloud_disabled`, `401 unauthenticated` (cloud mode).

---

## `POST /api/jobs`

Register an uploaded S3 object as an analysis job and enqueue it. Rate limited.
**Requires `VISIONIQ_STORAGE=s3`** (and `VISIONIQ_JOBS_QUEUE_URL` for the
enqueue to succeed).

**Request**
```json
{
  "analysis_id": "9f1c2b6a4d8e4f3b9a7c0d1e2f3a4b5c",
  "image_key": "uploads/local/9f1c2b6a4d8e4f3b9a7c0d1e2f3a4b5c.jpg"
}
```
`analysis_id` 8–64 chars; `image_key` 1–512 chars.

Server-side re-validation, in order, before a worker is allowed to spend money:

1. `assert_owned(image_key, owner_id)` → `403 forbidden`
2. `head_object().ContentLength > 10 MB` → **delete the object**, `413 file_too_large`
3. `head_object().ContentType` not in the allow-list → **delete the object**, `400 unsupported_format`

Full pixel-level validation happens in the worker, which has the bytes. Until
then `image.width/height/megapixels` are `0` and `mode` is `"unknown"` —
a deliberate placeholder, not a measurement.

**202 — `AnalysisRecord`**
```json
{
  "analysis_id": "9f1c2b6a4d8e4f3b9a7c0d1e2f3a4b5c",
  "owner_id": "local",
  "created_at": "2026-10-22T09:14:02.481233+00:00",
  "status": "queued",
  "image": {
    "filename": "9f1c2b6a4d8e4f3b9a7c0d1e2f3a4b5c.jpg",
    "content_type": "image/jpeg",
    "format": "JPEG",
    "width": 0, "height": 0, "mode": "unknown",
    "aspect_ratio": 0.0, "size_bytes": 241763, "megapixels": 0.0
  },
  "image_key": "uploads/local/9f1c2b6a4d8e4f3b9a7c0d1e2f3a4b5c.jpg",
  "detection": null,
  "retail": null,
  "insights": null,
  "processing_ms": null,
  "error": null,
  "execution_mode": "cloud"
}
```

**Idempotent.** If a record already exists for `(owner_id, analysis_id)` it is
returned untouched and nothing is re-enqueued.

**Errors:** `400 unsupported_format`, `403 forbidden`, `413 file_too_large`,
`429 rate_limited`, `503 cloud_disabled`, `401 unauthenticated`.

---

## `GET /api/jobs/{analysis_id}`

Poll job status. Not rate limited. Returns the full `AnalysisRecord`; once
`status` is `completed` the `detection`, `retail` and `insights` blocks are
populated exactly as in the synchronous response.

Poll until `status` ∈ `{completed, failed, cancelled}`.

**Errors:** `404 not_found`.

---

## `POST /api/jobs/{analysis_id}/cancel`

Cancel a job a worker has not yet claimed. Empty body. Not rate limited.

**200 — `AnalysisRecord`** with `status: "cancelled"`.

**Errors:**
- `404 not_found`
- `409 invalid_state` — `"Job is already completed and cannot be cancelled."`
  (likewise `failed`/`cancelled`), or
  `"Job is already being processed and cannot be cancelled."`

---

# Cloud control plane — API Gateway + Lambda

Everything above describes the **FastAPI** application. When VisionIQ is
deployed, the small, I/O-bound control-plane routes are served instead by six
Lambda functions behind an API Gateway HTTP API
(`infrastructure/terraform/lambda/api/handler.py`), each route carrying the
same Cognito JWT authorizer. Inference is *not* here — it runs on Fargate.

> **Nothing has been deployed.** The Lambda has never executed against real
> AWS. What follows is read from the source and from
> `backend/tests/test_cloud_contracts.py` (62 tests), which imports the handler
> with boto3 mocked.

| Method | Route | Handler |
|---|---|---|
| `POST` | `/api/uploads/presign` | `handler.presign` |
| `POST` | `/api/jobs` | `handler.create_job` |
| `GET` | `/api/jobs/{id}` | `handler.get_job` |
| `GET` | `/api/jobs` | `handler.list_jobs` |
| `POST` | `/api/jobs/{id}/cancel` | `handler.cancel_job` |
| `DELETE` | `/api/jobs/{id}` | `handler.delete_job` |

## The canonical contract

**FastAPI's successful response schemas are the contract.** The Lambda returns
the same shapes for equivalent resources, so a client parses one format no
matter which backend answers. There is no `body.analysis ?? body` branching and
no `{"success": true, …}` wrapper on success.

Two projection helpers in `handler.py` enforce it:

| Helper | Returns | Notes |
|---|---|---|
| `_record(item)` | bare `AnalysisRecord` | Just `item["payload"]`. The DynamoDB attributes around it (`payload`, `expires_at`) are storage internals and never reach the wire. `owner_id` *does* appear — it is a field of `AnalysisRecord`. |
| `_summary(item)` | bare `AnalysisSummary` | Built from the item's promoted attributes, which is why listing needs no second lookup. `_SUMMARY_FIELDS` matches `AnalysisSummary.model_fields` exactly; missing values from older writes get the Pydantic defaults (`top_labels: []`, `execution_mode: "cloud"`, counts `0`). |

| Endpoint | Canonical response |
|---|---|
| `POST /api/uploads/presign` | `200` `PresignResponse` — `{analysis_id, upload{…}}` |
| `POST /api/jobs` | `202` bare `AnalysisRecord` |
| `GET /api/jobs/{id}` | `200` bare `AnalysisRecord` |
| `GET /api/jobs` | `200` bare `AnalysisPage` — `{items, next_cursor, has_more}` |
| `POST /api/jobs/{id}/cancel` | `200` bare `AnalysisRecord` |
| `DELETE /api/jobs/{id}` | `204`, **no body** |

### What did *not* change

- **The error envelope is unchanged.** It already matched the FastAPI flat
  shape (a) above and was deliberately left as
  `{"success": false, "error": "<code>", "detail": "…"}`. Errors are the one
  place `success` still appears.
- **`204` is bodiless.** RFC 9110 forbids a body on `204`, and some clients and
  proxies mishandle one. `DELETE /api/jobs/{id}` and
  `DELETE /api/analyses/{id}` both return the status bare.

## Response envelope

Every Lambda response with a body is JSON with these headers:

```
content-type: application/json
x-content-type-options: nosniff
cache-control: no-store
```

A `204` carries `x-content-type-options` and `cache-control` but no
`content-type` and no body.

Errors use one flat envelope, matching shape (a) above:

```json
{ "success": false, "error": "invalid_state", "detail": "a job in state 'processing' cannot be cancelled" }
```

### Error code catalogue (Lambda)

| Code | HTTP | Raised by | Meaning |
|---|---|---|---|
| `unauthenticated` | 401 | every handler | No non-empty `sub` in `requestContext.authorizer.jwt.claims`. Identity is read from **nowhere else** — not the body, the query string or a header. |
| `not_found` | 404 | `create_job`, `get_job`, `cancel_job`, `delete_job` | No record (or no S3 object, on create). Byte-identical for a missing record and another tenant's record, so existence never leaks. |
| `invalid_request` | 400 | `create_job`, `get_job`, `list_jobs`, `cancel_job`, `delete_job` | Missing `analysis_id`/`object_key`, a malformed `analysis_id`, a non-integer or out-of-range `limit`, a missing path `id`, a bad `size_bytes`, or an undecodable/foreign pagination cursor. |
| `forbidden` | 403 | `create_job` | `object_key` is outside `{UPLOAD_PREFIX}{owner_id}/`, or contains `..`, a leading `/`, or a backslash. |
| `unsupported_format` | 400 | `presign`, `create_job` | Declared or actual content type is not `image/jpeg`, `image/png` or `image/webp`. On create the offending object is **deleted** first. |
| `file_too_large` | 413 | `presign`, `create_job` | Over `MAX_UPLOAD_BYTES` (default 10 MiB). On create, measured server-side with `head_object` and the object is **deleted** first. |
| `empty_file` | 400 | `create_job` | `head_object` reports `ContentLength == 0`. The object is **deleted** first. |
| `invalid_state` | 409 | `cancel_job` | The record exists but is not `queued` — a claimed or terminal job cannot be cancelled. |
| `storage_unavailable` | 503 | `presign`, `create_job`, `get_job`/`list_jobs`, `cancel_job`, `delete_job` | A boto3 `ClientError` from S3 or DynamoDB. Returned instead of letting the exception become a stack trace in a 502. |
| `queue_unavailable` | 503 | `create_job` | `sqs.send_message` failed. The record is marked `failed` first, so the client is not left polling a job no worker will ever claim. |

## `POST /api/uploads/presign` (Lambda)

Body: `{"content_type": "image/jpeg", "size_bytes": 241763}`. `size_bytes` is
advisory — a presigned PUT cannot enforce a length — and is only used to refuse
an obviously oversized upload before paying for the transfer.

**200 — `PresignResponse`.** The `upload` object mirrors
`backend/app/storage/s3_storage.py::presign_put` field for field.

```json
{
  "analysis_id": "9f1c2b6a4d8e4f3b9a7c0d1e2f3a4b5c",
  "upload": {
    "url": "https://visioniq-images-xxxx.s3.amazonaws.com/uploads/<sub>/9f1c…jpg?X-Amz-Algorithm=…",
    "key": "uploads/<sub>/9f1c2b6a4d8e4f3b9a7c0d1e2f3a4b5c.jpg",
    "expires_in": 900,
    "required_headers": {
      "Content-Type": "image/jpeg",
      "x-amz-server-side-encryption": "AES256"
    },
    "max_bytes": 10485760
  }
}
```

`Content-Type` and `x-amz-server-side-encryption: AES256` are **signed into**
the URL; a PUT without exactly those headers is rejected by S3.

> `expires_in` is `PRESIGN_EXPIRY_SECONDS` (Lambda default **900**), whereas
> the FastAPI side uses `VISIONIQ_PRESIGN_TTL` (default **300**). The *shape*
> is the contract; the TTL is configuration and the two defaults differ.

> **Send no `Authorization` header on the PUT.** The signature in the URL is
> the credential. A bearer token would leak it to the storage endpoint, and any
> unsigned header breaks the signature anyway.

## `POST /api/jobs` (Lambda)

Body: `{"analysis_id": "…", "object_key": "…"}` — `image_key` is accepted as an
alias. Checks run in this order:

1. `analysis_id` matches `^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$` → else `400 invalid_request`
2. `object_key` is inside the caller's prefix → else `403 forbidden`
3. `head_object` — object missing → `404 not_found`; over the limit → delete + `413 file_too_large`; zero bytes → delete + `400 empty_file`; wrong content type → delete + `400 unsupported_format`
4. `put_item` with `ConditionExpression="attribute_not_exists(analysis_id)"`
5. `sqs.send_message` with `{analysis_id, owner_id, image_key}`

**202 — bare `AnalysisRecord`**, the same object `POST /api/jobs` returns on
the FastAPI side:

```json
{
  "analysis_id": "9f1c2b6a4d8e4f3b9a7c0d1e2f3a4b5c",
  "owner_id": "8f3a1c20-5b7e-4a61-9d2f-0c4e6a8b1d33",
  "created_at": "2026-10-22T09:14:02.481233+00:00",
  "status": "queued",
  "image": {
    "filename": "9f1c2b6a4d8e4f3b9a7c0d1e2f3a4b5c.jpg",
    "content_type": "image/jpeg",
    "format": "JPEG",
    "width": 0, "height": 0, "mode": "unknown",
    "aspect_ratio": 0, "size_bytes": 0, "megapixels": 0
  },
  "image_key": "uploads/8f3a1c20-5b7e-4a61-9d2f-0c4e6a8b1d33/9f1c2b6a4d8e4f3b9a7c0d1e2f3a4b5c.jpg",
  "detection": null,
  "retail": null,
  "insights": null,
  "processing_ms": null,
  "error": null,
  "execution_mode": "cloud"
}
```

The image numbers are **integers, never floats** (`0`, not `0.0`) because
DynamoDB rejects `float`, and they are placeholders until the worker decodes
the bytes — not measurements.

**Idempotent.** A retried create for the same `analysis_id` fails the condition
expression, and the handler returns the **existing** record with `202` rather
than enqueuing a second time.

The item written carries promoted query attributes *plus* a `payload`
attribute holding the full `AnalysisRecord` JSON — see
[`CLAUDE.md`](../../CLAUDE.md) § Cross-component contracts. Image dimensions are
integer placeholders (`0`, never `0.0`; DynamoDB rejects `float`) until the
worker decodes the bytes.

## `GET /api/jobs/{id}` (Lambda)

A single `get_item` on `(owner_id, analysis_id)`.

**200 — bare `AnalysisRecord`**, identical in shape to the `202` above and to
`GET /api/analyses/{id}` on the FastAPI side. Once `status` is `completed` the
`detection`, `retail` and `insights` blocks are populated exactly as in the
synchronous local response — the worker writes the record through the same
`analysis_service.analyse()` path.

This is the endpoint clients poll. See
[Local vs cloud](#local-vs-cloud-same-shapes-different-choreography) for the
polling rules.

**404 `not_found`** — byte-identical for a missing record and another tenant's
record.

## `GET /api/jobs` (Lambda) — keyset pagination

Queries the `owner_created_index` GSI with `ScanIndexForward=false`
(newest-first), partitioned on the caller's `sub`.

| Query parameter | Default | Notes |
|---|---|---|
| `limit` | `25` | Integer 1–100. Non-numeric → `400 invalid_request` (previously a 500). |
| `cursor` | — | Opaque base64 cursor from a previous `next_cursor`. |
| `status` | — | Server-side `FilterExpression` on `status`. |

**200 — bare `AnalysisPage`.** Items are projected to `AnalysisSummary`, so the
response carries no storage internals (`owner_id`, `expires_at`) and no heavy
`payload`. `count` is gone: it was always `len(items)`.

```json
{
  "items": [
    {
      "analysis_id": "9f1c2b6a4d8e4f3b9a7c0d1e2f3a4b5c",
      "created_at": "2026-10-22T09:14:02.481233+00:00",
      "status": "completed",
      "filename": "9f1c2b6a4d8e4f3b9a7c0d1e2f3a4b5c.jpg",
      "detection_count": 6,
      "distinct_categories": 2,
      "top_labels": ["bottle", "cup"],
      "execution_mode": "cloud"
    }
  ],
  "next_cursor": "eyJhbmFseXNpc19pZCI6…",
  "has_more": true
}
```

This is byte-for-byte the shape of `GET /api/analyses` on the FastAPI side, so
history rendering is shared code.

The cursor is `base64url(json(LastEvaluatedKey))` with sorted keys — the same
format `backend/app/repositories/dynamo_repo.py` produces, so a cursor from
either implementation is usable by the other. **A cursor whose `owner_id` is
not the caller's is rejected with `400 invalid_request`**, so a cursor cannot
be forged into another tenant's partition.

Because `status` filters *after* the read, a page may come back shorter than
`limit` while `has_more` is still `true`. That is the correct keyset contract:
stop when `has_more` is `false`, not when a page is short.

## `POST /api/jobs/{id}/cancel` (Lambda)

A conditional `update_item`:

```
ConditionExpression = "attribute_exists(analysis_id) AND #s = :queued"
UpdateExpression    = "SET #s = :cancelled, payload.#s = :cancelled"
```

Both the promoted `status` attribute and `payload.status` are updated together,
so the item stays self-consistent for the repository that reads `payload`.

`ReturnValues="ALL_NEW"` gives back the updated item, which `_record()` then
projects.

- **200** — bare `AnalysisRecord` with `status: "cancelled"`
- **404 `not_found`** — no such record for this owner
- **409 `invalid_state`** — the record exists but is not `queued`; the detail
  names the current state. Once a worker has claimed a job, cancelling it would
  make the record lie about reality.

## `DELETE /api/jobs/{id}` (Lambda)

Reads the record first (so a cross-tenant delete is an indistinguishable
`404`), deletes the uploaded image **best-effort** — only if
`payload.image_key` still passes the ownership guard, and an S3 failure is
logged rather than raised — then deletes the DynamoDB item.

- **204** — no body, matching `DELETE /api/analyses/{id}` on the FastAPI side
  (RFC 9110 forbids a body on 204)
- **404 `not_found`**, **503 `storage_unavailable`**

This is why the Lambda role gained `s3:DeleteObject` (scoped to
`${bucket_arn}/${upload_prefix}*`, never bucket-wide and never the results
prefix) and `dynamodb:DeleteItem` in
`infrastructure/terraform/modules/security/main.tf`.

---

# Local vs cloud: same shapes, different choreography

Because the two backends return identical shapes, the only thing a client has
to branch on is **how many steps an analysis takes**. Never on parsing.

The SPA expresses this as one `AnalysisClient` interface with two
implementations (`frontend/src/api/analysisClient.ts`), selected by
`VITE_API_MODE`.

## Local — one synchronous call

```
Browser                         FastAPI
   │                               │
   │  POST /api/images/detect      │
   │  multipart/form-data: file    │
   │──────────────────────────────▶│ validate → detect → aggregate
   │                               │ → narrate → persist   (seconds)
   │  200  AnalysisRecord          │
   │◀──────────────────────────────│ status: "completed"
```

One request. The record comes back finished; there is nothing to poll.
Progress stages reported to the UI: `uploading` → `processing` → `done`.

## Cloud — presign, PUT, create, poll

```
Browser                 API Gateway + Lambda              S3            SQS/Fargate
   │                              │                        │                 │
   │ 1. POST /api/uploads/presign │                        │                 │
   │─────────────────────────────▶│ generate_presigned_url │                 │
   │   200 PresignResponse        │                        │                 │
   │◀─────────────────────────────│                        │                 │
   │                              │                        │                 │
   │ 2. PUT <presigned url>  — direct, NOT through the API │                 │
   │   only the signed headers; NO Authorization header    │                 │
   │──────────────────────────────────────────────────────▶│                 │
   │                              │                        │                 │
   │ 3. POST /api/jobs            │ head_object verify     │                 │
   │   {analysis_id, image_key}   │ → DynamoDB(queued)     │                 │
   │─────────────────────────────▶│ → SQS send_message ────┼────────────────▶│
   │   202 AnalysisRecord (queued)│                        │        worker runs
   │◀─────────────────────────────│                        │        inference
   │                              │                        │                 │
   │ 4. GET /api/jobs/{id}  ◀── repeat every 2 s ──▶       │   DynamoDB(completed)
   │─────────────────────────────▶│                        │◀────────────────│
   │   200 AnalysisRecord         │                        │                 │
   │◀─────────────────────────────│  until status is terminal                │
```

Progress stages reported to the UI: `uploading` → `queued` → `processing` →
`done`.

### Step 2 carries no `Authorization` header

The presigned signature **is** the credential. Sending a bearer token to the S3
endpoint would leak an API credential to a different service for no benefit,
and an unsigned header breaks the signature in any case. `putToS3` sends
exactly the `required_headers` from the presign response and nothing else.
`frontend/src/api/analysisClient.test.ts` asserts it.

### Fails closed when unauthenticated

Cloud mode checks for an access token **before** step 1 and throws
`unauthenticated` ("You are not signed in. Please sign in and try again.")
rather than letting the gateway return a confusing `401` three steps later.

## Polling rules

| Rule | Value | Where |
|---|---|---|
| Interval | `VITE_JOB_POLL_INTERVAL_MS`, default **2000 ms** | `api/config.ts` |
| Timeout | `VITE_JOB_POLL_TIMEOUT_MS`, default **300000 ms** (5 min) | `api/config.ts` |
| Terminal states | `completed`, `failed`, `cancelled` | `TERMINAL_STATUSES` |
| Already terminal on create | **No polling at all** — the `202` record is returned as-is | `analyze()` |
| Transient failure retry | up to **5** consecutive failures, then the error propagates | `pollUntilTerminal` |
| Never retried | `401`, `403`, `404` — a definitive answer, not a blip | `pollUntilTerminal` |
| Cancellation | any `AbortSignal` abort rejects with code `aborted`, at any step | `analyze`, `putToS3`, `sleep` |

The retry counter resets on every successful poll, so five scattered blips over
a long job are tolerated; five in a row are not.

**A poll timeout is not a failure of the job.** The client stops watching and
reports *"The analysis is taking longer than expected. It may still finish —
check the scan history shortly."* It does **not** call the cancel route, and
the Fargate worker carries on. The finished record appears in
`GET /api/jobs` (or `GET /api/analyses`) when the worker is done. To actually
stop a job, call `POST /api/jobs/{id}/cancel` — and that only works while the
job is still `queued`.

## Transport configuration

| Variable | Default | Effect |
|---|---|---|
| `VITE_API_MODE` | `local` | `local` or `cloud`. **Any unrecognised value falls back to `local`** |
| `VITE_API_BASE_URL` | `''` | Origin to prefix `/api` paths with. Empty means same-origin (the Vite dev proxy). Trailing slashes are stripped, because `//api/...` 404s on some gateways |
| `VITE_JOB_POLL_INTERVAL_MS` | `2000` | Non-numeric or non-positive values fall back to the default |
| `VITE_JOB_POLL_TIMEOUT_MS` | `300000` | Same fallback rule |

Reading history is identical in both modes, so it is not duplicated in the
analysis client: `client.ts` handles it and the base URL makes it work against
either backend.

---

# FastAPI application (continued)

## `GET /api/system/status`

Execution mode and model availability, for the dashboard. Not rate limited.

**Note:** this endpoint calls `provider.warmup()`. The **first** call therefore
pays the full model load (~18 s cold on this machine, including the weight
download — see `docs/architecture/models.md`). Subsequent calls are cheap.

**200**
```json
{
  "execution_mode": "local",
  "storage_backend": "local",
  "repository_backend": "sqlite",
  "insights_provider": "rules",
  "model": {
    "provider": "yolo",
    "name": "yolov8n.pt",
    "version": "8.4.183",
    "task": "object-detection",
    "taxonomy": "COCO-80",
    "device": "cpu"
  },
  "model_available": true,
  "model_unavailable_reason": null,
  "confidence_threshold": 0.25,
  "max_upload_bytes": 10485760,
  "supported_statuses": ["queued", "processing", "completed", "failed", "cancelled"]
}
```

When the provider cannot load:

```json
{
  "model_available": false,
  "model_unavailable_reason": "Ultralytics/PyTorch is not installed in this interpreter. Local inference requires 64-bit Python; see docs/deployment/local.md."
}
```

This endpoint has no error codes of its own; a provider failure is reported in
the body, not as an HTTP error.

---

## Enumerations

| Enum | Values |
|---|---|
| `JobStatus` | `queued`, `processing`, `completed`, `failed`, `cancelled` |
| `InferenceStatus` | `ok`, `unavailable`, `empty`, `failed`, `timeout` |
| `Reliability` | `measured`, `estimated`, `unsupported` |
| `SkuStatus` | `unsupported`, `unknown`, `matched` |
| `InsightSource` | `rules`, `bedrock`, `unavailable` |
| `Insight.confidence` | `informational`, `advisory` (free-form string field) |
| Accepted formats | `JPEG` → `image/jpeg`, `PNG` → `image/png`, `WEBP` → `image/webp` |
