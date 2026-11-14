import type {
  AlertRecord,
  MissingTimestampSummary,
  LedgerEntry,
  MetricConfig,
  MonitorState,
  MonitorWindow,
  RefreshSummary,
  ScrapeResult,
  ThresholdRevision,
} from './monitor-types'

// ---------------------------------------------------------------------------
// 时间窗边界
// 所有窗口都按「本地日历」切分，不按固定毫秒数累加：
//   - 分钟 / 小时窗口从本地自然日 00:00 起对齐，步长取整后仍落在同一自然日；
//   - 日窗口是 [当日 00:00, 次日 00:00)，跨月、跨年由 Date 日历推进；
//   - 月窗口是 [当月 1 日 00:00, 次月 1 日 00:00)，月末天数不固定也不影响切分。
// 因此 23:45 的 15 分钟窗口结束在次日 00:00，10 月的窗口结束在 11 月 1 日，
// 刷新、重新进入或更换浏览器都不会让边界漂移。
// ---------------------------------------------------------------------------

type WindowSlice = {
  start: Date
  end: Date
  rule: string
}

function localDayNumber(date: Date): number {
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate()
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

function localClock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function localStamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${localClock(date)}`
}

function dayRuleText(start: Date, end: Date, stepLabel: string): string {
  if (localDayNumber(start) !== localDayNumber(end)) {
    return `${stepLabel}窗口，从本地 ${localStamp(start)} 起跨整日，结束固定为次日 00:00`
  }
  return `${stepLabel}窗口，按本地自然日对齐，窗口结束为下一个边界，跨日由日历推进`
}

function sliceFor(occurredAt: string, config: MetricConfig): WindowSlice | null {
  const date = new Date(occurredAt)
  if (!occurredAt || Number.isNaN(date.getTime())) {
    return null
  }
  const year = date.getFullYear()
  const month = date.getMonth()
  const day = date.getDate()

  if (config.granularity === 'month') {
    return {
      start: new Date(year, month, 1, 0, 0, 0, 0),
      end: new Date(year, month + 1, 1, 0, 0, 0, 0),
      rule: '自然月窗口，[当月 1 日 00:00, 次月 1 日 00:00)，月末按本地日历推进',
    }
  }

  if (config.granularity === 'day') {
    return {
      start: new Date(year, month, day, 0, 0, 0, 0),
      end: new Date(year, month, day + 1, 0, 0, 0, 0),
      rule: '自然日窗口，[00:00, 次日 00:00)，跨月、跨年按本地日历推进',
    }
  }

  if (config.granularity === 'hour') {
    const step = Math.max(1, Math.floor(config.granularityMinutes ?? 1))
    const hourStart = Math.floor(date.getHours() / step) * step
    const start = new Date(year, month, day, hourStart, 0, 0, 0)
    const end = new Date(year, month, day, hourStart + step, 0, 0, 0)
    return {
      start,
      end,
      rule: dayRuleText(start, end, `${step} 小时`),
    }
  }

  const step = Math.max(1, Math.floor(config.granularityMinutes ?? 10))
  const minutesOfDay = date.getHours() * 60 + date.getMinutes()
  const minuteStart = Math.floor(minutesOfDay / step) * step
  const start = new Date(year, month, day, 0, minuteStart, 0, 0)
  const end = new Date(year, month, day, 0, minuteStart + step, 0, 0)
  return {
    start,
    end,
    rule: dayRuleText(start, end, `${step} 分钟`),
  }
}

// ---------------------------------------------------------------------------
// 稳定编号
// ---------------------------------------------------------------------------

function windowKey(config: MetricConfig, start: Date): string {
  return `${config.windowGroup}:${start.toISOString()}`
}

function alertKey(window: Pick<MonitorWindow, 'metricCode' | 'start'>): string {
  return `ALERT:${window.metricCode}:${window.start}`
}

function batchKey(window: Pick<MonitorWindow, 'metricCode' | 'start'>): string {
  return `BATCH:${window.metricCode}:${window.start}`
}

function alertLedgerKey(alertId: string): string {
  return `LEDGER:ALERT:${alertId}`
}

/** 批次号是窗口的稳定派生值：刷新、并发提交、重新进入都不会变。 */
export function batchIdFor(metricCode: string, windowStart: string): string {
  return batchKey({ metricCode, start: windowStart })
}

// ---------------------------------------------------------------------------
// 阈值版本
// ---------------------------------------------------------------------------

function thresholdRevisionAt(config: MetricConfig, windowStart: string): ThresholdRevision {
  const startMs = Date.parse(windowStart)
  const history = [...config.thresholdHistory].sort(
    (left, right) => Date.parse(left.effectiveFrom) - Date.parse(right.effectiveFrom),
  )
  let chosen = history[0] ?? {
    version: config.thresholdVersion,
    threshold: config.threshold,
    effectiveFrom: windowStart,
  }
  for (const revision of history) {
    if (Date.parse(revision.effectiveFrom) <= startMs) {
      chosen = revision
    }
  }
  return chosen
}

/** 调整阈值只写配置版本，不碰任何已生成的时间窗和告警记录。 */
export function reviseThreshold(
  state: MonitorState,
  metricCode: string,
  threshold: number,
  now: string,
): MonitorState {
  const next = cloneState(state)
  const config = next.configs[metricCode]
  if (!config) {
    throw new Error(`没有登记编号为 ${metricCode} 的监控指标`)
  }
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new Error('预警阈值必须是非负数字')
  }
  const version = config.thresholdVersion + 1
  config.threshold = threshold
  config.thresholdVersion = version
  config.thresholdHistory.push({ version, threshold, effectiveFrom: now })
  return next
}

/** 阈值生效口径：窗口开始时间在本次调整之后，才按新阈值统计。 */
export function thresholdForWindow(config: MetricConfig, windowStart: string): ThresholdRevision {
  return thresholdRevisionAt(config, windowStart)
}

// ---------------------------------------------------------------------------
// 窗口与告警评估
// ---------------------------------------------------------------------------

type ResultGroup = {
  start: Date
  end: Date
  rule: string
  results: ScrapeResult[]
}

function cloneState(state: MonitorState): MonitorState {
  return JSON.parse(JSON.stringify(state)) as MonitorState
}

function groupResults(config: MetricConfig, results: ScrapeResult[]): ResultGroup[] {
  const groups = new Map<string, ResultGroup>()
  for (const result of results) {
    const slice = sliceFor(result.occurredAt ?? '', config)
    if (!slice) {
      continue
    }
    const key = slice.start.toISOString()
    const existing = groups.get(key)
    if (existing) {
      existing.results.push(result)
    } else {
      groups.set(key, { ...slice, results: [result] })
    }
  }
  return [...groups.values()].sort((left, right) => left.start.getTime() - right.start.getTime())
}

function latestResult(results: ScrapeResult[]): ScrapeResult {
  return results.reduce((latest, current) => {
    const latestTime = Date.parse(latest.occurredAt ?? '')
    const currentTime = Date.parse(current.occurredAt ?? '')
    if (currentTime !== latestTime) {
      return currentTime > latestTime ? current : latest
    }
    return current.id > latest.id ? current : latest
  })
}

/**
 * 窗口展示编号由「分组 + 本地窗口起点」派生，不依赖结果到达顺序：
 * 后到的更早结果不会改写已有窗口编号，刷新后也保持一致。
 */
function windowLabel(config: MetricConfig, start: Date): string {
  const pad = (value: number) => (value < 10 ? `0${value}` : String(value))
  const date = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`
  if (config.granularity === 'month') {
    return `${config.windowGroup}#${start.getFullYear()}-${pad(start.getMonth() + 1)}`
  }
  if (config.granularity === 'day') {
    return `${config.windowGroup}#${date}`
  }
  return `${config.windowGroup}#${date} ${pad(start.getHours())}:${pad(start.getMinutes())}`
}

