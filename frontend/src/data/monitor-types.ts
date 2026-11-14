/** 采集监控领域模型：指标配置、采集结果快照、指标时间窗、告警与待处理台账。 */

export type GranularityKind = 'minute' | 'hour' | 'day' | 'month'

export type MetricConfig = {
  /** 指标编号，例如 MONI-71（与采集监控模块的「指标编号」一致） */
  code: string
  rowId: number
  name: string
  /** 关联任务，对应采集任务的「作业编号」 */
  taskCode: string
  threshold: number
  /** 每调整一次阈值 +1；时间窗按创建时生效的版本快照，不回写历史 */
  thresholdVersion: number
  thresholdHistory: ThresholdRevision[]
  granularity: GranularityKind
  /** 分钟 / 小时的步长；自然日、自然月为 null */
  granularityMinutes: number | null
  granularityLabel: string
  silenceMinutes: number
  severity: string
  channel: string
  /** 窗口展示分组，例如 WIN-09；窗口编号在分组内顺序递增 */
  windowGroup: string
  enabled: boolean
}

export type ThresholdRevision = {
  version: number
  threshold: number
  effectiveFrom: string
}

/**
 * 一条采集结果快照。采集量 / 成功量 / 异常量都是「截至该时刻的窗口累计值」，
 * 同一时间窗内有多条快照时，窗口当前值取最新一条，峰值单独保留。
 */
export type ScrapeResult = {
  id: number
  metricCode: string
  taskCode: string
  /** ISO 时间；空字符串或非法值代表缺失时间戳，不进入任何时间窗 */
  occurredAt: string | null
  collected: number
  success: number
  abnormal: number
  /** 并发提交 / 幂等重放使用；同一指标同一键只落一条结果 */
  dedupeKey?: string
  note?: string
}

export type WindowStatus = '正常' | '已告警' | '静默抑制'

export type MonitorWindow = {
  /** 稳定主键：WIN:<指标编号>:<本地窗口开始时间> */
  id: string
  /** 展示编号，例如 WIN-09#1 / WIN-09#2 */
  label: string
  metricCode: string
  taskCode: string
  granularity: string
  start: string
  end: string
  boundaryRule: string
  /** 窗口当前快照 */
  collected: number
  success: number
  abnormal: number
  /** 窗口内观测到的异常量峰值；告警记录以首次触发时的峰值为准 */
  peakAbnormal: number
  observationCount: number
  latestResultId: number | null
  latestObservedAt: string | null
  /** 窗口创建时的阈值快照，后续调整阈值不影响本行 */
  threshold: number
  thresholdVersion: number
  status: WindowStatus
  alertId: string | null
  /** 静默窗口内被抑制的重复告警次数 */
  suppressedCount: number
  suppressReason: string
  firstEvaluatedAt: string
  lastEvaluatedAt: string
}

export type AlertStatus = '待处理' | '已处理'

export type AlertRecord = {
  id: string
  /** 告警批次号；刷新、重新进入页面都保持同一个批次 */
  batchId: string
  metricCode: string
  metricName: string
  taskCode: string
  windowId: string
  windowLabel: string
  windowStart: string
  windowEnd: string
  /** 触发时的阈值快照，阈值调整后仍保留原值 */
  threshold: number
  thresholdVersion: number
  /** 告警锁定值：首次触发时间窗内的异常量峰值，不回写成当前值 */
  recordedValue: number
  peakAbnormal: number
  severity: string
  channel: string
  status: AlertStatus
  createdAt: string
  updatedAt: string
  note: string
}

export type LedgerKind = '告警' | '任务状态'

export type LedgerEntry = {
  id: string
  /** 告警来源条目回指告警编号，处理台账时同步告警状态 */
  alertId?: string
  batchId: string
  kind: LedgerKind
  title: string
  taskCode: string
  metricCode?: string
  windowId?: string
  windowLabel?: string
  windowStart?: string
  windowEnd?: string
  /** 告警锁定值；不会随窗口当前异常量变化 */
  recordedValue?: number
  threshold?: number
  thresholdVersion?: number
  severity?: string
  status: AlertStatus
  createdAt: string
  handledAt?: string
  note: string
}

export type MonitorState = {
  version: number
  /** 指标编号 -> 指标配置（阈值版本历史在这里累积） */
  configs: Record<string, MetricConfig>
  results: ScrapeResult[]
  /** 窗口稳定主键 -> 窗口 */
  windows: Record<string, MonitorWindow>
  /** 告警批次号 -> 告警 */
  alerts: Record<string, AlertRecord>
  ledger: LedgerEntry[]
  nextResultId: number
  nextLedgerSeq: number
  createdAt: string
}

export type MissingTimestampSummary = {
  metricCode: string
  taskCode: string
  resultCount: number
  collected: number
  success: number
  abnormal: number
  resultIds: number[]
  note: string
}

export type MonitorDashboard = {
  configs: MetricConfig[]
  windows: MonitorWindow[]
  alerts: AlertRecord[]
  missingTimestamps: MissingTimestampSummary[]
  activeAlertCount: number
}

export type RefreshSummary = {
  windows: MonitorWindow[]
  createdAlerts: AlertRecord[]
  reusedAlerts: AlertRecord[]
  suppressedWindows: MonitorWindow[]
}
