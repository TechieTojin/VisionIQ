"""Private S3 image storage with presigned direct uploads.

The bucket is never public. Clients receive short-lived presigned PUT URLs
constrained to a specific key, content-type and size, and the backend
re-validates the object server-side before any processing.
"""

from __future__ import annotations

from app.storage.base import StorageError


class S3ImageStorage:
    """S3-backed image storage."""

    def __init__(self, bucket: str, region: str, presign_ttl_s: int = 300) -> None:
        if not bucket:
            raise ValueError("VISIONIQ_S3_BUCKET must be set for S3 storage.")
        self.bucket = bucket
        self.region = region
        self.presign_ttl_s = presign_ttl_s
        self._client = None

    def _c(self):
        if self._client is None:
            import boto3

            self._client = boto3.client("s3", region_name=self.region)
        return self._client

    def put(self, key: str, data: bytes, content_type: str) -> str:
        try:
            self._c().put_object(
                Bucket=self.bucket,
                Key=key,
                Body=data,
                ContentType=content_type,
                ServerSideEncryption="AES256",
            )
        except Exception as exc:
            raise StorageError(f"S3 put failed for '{key}': {exc}") from exc
        return key

    def get(self, key: str) -> bytes:
        try:
            obj = self._c().get_object(Bucket=self.bucket, Key=key)
            return obj["Body"].read()
        except Exception as exc:
            raise StorageError(f"S3 get failed for '{key}': {exc}") from exc

    def delete(self, key: str) -> None:
        try:
            self._c().delete_object(Bucket=self.bucket, Key=key)
        except Exception as exc:
            raise StorageError(f"S3 delete failed for '{key}': {exc}") from exc

    def exists(self, key: str) -> bool:
        try:
            self._c().head_object(Bucket=self.bucket, Key=key)
            return True
        except Exception:
            return False

    # -- Presigned upload flow -------------------------------------------

    def presign_put(self, key: str, content_type: str, max_bytes: int) -> dict:
        """Create a short-lived, tightly-scoped upload URL.

        `ContentType` is signed in, so the client cannot upload a different
        type than it declared. Size is additionally enforced server-side on
        `head_object` before processing, because a presigned PUT URL alone
        cannot enforce a maximum length.
        """
        try:
            url = self._c().generate_presigned_url(
                ClientMethod="put_object",
                Params={
                    "Bucket": self.bucket,
                    "Key": key,
                    "ContentType": content_type,
                    "ServerSideEncryption": "AES256",
                },
                ExpiresIn=self.presign_ttl_s,
            )
        except Exception as exc:
            raise StorageError(f"Could not presign upload for '{key}': {exc}") from exc

        return {
            "url": url,
            "key": key,
            "expires_in": self.presign_ttl_s,
            "required_headers": {
                "Content-Type": content_type,
                "x-amz-server-side-encryption": "AES256",
            },
            "max_bytes": max_bytes,
        }

    def head(self, key: str) -> dict:
        """Server-side verification of a client-uploaded object."""
        try:
            meta = self._c().head_object(Bucket=self.bucket, Key=key)
        except Exception as exc:
            raise StorageError(f"Uploaded object '{key}' not found: {exc}") from exc
        return {
            "size_bytes": meta.get("ContentLength", 0),
            "content_type": meta.get("ContentType", ""),
            "etag": meta.get("ETag", "").strip('"'),
        }