function syncAlertLedger(next: MonitorState, alert: AlertRecord): void {
  const id = alertLedgerKey(alert.id)
  if (next.ledger.some((entry) => entry.id === id)) {
    return
  }
  next.ledger.push({
    id,
    alertId: alert.id,
    batchId: alert.batchId,
    kind: '告警',
    title: `${alert.metricName} 触发预警（${alert.windowLabel}）`,
    taskCode: alert.taskCode,
    metricCode: alert.metricCode,
    windowId: alert.windowId,
    windowLabel: alert.windowLabel,
    windowStart: alert.windowStart,
    windowEnd: alert.windowEnd,
    recordedValue: alert.recordedValue,
    threshold: alert.threshold,
    thresholdVersion: alert.thresholdVersion,
    severity: alert.severity,
    status: alert.status,
    createdAt: alert.createdAt,
    note: `告警锁定触发时窗口峰值 ${alert.recordedValue}，阈值 ${alert.threshold}（v${alert.thresholdVersion}）`,
  })
}

function findSilenceCandidate(
  alerts: AlertRecord[],
  config: MetricConfig,
  windowStart: string,
): AlertRecord | null {
  const startMs = Date.parse(windowStart)
  const silenceMs = Math.max(0, config.silenceMinutes) * 60_000
  let candidate: AlertRecord | null = null
  for (const alert of alerts) {
    const alertStart = Date.parse(alert.windowStart)
    if (alertStart < startMs && startMs < alertStart + silenceMs) {
      if (!candidate || alertStart > Date.parse(candidate.windowStart)) {
        candidate = alert
      }
    }
  }
  return candidate
}

