import { useContext } from 'react'
import { ScanDataContext, type ScanDataValue } from './scanContext'

export function useScanData(): ScanDataValue {
  const value = useContext(ScanDataContext)
  if (!value) throw new Error('useScanData must be used within <ScanDataProvider>')
  return value
}
