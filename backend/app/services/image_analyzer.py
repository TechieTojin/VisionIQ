"""Image validation and metadata extraction built on Pillow.

This service performs real content verification: it decodes the uploaded
bytes with Pillow and reads structural properties from the pixels. It does
NOT fabricate object detections or inventory insights — that is Phase 2+.
"""

import io

from PIL import Image, UnidentifiedImageError

from app.config import ALLOWED_FORMATS, MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, get_settings
from app.schemas.image import ImageMetadata


class ImageValidationError(Exception):
    """Raised when an upload fails validation. Carries a client-safe message."""

    def __init__(self, error: str, detail: str):
        self.error = error
        self.detail = detail
        super().__init__(detail)


def analyze_image(filename: str, data: bytes) -> ImageMetadata:
    """Validate raw image bytes and return structural metadata.

    Raises ImageValidationError on empty input, oversized files, unsupported
    formats, or bytes that are not a decodable image.
    """
    size_bytes = len(data)

    if size_bytes == 0:
        raise ImageValidationError(
            "empty_file", "The uploaded file is empty."
        )

    if size_bytes > MAX_UPLOAD_BYTES:
        raise ImageValidationError(
            "file_too_large",
            f"File exceeds the {MAX_UPLOAD_LABEL} limit "
            f"({size_bytes / (1024 * 1024):.2f} MB received).",
        )

    # Decode to confirm the bytes are a genuine image, not just a matching
    # extension or MIME header.
    try:
        with Image.open(io.BytesIO(data)) as img:
            img.verify()  # cheap integrity check
        # verify() leaves the image unusable; reopen to read properties.
        with Image.open(io.BytesIO(data)) as img:
            fmt = img.format or ""
            width, height = img.size
            mode = img.mode
    except (UnidentifiedImageError, OSError, ValueError):
        raise ImageValidationError(
            "invalid_image",
            "The file could not be read as a valid image.",
        )

    # Reject decompression bombs: a small file can decode to gigapixels.
    max_pixels = get_settings().max_pixels
    if width * height > max_pixels:
        raise ImageValidationError(
            "image_too_large",
            f"Image resolution {width}x{height} exceeds the "
            f"{max_pixels:,} pixel processing limit.",
        )

    if fmt not in ALLOWED_FORMATS:
        supported = ", ".join(sorted(ALLOWED_FORMATS))
        raise ImageValidationError(
            "unsupported_format",
            f"Unsupported image format '{fmt or 'unknown'}'. "
            f"Supported formats: {supported}.",
        )

    aspect_ratio = round(width / height, 4) if height else 0.0
    megapixels = round((width * height) / 1_000_000, 2)

    return ImageMetadata(
        filename=filename,
        content_type=ALLOWED_FORMATS[fmt],
        format=fmt,
        width=width,
        height=height,
        mode=mode,
        aspect_ratio=aspect_ratio,
        size_bytes=size_bytes,
        megapixels=megapixels,
    )