function evaluateAlerts(next: MonitorState, now: string): {
  created: AlertRecord[]
  reused: AlertRecord[]
  suppressed: MonitorWindow[]
  createdWindows: MonitorWindow[]
} {
  const created: AlertRecord[] = []
  const reused: AlertRecord[] = []
  const suppressed: MonitorWindow[] = []
  const createdWindows: MonitorWindow[] = []

  const configs = Object.values(next.configs).filter((config) => config.enabled)
  for (const config of configs) {
    const metricWindows = Object.values(next.windows)
      .filter((window) => window.metricCode === config.code)
      .sort((left, right) => Date.parse(left.start) - Date.parse(right.start))
    if (!metricWindows.length) {
      continue
    }

    // 同一指标的告警按窗口开始时间排序；同一窗口的告警键唯一，天然幂等。
    const metricAlerts = Object.values(next.alerts)
      .filter((alert) => alert.metricCode === config.code)
      .sort((left, right) => Date.parse(left.windowStart) - Date.parse(right.windowStart))

    for (const window of metricWindows) {
      const existingAlert = next.alerts[alertKey(window)]
      if (existingAlert) {
        window.status = '已告警'
        window.alertId = existingAlert.id
        syncAlertLedger(next, existingAlert)
        reused.push(existingAlert)
        continue
      }

      if (window.peakAbnormal < window.threshold) {
        window.status = '正常'
        window.alertId = null
        window.suppressReason = ''
        continue
      }

      const silenceCandidate = findSilenceCandidate(metricAlerts, config, window.start)
      if (silenceCandidate) {
        window.status = '静默抑制'
        window.alertId = null
        window.suppressedCount = Math.max(window.suppressedCount, 1)
        window.suppressReason = `落在 ${silenceCandidate.batchId} 的 ${config.silenceMinutes} 分钟静默窗口内，未重复生成告警`
        suppressed.push(window)
        continue
      }

      // 告警锁定值取首次触发时的窗口峰值（峰值发生过就不会被后续回落覆盖）。
      const alert: AlertRecord = {
        id: alertKey(window),
        batchId: batchKey(window),
        metricCode: config.code,
        metricName: config.name,
        taskCode: window.taskCode,
        windowId: window.id,
        windowLabel: window.label,
        windowStart: window.start,
        windowEnd: window.end,
        threshold: window.threshold,
        thresholdVersion: window.thresholdVersion,
        recordedValue: window.peakAbnormal,
        peakAbnormal: window.peakAbnormal,
        severity: config.severity,
        channel: config.channel,
        status: '待处理',
        createdAt: now,
        updatedAt: now,
        note: `窗口峰值 ${window.peakAbnormal} 达到阈值 ${window.threshold}（v${window.thresholdVersion}）`,
      }
      next.alerts[alert.id] = alert
      metricAlerts.push(alert)
      metricAlerts.sort((left, right) => Date.parse(left.windowStart) - Date.parse(right.windowStart))
      window.status = '已告警'
      window.alertId = alert.id
      window.suppressReason = ''
      created.push(alert)
      syncAlertLedger(next, alert)
    }
  }

  return { created, reused, suppressed, createdWindows }
}

export type EvaluateOutcome = {
  state: MonitorState
  summary: RefreshSummary
  createdWindows: MonitorWindow[]
}

/**
 * 重新计算全部指标时间窗并评估告警。
 * - 时间窗的采集量 / 异常量 / 成功量始终从持久化的采集结果重新汇总；
 * - 窗口当前值取窗口内最新快照，峰值取窗口内全部快照的最大异常量；
 * - 已存在的告警不重算锁定值，刷新与重新进入保持同一告警记录。
 */
