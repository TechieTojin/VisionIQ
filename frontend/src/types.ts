// Shared types mirroring the backend's structured JSON responses.

export interface ImageMetadata {
  filename: string
  content_type: string
  format: string
  width: number
  height: number
  mode: string
  aspect_ratio: number
  size_bytes: number
  megapixels: number
}

export interface AnalyzeResponse {
  success: true
  message: string
  metadata: ImageMetadata
}

export interface ErrorResponse {
  success: false
  error: string
  detail: string
}

// -- Detection -------------------------------------------------------------

/**
 * Bounding box in ABSOLUTE pixels of the original image, origin top-left.
 * The SVG overlay uses the image dimensions as its viewBox, so these
 * coordinates need no manual rescaling when the image is resized.
 */
export interface BoundingBox {
  x1: number
  y1: number
  x2: number
  y2: number
  width: number
  height: number
  area: number
}

export interface Detection {
  id: number
  label: string
  class_id: number
  confidence: number
  box: BoundingBox
}

export type InferenceStatus = 'ok' | 'unavailable' | 'empty' | 'failed' | 'timeout'

export interface ModelInfo {
  provider: string
  name: string
  version: string
  task: string
  taxonomy: string
  device: string
}

export interface DetectionResult {
  analysis_id: string
  image_width: number
  image_height: number
  model: ModelInfo
  detections: Detection[]
  detection_count: number
  processing_ms: number
  status: InferenceStatus
  confidence_threshold: number
  warnings: string[]
}

// -- Retail intelligence ---------------------------------------------------

export type Reliability = 'measured' | 'estimated' | 'unsupported'

export interface CategoryCount {
  label: string
  count: number
  mean_confidence: number
  min_confidence: number
  max_confidence: number
}

export interface OccupancyEstimate {
  reliability: Reliability
  covered_fraction: number | null
  note: string
}

export interface ShelfGapAssessment {
  reliability: Reliability
  regions: unknown[]
  note: string
}

export interface SkuAssessment {
  status: 'unsupported' | 'unknown' | 'matched'
  matched_skus: string[]
  reason: string
}

export interface RetailIntelligence {
  total_detections: number
  categories: CategoryCount[]
  distinct_categories: number
  mean_confidence: number | null
  low_confidence_count: number
  occupancy: OccupancyEstimate
  shelf_gaps: ShelfGapAssessment
  sku: SkuAssessment
  caveats: string[]
}

// -- Insights --------------------------------------------------------------

export type InsightSource = 'rules' | 'bedrock' | 'unavailable'

export interface Insight {
  text: string
  source: InsightSource
  confidence: string
}

export interface InsightsResult {
  source: InsightSource
  summary: string
  observations: Insight[]
  suggested_actions: string[]
  disclaimer: string
  model_id: string | null
  token_usage: Record<string, number | null> | null
  degraded: boolean
}

// -- Analyses --------------------------------------------------------------

export type JobStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface AnalysisRecord {
  analysis_id: string
  owner_id: string
  created_at: string
  status: JobStatus
  image: ImageMetadata
  image_key: string | null
  detection: DetectionResult | null
  retail: RetailIntelligence | null
  insights: InsightsResult | null
  processing_ms: number | null
  error: string | null
  execution_mode: string
}

export interface AnalysisSummary {
  analysis_id: string
  created_at: string
  status: JobStatus
  filename: string
  detection_count: number
  distinct_categories: number
  top_labels: string[]
  execution_mode: string
}

export interface AnalysisPage {
  items: AnalysisSummary[]
  next_cursor: string | null
  has_more: boolean
}

export interface CategoryDelta {
  label: string
  before: number
  after: number
  delta: number
}

export interface ComparisonResult {
  base_analysis_id: string
  target_analysis_id: string
  comparable: boolean
  categories: CategoryDelta[]
  total_before: number
  total_after: number
  total_delta: number
  notable_changes: string[]
  caveats: string[]
}

// -- System ----------------------------------------------------------------

export interface SystemStatus {
  execution_mode: string
  auth_mode: string
  auth_enabled: boolean
  storage_backend: string
  repository_backend: string
  insights_provider: string
  model: ModelInfo
  model_available: boolean
  model_unavailable_reason: string | null
  confidence_threshold: number
  max_upload_bytes: number
  supported_statuses: string[]
}
