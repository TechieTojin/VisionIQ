"""Application configuration for VisionIQ.

All tunables are environment-driven so the same image runs locally and in the
cloud. Nothing here may contain secrets or account identifiers.
"""

import os
from functools import lru_cache
from pathlib import Path

# --------------------------------------------------------------------------
# Phase 1 constants (unchanged behaviour)
# --------------------------------------------------------------------------

MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_UPLOAD_LABEL = "10 MB"

ALLOWED_FORMATS = {
    "JPEG": "image/jpeg",
    "PNG": "image/png",
    "WEBP": "image/webp",
}

CORS_ORIGINS = [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
    "http://127.0.0.1:5175",
]


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


BACKEND_ROOT = Path(__file__).resolve().parent.parent


class Settings:
    """Runtime settings resolved from the environment.

    Read once via `get_settings()`; tests may clear the cache to override.
    """

    def __init__(self) -> None:
        # -- Vision -----------------------------------------------------
        # Provider: "yolo" (local CPU), "sagemaker" (cloud), "null" (disabled).
        self.detection_provider: str = os.getenv("VISIONIQ_DETECTION_PROVIDER", "yolo")
        self.model_id: str = os.getenv("VISIONIQ_MODEL_ID", "yolov8n.pt")
        self.confidence_threshold: float = _env_float("VISIONIQ_CONFIDENCE", 0.25)
        self.max_detections: int = _env_int("VISIONIQ_MAX_DETECTIONS", 300)
        self.inference_timeout_s: float = _env_float("VISIONIQ_INFERENCE_TIMEOUT", 60.0)
        self.device: str = os.getenv("VISIONIQ_DEVICE", "cpu")
        self.inference_image_size: int = _env_int("VISIONIQ_IMAGE_SIZE", 640)
        # Guard against decompression bombs: cap decoded pixels (default 50 MP).
        self.max_pixels: int = _env_int("VISIONIQ_MAX_PIXELS", 50_000_000)
        # Weights cache directory (never committed).
        self.model_cache_dir: Path = Path(
            os.getenv("VISIONIQ_MODEL_DIR", str(BACKEND_ROOT / "models"))
        )
        self.sagemaker_endpoint: str = os.getenv("VISIONIQ_SAGEMAKER_ENDPOINT", "")

        # -- Persistence -------------------------------------------------
        # "sqlite" (local dev) or "dynamodb" (cloud).
        self.repository_backend: str = os.getenv("VISIONIQ_REPOSITORY", "sqlite")
        self.sqlite_path: Path = Path(
            os.getenv("VISIONIQ_SQLITE_PATH", str(BACKEND_ROOT / "data" / "visioniq.db"))
        )
        self.dynamodb_table: str = os.getenv("VISIONIQ_DYNAMODB_TABLE", "")

        # -- Storage -----------------------------------------------------
        # "local" (filesystem) or "s3".
        self.storage_backend: str = os.getenv("VISIONIQ_STORAGE", "local")
        self.local_storage_dir: Path = Path(
            os.getenv("VISIONIQ_STORAGE_DIR", str(BACKEND_ROOT / "data" / "images"))
        )
        self.s3_bucket: str = os.getenv("VISIONIQ_S3_BUCKET", "")
        self.presign_ttl_s: int = _env_int("VISIONIQ_PRESIGN_TTL", 300)
        # Key prefix for uploaded images. This is a CROSS-COMPONENT CONTRACT:
        # the Lambda API writes keys under it, the Fargate worker reads them,
        # and the worker's IAM policy grants s3:GetObject on
        # "<bucket>/uploads/*" only. Changing it requires changing the
        # Terraform variable `upload_prefix` in lockstep.
        prefix = os.getenv("VISIONIQ_UPLOAD_PREFIX", "uploads/")
        self.upload_prefix: str = (
            prefix if not prefix or prefix.endswith("/") else f"{prefix}/"
        )

        # -- Insights ----------------------------------------------------
        # "rules" (deterministic, default) or "bedrock".
        self.insights_provider: str = os.getenv("VISIONIQ_INSIGHTS_PROVIDER", "rules")
        self.bedrock_model_id: str = os.getenv("VISIONIQ_BEDROCK_MODEL_ID", "")
        self.bedrock_timeout_s: float = _env_float("VISIONIQ_BEDROCK_TIMEOUT", 20.0)
        self.bedrock_max_tokens: int = _env_int("VISIONIQ_BEDROCK_MAX_TOKENS", 600)

        # -- Authentication -----------------------------------------------
        # none       : local dev, single pseudo-tenant, no auth (default)
        # apigateway : API Gateway's JWT authorizer already verified the token;
        #              read the verified claims it passes through
        # jwt        : this process verifies the token itself (JWKS + RS256),
        #              for when FastAPI is directly exposed
        self.auth_mode: str = os.getenv("VISIONIQ_AUTH_MODE", "none")
        # Cognito issuer, e.g.
        # https://cognito-idp.<region>.amazonaws.com/<user-pool-id>
        self.jwt_issuer: str = os.getenv("VISIONIQ_JWT_ISSUER", "")
        # Cognito app client id. Checked against `aud` (id tokens) or
        # `client_id` (access tokens).
        self.jwt_audience: str = os.getenv("VISIONIQ_JWT_AUDIENCE", "")
        # Defaults to <issuer>/.well-known/jwks.json when unset.
        self.jwks_url: str = os.getenv("VISIONIQ_JWKS_URL", "")
        # Clock-skew tolerance in seconds. Keep small.
        self.jwt_leeway_s: int = _env_int("VISIONIQ_JWT_LEEWAY", 30)
        # Which Cognito token type to accept: "access" or "id".
        self.jwt_token_use: str = os.getenv("VISIONIQ_JWT_TOKEN_USE", "access")
        self.jwks_cache_ttl_s: int = _env_int("VISIONIQ_JWKS_CACHE_TTL", 3600)

        # -- Cloud / jobs -------------------------------------------------
        self.aws_region: str = os.getenv("AWS_REGION", "us-east-1")
        self.jobs_queue_url: str = os.getenv("VISIONIQ_JOBS_QUEUE_URL", "")
        self.cloud_mode: bool = _env_bool("VISIONIQ_CLOUD_MODE", False)

        # -- Workbench (local ML engineering features) --------------------
        # Annotations, datasets, alerts, benchmark/evaluation/training runs.
        # Local SQLite only: these features are not part of the cloud API.
        self.workbench_db_path: Path = Path(
            os.getenv("VISIONIQ_WORKBENCH_DB", str(BACKEND_ROOT / "data" / "workbench.db"))
        )
        # Dataset blobs, exports and training runs live under this root.
        self.workbench_dir: Path = Path(
            os.getenv("VISIONIQ_WORKBENCH_DIR", str(BACKEND_ROOT / "data" / "workbench"))
        )
        # Module executed (with `python -m`) for training. Environment only —
        # never selectable through the API.
        self.train_worker_module: str = os.getenv(
            "VISIONIQ_TRAIN_WORKER_MODULE", "app.workbench.train_worker"
        )

        # -- Misc ---------------------------------------------------------
        self.log_level: str = os.getenv("VISIONIQ_LOG_LEVEL", "INFO")
        self.rate_limit_per_minute: int = _env_int("VISIONIQ_RATE_LIMIT", 60)
        extra_origins = os.getenv("VISIONIQ_CORS_ORIGINS", "")
        self.cors_origins: list[str] = (
            [o.strip() for o in extra_origins.split(",") if o.strip()]
            if extra_origins
            else list(CORS_ORIGINS)
        )

    @property
    def effective_jwks_url(self) -> str:
        """JWKS endpoint, derived from the issuer unless overridden."""
        if self.jwks_url:
            return self.jwks_url
        if self.jwt_issuer:
            return f"{self.jwt_issuer.rstrip('/')}/.well-known/jwks.json"
        return ""

    @property
    def auth_enabled(self) -> bool:
        return (self.auth_mode or "none").lower() != "none"

    @property
    def execution_mode(self) -> str:
        """Human-readable indicator surfaced to the dashboard."""
        return "cloud" if self.cloud_mode else "local"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