export function evaluateMonitor(state: MonitorState, now: string): EvaluateOutcome {
  const next = cloneState(state)
  const createdWindowsMap = new Map<string, MonitorWindow>()

  for (const config of Object.values(next.configs)) {
    const metricResults = next.results.filter((result) => result.metricCode === config.code)
    const groups = groupResults(config, metricResults)

    for (const group of groups) {
      const id = windowKey(config, group.start)
      const existing = next.windows[id]
      const latest = latestResult(group.results)
      const peakAbnormal = Math.max(...group.results.map((result) => result.abnormal))
      const latestTime = latest.occurredAt ?? ''
      const revision = existing
        ? { version: existing.thresholdVersion, threshold: existing.threshold }
        : thresholdRevisionAt(config, group.start.toISOString())

      const window: MonitorWindow = {
        id,
        label: existing?.label ?? windowLabel(config, group.start),
        metricCode: config.code,
        taskCode: config.taskCode,
        granularity: config.granularityLabel,
        start: group.start.toISOString(),
        end: group.end.toISOString(),
        boundaryRule: group.rule,
        collected: latest.collected,
        success: latest.success,
        abnormal: latest.abnormal,
        peakAbnormal,
        observationCount: group.results.length,
        latestResultId: latest.id,
        latestObservedAt: latestTime,
        threshold: revision.threshold,
        thresholdVersion: revision.version,
        status: existing?.status ?? '正常',
        alertId: existing?.alertId ?? null,
        suppressedCount: existing?.suppressedCount ?? 0,
        suppressReason: existing?.suppressReason ?? '',
        firstEvaluatedAt: existing?.firstEvaluatedAt ?? now,
        lastEvaluatedAt: now,
      }
      next.windows[id] = window
      if (!existing) {
        createdWindowsMap.set(id, window)
      }
    }
  }

  const alertOutcome = evaluateAlerts(next, now)

  return {
    state: next,
    summary: {
      windows: Object.values(next.windows),
      createdAlerts: alertOutcome.created,
      reusedAlerts: alertOutcome.reused,
      suppressedWindows: alertOutcome.suppressed,
    },
    createdWindows: [...createdWindowsMap.values()],
  }
}

// ---------------------------------------------------------------------------
// 采集结果入库
// ---------------------------------------------------------------------------

export type ScrapeResultInput = {
  metricCode: string
  occurredAt?: string | null
  collected: number
  success: number
  abnormal: number
  dedupeKey?: string
  note?: string
}

export type IngestOutcome = {
  state: MonitorState
  accepted: ScrapeResult[]
  rejected: { input: ScrapeResultInput; reason: string }[]
  summary: RefreshSummary
}

function normalizeTimestamp(raw: string | null | undefined): { value: string | null; missing: boolean } {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { value: null, missing: true }
  }
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) {
    return { value: null, missing: true }
  }
  return { value: parsed.toISOString(), missing: false }
}

function autoDedupeKey(input: ScrapeResultInput, occurredAt: string | null): string {
  return [
    input.metricCode,
    occurredAt ?? 'missing-timestamp',
    input.collected,
    input.success,
    input.abnormal,
  ].join('|')
}

function validateNumbers(input: ScrapeResultInput): string | null {
  for (const key of ['collected', 'success', 'abnormal'] as const) {
    const value = input[key]
    if (!Number.isFinite(value) || value < 0) {
      return `${key} 必须是非负数字`
    }
  }
  return null
}

/**
 * 一批采集结果一次性入库并重新评估。
 * 同一指标、同一窗口、同一 dedupeKey 的并发提交只会落一条结果；
 * 告警键由「指标 + 窗口开始」派生，因此并发提交也只会生成一条活跃告警。
 */
export function ingestScrapeResults(
  state: MonitorState,
  inputs: ScrapeResultInput[],
  now: string,
): IngestOutcome {
  const next = cloneState(state)
  const accepted: ScrapeResult[] = []
  const rejected: { input: ScrapeResultInput; reason: string }[] = []
  const knownKeys = new Set(
    next.results
      .map((result) => result.dedupeKey)
      .filter((key): key is string => Boolean(key)),
  )

  for (const input of inputs) {
    const config = next.configs[input.metricCode]
    if (!config) {
      rejected.push({ input, reason: `没有登记编号为 ${input.metricCode} 的监控指标` })
      continue
    }
    if (!config.enabled) {
      rejected.push({ input, reason: `监控指标 ${input.metricCode} 未启用，结果不进入时间窗` })
      continue
    }
    const numberError = validateNumbers(input)
    if (numberError) {
      rejected.push({ input, reason: numberError })
      continue
    }
    const timestamp = normalizeTimestamp(input.occurredAt)
    const dedupeKey = input.dedupeKey?.trim() || autoDedupeKey(input, timestamp.value)
    if (knownKeys.has(dedupeKey)) {
      rejected.push({ input, reason: `重复提交已被幂等丢弃：${dedupeKey}` })
      continue
    }

    const result: ScrapeResult = {
      id: next.nextResultId,
      metricCode: config.code,
      taskCode: config.taskCode,
      occurredAt: timestamp.value,
      collected: input.collected,
      success: input.success,
      abnormal: input.abnormal,
      dedupeKey,
      note: timestamp.missing
        ? input.note?.trim() || '缺少时间戳，未进入任何指标时间窗，单独汇总说明'
        : input.note?.trim() || '',
    }
    next.nextResultId += 1
    knownKeys.add(dedupeKey)
    next.results.push(result)
    accepted.push(result)
  }

  const evaluated = evaluateMonitor(next, now)
  return { state: evaluated.state, accepted, rejected, summary: evaluated.summary }
}

