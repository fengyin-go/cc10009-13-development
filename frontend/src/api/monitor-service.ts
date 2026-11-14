import { listRows, saveRows } from '@/data/local-store'
import {
  evaluateMonitor,
  ingestScrapeResults,
  missingTimestampSummary,
  recordTaskStatusChange,
  resolveAlert,
  resolveLedgerEntry,
  reviseThreshold,
  type IngestOutcome,
  type ScrapeResultInput,
} from '@/data/monitor-engine'
import { readMonitorState, resetMonitorState, writeMonitorState } from '@/data/monitor-store'
import type {
  AlertRecord,
  LedgerEntry,
  MetricConfig,
  MonitorDashboard,
  MonitorState,
  MonitorWindow,
  RefreshSummary,
} from '@/data/monitor-types'

// 采集监控服务：所有时间窗统计、告警生成、阈值调整与台账读写都在这里，
// 页面只渲染返回值。运行态持久化在 monitor-store，刷新 / 重新进入读同一份数据。

function nowStamp(): string {
  return new Date().toISOString()
}

function sortByStart(windows: MonitorWindow[]): MonitorWindow[] {
  return [...windows].sort((left, right) => {
    const diff = Date.parse(left.start) - Date.parse(right.start)
    return diff !== 0 ? diff : left.id.localeCompare(right.id)
  })
}

function sortAlerts(alerts: AlertRecord[]): AlertRecord[] {
  return [...alerts].sort((left, right) => {
    const diff = Date.parse(right.createdAt) - Date.parse(left.createdAt)
    return diff !== 0 ? diff : left.id.localeCompare(right.id)
  })
}

function sortLedger(entries: LedgerEntry[]): LedgerEntry[] {
  return [...entries].sort((left, right) => {
    const diff = Date.parse(right.createdAt) - Date.parse(left.createdAt)
    return diff !== 0 ? diff : right.id.localeCompare(left.id)
  })
}

function buildDashboard(state: MonitorState): MonitorDashboard {
  return {
    configs: Object.values(state.configs).sort((left, right) => left.rowId - right.rowId),
    windows: sortByStart(Object.values(state.windows)),
    alerts: sortAlerts(Object.values(state.alerts)),
    missingTimestamps: missingTimestampSummary(state),
    activeAlertCount: Object.values(state.alerts).filter((alert) => alert.status === '待处理').length,
  }
}

/** 按当前持久化的采集结果重算一次时间窗；窗口编号与告警键都是稳定派生值。 */
function evaluatedState(): MonitorState {
  const state = readMonitorState()
  const outcome = evaluateMonitor(state, nowStamp())
  writeMonitorState(outcome.state)
  syncThresholdFields(outcome.state)
  return outcome.state
}

/**
 * 读取看板时先重算时间窗。
 * 已存在的告警按「指标 + 窗口开始」复用，不会因为刷新或重新进入生成新批次。
 */
export function loadMonitorDashboard(): MonitorDashboard {
  return buildDashboard(evaluatedState())
}

export function refreshMonitorWindows(): RefreshSummary {
  const state = readMonitorState()
  const outcome = evaluateMonitor(state, nowStamp())
  writeMonitorState(outcome.state)
  syncThresholdFields(outcome.state)
  return outcome.summary
}

/** 采集结果入库：同步执行，天然串行；并发提交同一指标也只会有一次生效。 */
export function submitScrapeResults(inputs: ScrapeResultInput[]): IngestOutcome {
  const state = readMonitorState()
  const outcome = ingestScrapeResults(state, inputs, nowStamp())
  writeMonitorState(outcome.state)
  return outcome
}

/** 调整阈值：只影响后续时间窗，已生成的时间窗与告警保留原阈值快照。 */
export function updateMetricThreshold(metricCode: string, threshold: number): MetricConfig {
  const state = readMonitorState()
  const next = reviseThreshold(state, metricCode, threshold, nowStamp())
  writeMonitorState(next)
  syncThresholdFields(next)
  return next.configs[metricCode]
}

/**
 * 把指标配置同步到采集监控模块的展示字段，历史窗口仍用各自的阈值快照。
 * 老浏览器里可能只剩占位行，这里一并补齐编号、关联任务与统计粒度的对应关系。
 */
