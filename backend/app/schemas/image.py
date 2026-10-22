"""Pydantic schemas for the image analysis API."""

from pydantic import BaseModel, Field


class ImageMetadata(BaseModel):
    """Structural metadata extracted from a verified image."""

    filename: str
    content_type: str = Field(description="Canonical MIME type detected from pixels.")
    format: str = Field(description="Pillow format name, e.g. JPEG, PNG, WEBP.")
    width: int
    height: int
    mode: str = Field(description="Pillow color mode, e.g. RGB, RGBA.")
    aspect_ratio: float
    size_bytes: int
    megapixels: float


class AnalyzeResponse(BaseModel):
    """Successful response for POST /api/images/analyze."""

    success: bool = True
    message: str = "Image validated successfully."
    metadata: ImageMetadata


class ErrorResponse(BaseModel):
    """Structured error payload returned for rejected uploads."""

    success: bool = False
    error: str
    detail: str
