import { useScanData } from '../data/useScanData'

/** Workbench endpoints exist only on the local FastAPI backend. */
export function useWorkbenchAvailable(): boolean {
  return useScanData().source.mode === 'local'
}
