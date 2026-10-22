"""DynamoDB analysis repository.

KEY DESIGN (matches the access patterns in base.py — no scans):
    Table PK : owner_id        (partition — gives tenant isolation for free)
    Table SK : analysis_id     (sort)
    GSI1     : owner_id (PK) + created_at (SK)
               -> newest-first listing via Query(ScanIndexForward=False)

Pagination uses DynamoDB's native LastEvaluatedKey, encoded as an opaque
base64 cursor so clients cannot forge keys into another tenant's partition.

Filtering by status/search uses a FilterExpression on the GSI query. This
filters after read, so pages may come back short — `has_more` reflects whether
more pages exist, which is the correct contract for keyset pagination.
"""

from __future__ import annotations

import base64
import json
from datetime import datetime
from decimal import Decimal

from app.repositories.base import AnalysisNotFound, RepositoryError
from app.schemas.analysis import AnalysisPage, AnalysisRecord, AnalysisSummary, JobStatus

GSI_NAME = "owner_created_index"


def _to_dynamo(value):
    """Convert floats to Decimal, which is the only numeric type DynamoDB takes."""
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: _to_dynamo(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_to_dynamo(v) for v in value]
    return value


def _from_dynamo(value):
    if isinstance(value, Decimal):
        f = float(value)
        return int(f) if f.is_integer() else f
    if isinstance(value, dict):
        return {k: _from_dynamo(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_from_dynamo(v) for v in value]
    return value


class DynamoAnalysisRepository:
    """DynamoDB-backed repository implementing the shared contract."""

    def __init__(self, table_name: str, region: str) -> None:
        if not table_name:
            raise ValueError("VISIONIQ_DYNAMODB_TABLE must be set for DynamoDB storage.")
        self.table_name = table_name
        self.region = region
        self._table = None

    def _t(self):
        if self._table is None:
            import boto3

            self._table = boto3.resource(
                "dynamodb", region_name=self.region
            ).Table(self.table_name)
        return self._table

    # -- helpers ---------------------------------------------------------

    @staticmethod
    def _item(record: AnalysisRecord) -> dict:
        """Flatten a record into an item with promoted query attributes."""
        payload = json.loads(record.model_dump_json())
        count = record.retail.total_detections if record.retail else 0
        distinct = record.retail.distinct_categories if record.retail else 0
        labels = [c.label for c in record.retail.categories[:3]] if record.retail else []

        return _to_dynamo(
            {
                "owner_id": record.owner_id,
                "analysis_id": record.analysis_id,
                "created_at": record.created_at.isoformat(),
                "status": record.status.value,
                "filename": record.image.filename,
                "detection_count": count,
                "distinct_categories": distinct,
                "top_labels": labels,
                "execution_mode": record.execution_mode,
                "payload": payload,
            }
        )

    @staticmethod
    def _record(item: dict) -> AnalysisRecord:
        return AnalysisRecord.model_validate(_from_dynamo(item["payload"]))

    @staticmethod
    def _encode_cursor(key: dict | None) -> str | None:
        if not key:
            return None
        return base64.urlsafe_b64encode(
            json.dumps(_from_dynamo(key), sort_keys=True).encode()
        ).decode()

    @staticmethod
    def _decode_cursor(cursor: str, owner_id: str) -> dict:
        try:
            key = json.loads(base64.urlsafe_b64decode(cursor.encode()).decode())
        except Exception as exc:
            raise RepositoryError("Invalid pagination cursor.") from exc
        # Refuse a cursor that points into someone else's partition.
        if key.get("owner_id") != owner_id:
            raise RepositoryError("Pagination cursor does not match the requester.")
        return _to_dynamo(key)

    # -- API -------------------------------------------------------------

    def create(self, record: AnalysisRecord) -> AnalysisRecord:
        try:
            self._t().put_item(Item=self._item(record))
        except Exception as exc:
            raise RepositoryError(f"DynamoDB put_item failed: {exc}") from exc
        return record

    def get(self, owner_id: str, analysis_id: str) -> AnalysisRecord:
        try:
            resp = self._t().get_item(
                Key={"owner_id": owner_id, "analysis_id": analysis_id}
            )
        except Exception as exc:
            raise RepositoryError(f"DynamoDB get_item failed: {exc}") from exc

        item = resp.get("Item")
        if not item:
            raise AnalysisNotFound(f"Analysis '{analysis_id}' not found.")
        return self._record(item)

    def list(
        self,
        owner_id: str,
        *,
        limit: int = 20,
        cursor: str | None = None,
        search: str | None = None,
        status: JobStatus | None = None,
    ) -> AnalysisPage:
        from boto3.dynamodb.conditions import Attr, Key

        limit = max(1, min(limit, 100))
        kwargs: dict = {
            "IndexName": GSI_NAME,
            "KeyConditionExpression": Key("owner_id").eq(owner_id),
            "ScanIndexForward": False,  # newest first
            "Limit": limit,
        }

        filters = None
        if status:
            filters = Attr("status").eq(status.value)
        if search:
            # Match the SQLite repository's behaviour: search filename OR the
            # promoted top_labels, so local and cloud return the same results.
            term = Attr("filename").contains(search) | Attr("top_labels").contains(
                search
            )
            filters = term if filters is None else filters & term
        if filters is not None:
            kwargs["FilterExpression"] = filters

        if cursor:
            kwargs["ExclusiveStartKey"] = self._decode_cursor(cursor, owner_id)

        try:
            resp = self._t().query(**kwargs)
        except Exception as exc:
            raise RepositoryError(f"DynamoDB query failed: {exc}") from exc

        items = [
            AnalysisSummary(
                analysis_id=i["analysis_id"],
                created_at=datetime.fromisoformat(i["created_at"]),
                status=JobStatus(i["status"]),
                filename=i.get("filename", ""),
                detection_count=int(i.get("detection_count", 0)),
                distinct_categories=int(i.get("distinct_categories", 0)),
                top_labels=list(i.get("top_labels", [])),
                execution_mode=i.get("execution_mode", "cloud"),
            )
            for i in resp.get("Items", [])
        ]

        next_cursor = self._encode_cursor(resp.get("LastEvaluatedKey"))
        return AnalysisPage(
            items=items, next_cursor=next_cursor, has_more=next_cursor is not None
        )

    def update(self, record: AnalysisRecord) -> AnalysisRecord:
        return self.create(record)

    def set_status(
        self, owner_id: str, analysis_id: str, status: JobStatus, error: str | None = None
    ) -> AnalysisRecord:
        """Targeted status transition without rewriting the whole payload."""
        expr = "SET #s = :s, payload.#s = :s"
        values = {":s": status.value}
        if error is not None:
            expr += ", payload.#e = :e"
            values[":e"] = error

        try:
            self._t().update_item(
                Key={"owner_id": owner_id, "analysis_id": analysis_id},
                UpdateExpression=expr,
                ExpressionAttributeNames={"#s": "status", "#e": "error"},
                ExpressionAttributeValues=values,
                ConditionExpression="attribute_exists(analysis_id)",
            )
        except Exception as exc:
            if "ConditionalCheckFailed" in str(exc):
                raise AnalysisNotFound(f"Analysis '{analysis_id}' not found.") from exc
            raise RepositoryError(f"DynamoDB update_item failed: {exc}") from exc

        return self.get(owner_id, analysis_id)

    def delete(self, owner_id: str, analysis_id: str) -> None:
        try:
            self._t().delete_item(
                Key={"owner_id": owner_id, "analysis_id": analysis_id},
                ConditionExpression="attribute_exists(analysis_id)",
            )
        except Exception as exc:
            if "ConditionalCheckFailed" in str(exc):
                raise AnalysisNotFound(f"Analysis '{analysis_id}' not found.") from exc
            raise RepositoryError(f"DynamoDB delete_item failed: {exc}") from exc
