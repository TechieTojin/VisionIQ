"""Annotation Studio and Dataset Manager backends."""

from __future__ import annotations

import io
import zipfile

import pytest

from app.workbench import datasets
from tests.conftest import make_detection, make_image_bytes, seed_scan

DETS = [
    make_detection(0, "bottle", 0.92, (10, 10, 60, 90)),
    make_detection(1, "bottle", 0.40, (70, 10, 120, 90)),
    make_detection(2, "cup", 0.75, (10, 100, 55, 160)),
]


def _import(client, aid, min_conf=0.25):
    r = client.post(f"/api/annotations/{aid}/import", json={"min_confidence": min_conf})
    assert r.status_code == 201, r.text
    return r.json()


def _save(client, aid, doc, boxes=None, status="reviewed"):
    body = {"base_revision": doc["revision"], "status": status,
            "boxes": boxes if boxes is not None else [
                {k: b[k] for k in ("id", "label", "x1", "y1", "x2", "y2", "source", "origin_detection_id")}
                for b in doc["boxes"]
            ]}
    return client.put(f"/api/annotations/{aid}", json=body)


# -- annotations ------------------------------------------------------------------


def test_import_copies_predictions_and_leaves_them_immutable(wb, client):
    rec = seed_scan(detections=DETS)
    doc = _import(client, rec.analysis_id, 0.5)
    assert [b["origin_detection_id"] for b in doc["boxes"]] == [0, 2]  # 0.40 excluded
    assert all(b["source"] == "model" and not b["edited"] for b in doc["boxes"])
    assert doc["status"] == "unreviewed"
    # Second import must not clobber human work.
    assert client.post(f"/api/annotations/{rec.analysis_id}/import", json={}).status_code == 409
    # The scan's own predictions are untouched.
    assert len(client.get(f"/api/analyses/{rec.analysis_id}").json()["detection"]["detections"]) == 3


def test_save_reload_round_trip_is_exact_and_tracks_provenance(wb, client):
    rec = seed_scan(detections=DETS)
    doc = _import(client, rec.analysis_id)
    boxes = [
        {"id": "p0", "label": "bottle", "x1": 12.5, "y1": 10, "x2": 60, "y2": 90, "source": "model", "origin_detection_id": 0},
        {"id": "p2", "label": "mug", "x1": 10, "y1": 100, "x2": 55, "y2": 160, "source": "model", "origin_detection_id": 2},
        {"id": "h1", "label": "price tag", "x1": 200.25, "y1": 200.75, "x2": 250, "y2": 230, "source": "human"},
        # Overlapping boxes are legitimate (stacked products) and kept separate.
        {"id": "h2", "label": "price tag", "x1": 205, "y1": 205, "x2": 255, "y2": 235, "source": "human"},
    ]
    r = _save(client, rec.analysis_id, doc, boxes, status="in_progress")
    assert r.status_code == 200, r.text
    saved = r.json()
    reloaded = client.get(f"/api/annotations/{rec.analysis_id}").json()
    assert reloaded["boxes"] == saved["boxes"]
    by_id = {b["id"]: b for b in reloaded["boxes"]}
    assert by_id["p0"]["edited"] is True  # moved
    assert by_id["p2"]["edited"] is True and by_id["p2"]["model_label"] == "cup"  # relabelled
    assert by_id["h1"]["x1"] == 200.25 and by_id["h1"]["model_confidence"] is None
    assert reloaded["stats"] == {"boxes": 4, "accepted_unmodified": 0, "edited_predictions": 2,
                                 "human_added": 2, "deleted_predictions": 1, "imported_predictions": 3}
    assert "price tag" in client.get("/api/annotations/labels").json()


@pytest.mark.parametrize("box,why", [
    ({"x1": 10, "y1": 10, "x2": 10, "y2": 50}, "zero width"),
    ({"x1": 50, "y1": 10, "x2": 20, "y2": 50}, "inverted"),
    ({"x1": -5, "y1": 10, "x2": 20, "y2": 50}, "outside left"),
    ({"x1": 10, "y1": 10, "x2": 400, "y2": 50}, "outside right (image is 320 wide)"),
    ({"x1": 10, "y1": 10, "x2": 11, "y2": 50}, "under 2px"),
])
def test_invalid_boxes_are_rejected(wb, client, box, why):
    rec = seed_scan()
    doc = client.post(f"/api/annotations/{rec.analysis_id}/empty").json()
    r = _save(client, rec.analysis_id, doc, [{"id": "h1", "label": "bottle", "source": "human", **box}])
    assert r.status_code == 400, why
    assert r.json()["error"] == "invalid_box"


