import { createSeedMonitorState } from './monitor-seed'
import type { MonitorState } from './monitor-types'

// 监控运行态单独持久化：指标时间窗、告警批次、待处理台账都放在这里，
// 刷新或重新进入页面读的是同一份数据，因此告警编号与批次号不会改变。
const MONITOR_STORAGE_KEY = 'scraper-config-studio:monitor'

let cache: MonitorState | null = null

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): MonitorState {
  const fallback = createSeedMonitorState()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(MONITOR_STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(MONITOR_STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as MonitorState
    return {
      version: parsed.version ?? fallback.version,
      configs: parsed.configs ?? fallback.configs,
      results: parsed.results ?? [],
      windows: parsed.windows ?? {},
      alerts: parsed.alerts ?? {},
      ledger: parsed.ledger ?? [],
      nextResultId: parsed.nextResultId ?? fallback.nextResultId,
      nextLedgerSeq: parsed.nextLedgerSeq ?? 1,
      createdAt: parsed.createdAt ?? fallback.createdAt,
    }
  } catch {
    window.localStorage.setItem(MONITOR_STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

export function readMonitorState(): MonitorState {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function writeMonitorState(state: MonitorState): MonitorState {
  cache = state
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(MONITOR_STORAGE_KEY, JSON.stringify(state))
  }
  return state
}

export function resetMonitorState(): MonitorState {
  return writeMonitorState(clone(createSeedMonitorState()))
}

export function monitorStorageKey(): string {
  return MONITOR_STORAGE_KEY
}