// ---------------------------------------------------------------------------
// 待处理台账
// ---------------------------------------------------------------------------

export function resolveAlert(state: MonitorState, alertId: string, handledAt: string): MonitorState {
  const next = cloneState(state)
  const alert = next.alerts[alertId]
  if (!alert) {
    throw new Error(`没有找到编号为 ${alertId} 的告警记录`)
  }
  alert.status = '已处理'
  alert.updatedAt = handledAt
  const ledger = next.ledger.find((entry) => entry.id === alertLedgerKey(alertId))
  if (ledger) {
    ledger.status = '已处理'
    ledger.handledAt = handledAt
    ledger.note = `${ledger.note}；已于 ${handledAt} 标记处理`
  }
  return next
}

export function resolveLedgerEntry(state: MonitorState, entryId: string, handledAt: string): MonitorState {
  const next = cloneState(state)
  const entry = next.ledger.find((item) => item.id === entryId)
  if (!entry) {
    throw new Error(`没有找到编号为 ${entryId} 的待处理台账条目`)
  }
  if (entry.status === '已处理') {
    return next
  }
  entry.status = '已处理'
  entry.handledAt = handledAt
  if (entry.alertId && next.alerts[entry.alertId]) {
    const alert = next.alerts[entry.alertId]
    alert.status = '已处理'
    alert.updatedAt = handledAt
  }
  return next
}

export type TaskStatusChangeInput = {
  taskCode: string
  fromStatus: string
  toStatus: string
  action: string
  note?: string
}

/** 采集任务状态变化写入待处理台账；台账与告警批次一样持久化，刷新后仍在。 */
export function recordTaskStatusChange(
  state: MonitorState,
  input: TaskStatusChangeInput,
  now: string,
): MonitorState {
  const next = cloneState(state)
  const seq = next.nextLedgerSeq
  next.nextLedgerSeq += 1
  const entry: LedgerEntry = {
    id: `LEDGER:TASK:${seq}`,
    batchId: `BATCH:TASK:${input.taskCode}:${seq}`,
    kind: '任务状态',
    title: `${input.taskCode} 状态变更：${input.fromStatus} → ${input.toStatus}`,
    taskCode: input.taskCode,
    status: '待处理',
    createdAt: now,
    note: input.note?.trim() || `由「${input.action}」动作写入`,
  }
  next.ledger.push(entry)
  return next
}

/** 缺失时间戳的结果单独汇总，明确不参与任何窗口、不按 0 值计入统计。 */
export function missingTimestampSummary(state: MonitorState): MissingTimestampSummary[] {
  const groups = new Map<string, MissingTimestampSummary>()
  for (const result of state.results) {
    if (result.occurredAt) {
      continue
    }
    const existing = groups.get(result.metricCode)
    if (existing) {
      existing.resultCount += 1
      existing.collected += result.collected
      existing.success += result.success
      existing.abnormal += result.abnormal
      existing.resultIds.push(result.id)
    } else {
      const config = state.configs[result.metricCode]
      groups.set(result.metricCode, {
        metricCode: result.metricCode,
        taskCode: result.taskCode,
        resultCount: 1,
        collected: result.collected,
        success: result.success,
        abnormal: result.abnormal,
        resultIds: [result.id],
        note: `指标 ${result.metricCode} 有 1 条采集结果缺少可解析的时间戳，未进入任何时间窗，也未按 0 值计入窗口统计；请补录 ${config?.name ?? '该指标'} 的采集时间后重新刷新。`,
      })
    }
  }
  for (const summary of groups.values()) {
    summary.note = `指标 ${summary.metricCode} 有 ${summary.resultCount} 条采集结果缺少可解析的时间戳，独立列出：采集量 ${summary.collected}、成功量 ${summary.success}、异常量 ${summary.abnormal}；未进入任何时间窗，也未按 0 值计入窗口统计。`
  }
  return [...groups.values()]
}