function syncThresholdFields(state: MonitorState): void {
  const rows = listRows('monitor')
  if (!rows.length) {
    return
  }
  let changed = false
  const next = rows.map((row) => {
    const config = state.configs[String(row['指标编号'])]
    if (!config) {
      return row
    }
    const threshold = String(config.threshold)
    const granularity = config.granularityLabel
    const silence = String(config.silenceMinutes)
    const task = config.taskCode
    const name = config.name
    const level = config.severity
    const channel = config.channel
    if (
      String(row['预警阈值']) === threshold &&
      String(row['统计粒度']) === granularity &&
      String(row['静默窗口']) === silence &&
      String(row['关联任务']) === task &&
      String(row['指标名称']) === name &&
      String(row['告警级别']) === level &&
      String(row['通知渠道']) === channel
    ) {
      return row
    }
    changed = true
    return {
      ...row,
      预警阈值: threshold,
      统计粒度: granularity,
      静默窗口: silence,
      关联任务: task,
      指标名称: name,
      告警级别: level,
      通知渠道: channel,
    }
  })
  if (changed) {
    saveRows('monitor', next)
  }
}

export function listLedger(onlyPending = false): LedgerEntry[] {
  const entries = readMonitorState().ledger
  return sortLedger(onlyPending ? entries.filter((entry) => entry.status === '待处理') : entries)
}

export function handleLedgerEntry(entryId: string): LedgerEntry {
  const state = readMonitorState()
  const next = resolveLedgerEntry(state, entryId, nowStamp())
  writeMonitorState(next)
  return next.ledger.find((entry) => entry.id === entryId) as LedgerEntry
}

export function handleAlert(alertId: string): AlertRecord {
  const state = readMonitorState()
  const next = resolveAlert(state, alertId, nowStamp())
  writeMonitorState(next)
  return next.alerts[alertId]
}

/** 采集任务状态变化写入待处理台账，由另一个入口（待处理台账页）统一处理。 */
/** 重置采集监控运行态：时间窗、告警与台账一起回到示例数据。 */
export function resetMonitorRuntime(): MonitorDashboard {
  resetMonitorState()
  return loadMonitorDashboard()
}

export function recordTaskTransition(
  taskCode: string,
  fromStatus: string,
  toStatus: string,
  action: string,
): void {
  const state = readMonitorState()
  writeMonitorState(recordTaskStatusChange(state, { taskCode, fromStatus, toStatus, action }, nowStamp()))
}

export type TaskResultSummary = {
  taskCode: string
  windowCount: number
  collected: number
  success: number
  abnormal: number
  /** 缺少时间戳、未入窗的结果条数；单独列出，不并入上面的合计 */
  missingTimestampCount: number
  lastObservedAt: string | null
}

/**
 * 采集任务结果：按窗口当前快照（每个窗口取最新一条）汇总，
 * 与采集监控页看到的时间窗异常量完全一致。
 */
export function taskResultSummary(taskCode: string): TaskResultSummary {
  const state = evaluatedState()
  const windows = Object.values(state.windows).filter((window) => window.taskCode === taskCode)
  const summary: TaskResultSummary = {
    taskCode,
    windowCount: windows.length,
    collected: 0,
    success: 0,
    abnormal: 0,
    missingTimestampCount: 0,
    lastObservedAt: null,
  }
  for (const window of windows) {
    summary.collected += window.collected
    summary.success += window.success
    summary.abnormal += window.abnormal
    if (
      window.latestObservedAt &&
      (!summary.lastObservedAt || Date.parse(window.latestObservedAt) > Date.parse(summary.lastObservedAt))
    ) {
      summary.lastObservedAt = window.latestObservedAt
    }
  }
  summary.missingTimestampCount = state.results.filter(
    (result) => result.taskCode === taskCode && !result.occurredAt,
  ).length
  return summary
}

export function listTaskResults(): TaskResultSummary[] {
  const state = evaluatedState()
  const codes = new Set<string>(Object.values(state.configs).map((config) => config.taskCode))
  return [...codes].map((code) => taskResultSummary(code)).filter((item) => item.windowCount > 0 || item.missingTimestampCount > 0)
}

