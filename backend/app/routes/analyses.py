"""Analysis history: list, retrieve, delete, compare."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse

from app.repositories import get_repository
from app.repositories.base import AnalysisNotFound, RepositoryError
from app.schemas.analysis import AnalysisPage, AnalysisRecord, JobStatus
from app.schemas.image import ErrorResponse
from app.schemas.retail import ComparisonResult
from app.security import get_owner_id, rate_limit
from app.services.retail import intelligence

router = APIRouter(prefix="/api/analyses", tags=["analyses"])


def _not_found(analysis_id: str) -> HTTPException:
    return HTTPException(
        status_code=404,
        detail={
            "success": False,
            "error": "not_found",
            "detail": f"Analysis '{analysis_id}' was not found.",
        },
    )


@router.get("", response_model=AnalysisPage, dependencies=[Depends(rate_limit)])
def list_analyses(
    owner_id: str = Depends(get_owner_id),
    limit: int = Query(20, ge=1, le=100),
    cursor: str | None = Query(None, max_length=512),
    search: str | None = Query(None, max_length=120),
    status: JobStatus | None = Query(None),
) -> AnalysisPage:
    """List this owner's analyses, newest first, with keyset pagination."""
    try:
        return get_repository().list(
            owner_id, limit=limit, cursor=cursor, search=search, status=status
        )
    except RepositoryError as exc:
        raise HTTPException(
            status_code=400,
            detail={"success": False, "error": "bad_request", "detail": str(exc)},
        ) from exc


@router.get(
    "/{analysis_id}",
    response_model=AnalysisRecord,
    responses={404: {"model": ErrorResponse}},
)
def get_analysis(
    analysis_id: str, owner_id: str = Depends(get_owner_id)
) -> JSONResponse:
    """Retrieve one full analysis. Scoped to the caller's tenant."""
    try:
        record = get_repository().get(owner_id, analysis_id)
    except AnalysisNotFound as exc:
        raise _not_found(analysis_id) from exc
    return JSONResponse(status_code=200, content=record.model_dump(mode="json"))


@router.delete("/{analysis_id}", status_code=204, responses={404: {"model": ErrorResponse}})
def delete_analysis(analysis_id: str, owner_id: str = Depends(get_owner_id)) -> None:
    """Delete an analysis and its stored image."""
    repo = get_repository()
    try:
        record = repo.get(owner_id, analysis_id)
    except AnalysisNotFound as exc:
        raise _not_found(analysis_id) from exc

    # Best-effort image cleanup; the record deletion is authoritative.
    if record.image_key:
        from app.storage import get_storage
        from app.storage.base import assert_owned

        try:
            # The record was already fetched owner-scoped, so this should
            # always hold — re-check anyway so a corrupted or migrated record
            # can never cause a delete outside the caller's prefix.
            assert_owned(record.image_key, owner_id)
            get_storage().delete(record.image_key)
        except Exception:
            pass

    repo.delete(owner_id, analysis_id)


@router.get(
    "/{base_id}/compare/{target_id}",
    response_model=ComparisonResult,
    responses={404: {"model": ErrorResponse}, 409: {"model": ErrorResponse}},
)
def compare_analyses(
    base_id: str, target_id: str, owner_id: str = Depends(get_owner_id)
) -> ComparisonResult:
    """Compare detected category counts between two of this owner's scans."""
    if base_id == target_id:
        raise HTTPException(
            status_code=400,
            detail={
                "success": False,
                "error": "invalid_comparison",
                "detail": "Cannot compare an analysis with itself.",
            },
        )

    repo = get_repository()
    try:
        base = repo.get(owner_id, base_id)
        target = repo.get(owner_id, target_id)
    except AnalysisNotFound as exc:
        raise _not_found(str(exc)) from exc

    if base.retail is None or target.retail is None:
        raise HTTPException(
            status_code=409,
            detail={
                "success": False,
                "error": "not_comparable",
                "detail": "Both analyses must have completed detection to be compared.",
            },
        )

    return intelligence.compare(
        base_id,
        base.retail,
        target_id,
        target.retail,
        base_model=base.detection.model.name if base.detection else None,
        target_model=target.detection.model.name if target.detection else None,
    )
