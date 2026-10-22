import type { AnalysisRecord, Detection, DetectionResult } from '../types'

export function makeDetection(
  id: number,
  label: string,
  confidence: number,
  box: [number, number, number, number] = [10, 20, 60, 90],
): Detection {
  const [x1, y1, x2, y2] = box
  return {
    id,
    label,
    class_id: id,
    confidence,
    box: {
      x1,
      y1,
      x2,
      y2,
      width: x2 - x1,
      height: y2 - y1,
      area: (x2 - x1) * (y2 - y1),
    },
  }
}

export function makeDetectionResult(
  detections: Detection[],
  overrides: Partial<DetectionResult> = {},
): DetectionResult {
  return {
    analysis_id: 'a1',
    image_width: 400,
    image_height: 300,
    model: {
      provider: 'yolo',
      name: 'yolov8n.pt',
      version: '8.4.183',
      task: 'object-detection',
      taxonomy: 'COCO-80',
      device: 'cpu',
    },
    detections,
    detection_count: detections.length,
    processing_ms: 120,
    status: detections.length ? 'ok' : 'empty',
    confidence_threshold: 0.25,
    warnings: [],
    ...overrides,
  }
}

export function makeRecord(
  detections: Detection[] = [],
  overrides: Partial<AnalysisRecord> = {},
): AnalysisRecord {
  const detection = makeDetectionResult(detections)
  return {
    analysis_id: 'a1',
    owner_id: 'local',
    created_at: new Date().toISOString(),
    status: 'completed',
    image: {
      filename: 'shelf.png',
      content_type: 'image/png',
      format: 'PNG',
      width: 400,
      height: 300,
      mode: 'RGB',
      aspect_ratio: 1.3333,
      size_bytes: 54321,
      megapixels: 0.12,
    },
    image_key: 'local/a1.png',
    detection,
    retail: {
      total_detections: detections.length,
      categories: [],
      distinct_categories: 0,
      mean_confidence: detections.length ? 0.8 : null,
      low_confidence_count: 0,
      occupancy: {
        reliability: 'unsupported',
        covered_fraction: null,
        note: 'n/a',
      },
      shelf_gaps: {
        reliability: 'unsupported',
        regions: [],
        note: 'not enabled',
      },
      sku: {
        status: 'unsupported',
        matched_skus: [],
        reason: 'Generic COCO-80 model cannot identify SKUs.',
      },
      caveats: ['Labels are generic object classes.'],
    },
    insights: {
      source: 'rules',
      summary: 'Summary text.',
      observations: [],
      suggested_actions: [],
      disclaimer: 'Not verified inventory data.',
      model_id: null,
      token_usage: null,
      degraded: false,
    },
    processing_ms: 150,
    error: null,
    execution_mode: 'local',
    ...overrides,
  }
}