def test_cannot_forge_a_model_prediction(wb, client):
    rec = seed_scan(detections=DETS)
    doc = client.post(f"/api/annotations/{rec.analysis_id}/empty").json()  # imported nothing
    r = _save(client, rec.analysis_id, doc, [
        {"id": "x", "label": "bottle", "x1": 10, "y1": 10, "x2": 60, "y2": 90, "source": "model", "origin_detection_id": 0},
    ])
    assert r.status_code == 400 and "no imported prediction" in r.json()["detail"]


def test_invalid_labels_and_ids_are_rejected(wb, client):
    rec = seed_scan()
    doc = client.post(f"/api/annotations/{rec.analysis_id}/empty").json()
    bad_label = _save(client, rec.analysis_id, doc, [
        {"id": "h", "label": "a\nnames: evil", "x1": 1, "y1": 1, "x2": 20, "y2": 20, "source": "human"}])
    assert bad_label.status_code == 400
    bad_id = _save(client, rec.analysis_id, doc, [
        {"id": "../x", "label": "ok", "x1": 1, "y1": 1, "x2": 20, "y2": 20, "source": "human"}])
    assert bad_id.status_code == 422


def test_stale_save_is_a_conflict_not_an_overwrite(wb, client):
    rec = seed_scan(detections=DETS)
    doc = _import(client, rec.analysis_id)
    assert _save(client, rec.analysis_id, doc).status_code == 200
    stale = _save(client, rec.analysis_id, doc)  # same base revision again
    assert stale.status_code == 409 and stale.json()["error"] == "revision_conflict"


def test_annotations_are_owner_scoped(wb, client):
    other = seed_scan(owner_id="mallory", detections=DETS)
    assert client.post(f"/api/annotations/{other.analysis_id}/import", json={}).status_code == 404
    assert client.get(f"/api/annotations/{other.analysis_id}").status_code == 404
    assert client.get("/api/annotations").json()["total"] == 0


def test_single_image_yolo_export(wb, client):
    rec = seed_scan(detections=DETS)  # 320x240
    doc = _import(client, rec.analysis_id)
    _save(client, rec.analysis_id, doc)
    out = client.get(f"/api/annotations/{rec.analysis_id}/yolo").json()
    assert out["classes"] == ["bottle", "cup"]
    first = out["label_file"].splitlines()[0].split()
    assert first[0] == "0"
    assert float(first[1]) == pytest.approx(35 / 320)  # centre x of 10..60
    assert float(first[4]) == pytest.approx(80 / 240)  # height of 10..90


# -- datasets ----------------------------------------------------------------------


def _reviewed_scan(client, color, dets=DETS, owner="local"):
    rec = seed_scan(owner_id=owner, detections=dets, color=color)
    doc = _import(client, rec.analysis_id)
    assert _save(client, rec.analysis_id, doc).status_code == 200
    return rec


def test_dataset_lifecycle_versioning_and_export(wb, client):
    ds = client.post("/api/datasets", json={"name": "Aisle 3", "classes": ["bottle", "cup"]}).json()
    scans = [_reviewed_scan(client, (10 * i, 20, 30)) for i in range(6)]
    unlabeled = seed_scan(color=(1, 2, 3))
    r = client.post(f"/api/datasets/{ds['dataset_id']}/items",
                    json={"analysis_ids": [s.analysis_id for s in scans] + [unlabeled.analysis_id]})
    assert r.json()["added"] == 7
    detail = r.json()["dataset"]
    assert detail["status_counts"]["reviewed"] == 6 and detail["status_counts"]["none"] == 1
    assert {c["label"]: c["count"] for c in detail["class_distribution"]} == {"bottle": 12, "cup": 6}

    v1 = client.post(f"/api/datasets/{ds['dataset_id']}/versions", json={"seed": 7}).json()
    assert v1["version"] == 1
    assert v1["stats"]["labeled_images"] == 6 and v1["stats"]["excluded_images"] == 1
    splits = v1["stats"]["splits"]
    assert splits["train"]["images"] + splits["val"]["images"] + splits["test"]["images"] == 6
    assert v1["readiness"]["training_ready"] is True

    # Versions are immutable: removing an item later doesn't change v1.
    client.delete(f"/api/datasets/{ds['dataset_id']}/items/{scans[0].analysis_id}")
    again = client.get(f"/api/datasets/{ds['dataset_id']}/versions/1").json()
    assert again["stats"]["labeled_images"] == 6

    r = client.get(f"/api/datasets/{ds['dataset_id']}/versions/1/export")
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    names = set(zf.namelist())
    assert "data.yaml" in names and "manifest.json" in names
    yaml_text = zf.read("data.yaml").decode()
    assert 'nc: 2' in yaml_text and '0: "bottle"' in yaml_text
    images = [n for n in names if n.startswith("images/")]
    labels = [n for n in names if n.startswith("labels/")]
    assert len(images) == len(labels) == 6
    for img in images:
        split, file = img.split("/")[1:]
        stem = file.rsplit(".", 1)[0]
        label = f"labels/{split}/{stem}.txt"
        assert label in names  # every image maps to its own label file
        for line in zf.read(label).decode().splitlines():
            cls, *coords = line.split()
            assert int(cls) in (0, 1)
            assert all(0 <= float(c) <= 1 for c in coords)


def test_splits_are_reproducible_and_duplicates_never_leak():
    hashes = [f"h{i}" for i in range(20)] + ["h3", "h3", "h7"]
    a = datasets.assign_splits(hashes, 42, 0.6, 0.2, 0.2)
    b = datasets.assign_splits(hashes, 42, 0.6, 0.2, 0.2)
    assert a == b  # same seed, same split
    assert set(a.values()) == {"train", "val", "test"}
    # Grouping by hash means a duplicate image has exactly one split.
    assert len(a) == 20
    c = datasets.assign_splits(hashes, 43, 0.6, 0.2, 0.2)
    assert a != c


def test_exact_duplicate_images_are_flagged(wb, client):
    data = make_image_bytes("PNG", (320, 240), (5, 5, 5))
    a = seed_scan(image_bytes=data)
    b = seed_scan(image_bytes=data)
    ds = client.post("/api/datasets", json={"name": "Dupes", "classes": ["bottle"]}).json()
    detail = client.post(f"/api/datasets/{ds['dataset_id']}/items",
                         json={"analysis_ids": [a.analysis_id, b.analysis_id]}).json()["dataset"]
    assert detail["duplicate_groups"] == [[a.analysis_id, b.analysis_id]]


def test_dataset_without_reviewed_labels_is_not_training_ready(wb, client):
    rec = seed_scan(detections=DETS)
    _import(client, rec.analysis_id)  # imported but NOT reviewed
    ds = client.post("/api/datasets", json={"name": "Raw", "classes": ["bottle"]}).json()
    client.post(f"/api/datasets/{ds['dataset_id']}/items", json={"analysis_ids": [rec.analysis_id]})
    v = client.post(f"/api/datasets/{ds['dataset_id']}/versions", json={}).json()
    assert v["readiness"]["training_ready"] is False
    assert any("No reviewed annotations" in b for b in v["readiness"]["blockers"])
    r = client.get(f"/api/datasets/{ds['dataset_id']}/versions/1/export")
    assert r.status_code == 400 and r.json()["error"] == "no_labels"


def test_dataset_validation_tenancy_and_traversal(wb, client):
    assert client.post("/api/datasets", json={"name": "x", "classes": ["ok", "ok"]}).status_code == 422
    bad = client.post("/api/datasets", json={"name": "x", "classes": ["../../etc"]})
    assert bad.status_code == 400 and bad.json()["error"] == "invalid_label"
    assert client.get("/api/datasets/..%2F..%2Fsecret").status_code == 404
    assert client.get("/api/datasets/ds_0000000000000000").status_code == 404
    other = seed_scan(owner_id="mallory")
    ds = client.post("/api/datasets", json={"name": "Mine", "classes": ["bottle"]}).json()
    r = client.post(f"/api/datasets/{ds['dataset_id']}/items", json={"analysis_ids": [other.analysis_id]})
    assert r.json()["added"] == 0 and r.json()["skipped"][0]["reason"] == "Scan was not found."
    from app.workbench import datasets as dmod
    assert dmod.list_datasets("mallory") == []


def test_data_yaml_quotes_class_names():
    text = datasets.data_yaml(["bottle", 'odd "name"'])
    assert '1: "odd \\"name\\""' in text
