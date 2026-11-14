import type { MetricConfig, MonitorState, ScrapeResult } from './monitor-types'

/**
 * 监控示例数据：覆盖三类验收场景
 * 1. MONI-71（10 分钟窗口）09:00-09:10 异常量先到 120 再回落到 18，告警锁定峰值 120；
 * 2. WIN-09 分组（15 分钟窗口）08:00-08:15 为 4 条、08:15-08:30 为 55 条，两段各自告警；
 * 3. MONI-73（5 分钟窗口、静默 20 分钟）连续两个窗口超阈值，第二个被静默抑制。
 * 另有一条缺少时间戳的结果挂在 MONI-71 上，用于验证单独汇总、不按 0 值入窗。
 */

const SEED_YEAR = 2026
const SEED_MONTH = 10 // 11 月
const SEED_DAY = 14

function at(hour: number, minute: number, second = 0): string {
  return new Date(SEED_YEAR, SEED_MONTH, SEED_DAY, hour, minute, second, 0).toISOString()
}

function revisionFrom(): string {
  return new Date(SEED_YEAR, SEED_MONTH, 1, 0, 0, 0, 0).toISOString()
}

function config(
  partial: Omit<MetricConfig, 'thresholdVersion' | 'thresholdHistory'>,
): MetricConfig {
  return {
    ...partial,
    thresholdVersion: 1,
    thresholdHistory: [
      { version: 1, threshold: partial.threshold, effectiveFrom: revisionFrom() },
    ],
  }
}

export const SEED_METRIC_CONFIGS: MetricConfig[] = [
  config({
    code: 'MONI-71',
    rowId: 1,
    name: '采集异常量',
    taskCode: 'SPID-0003',
    threshold: 100,
    granularity: 'minute',
    granularityMinutes: 10,
    granularityLabel: '10 分钟',
    silenceMinutes: 30,
    severity: '严重',
    channel: '企业微信',
    windowGroup: 'WIN-71',
    enabled: true,
  }),
  config({
    code: 'MONI-72',
    rowId: 2,
    name: '采集异常量',
    taskCode: 'SPID-0002',
    threshold: 3,
    granularity: 'minute',
    granularityMinutes: 15,
    granularityLabel: '15 分钟',
    silenceMinutes: 0,
    severity: '警告',
    channel: '钉钉',
    windowGroup: 'WIN-09',
    enabled: true,
  }),
  config({
    code: 'MONI-73',
    rowId: 3,
    name: '采集异常量',
    taskCode: 'SPID-0001',
    threshold: 10,
    granularity: 'minute',
    granularityMinutes: 5,
    granularityLabel: '5 分钟',
    silenceMinutes: 20,
    severity: '提示',
    channel: '邮件',
    windowGroup: 'WIN-73',
    enabled: true,
  }),
]

type SeedResult = Omit<ScrapeResult, 'id' | 'taskCode'> & { taskCode?: string }

const CONFIG_BY_CODE = new Map(SEED_METRIC_CONFIGS.map((item) => [item.code, item]))

const RAW_RESULTS: SeedResult[] = [
  // MONI-71：同一 10 分钟窗口内先升后降，峰值 120、窗口当前值 18。
  {
    metricCode: 'MONI-71',
    occurredAt: at(9, 0, 12),
    collected: 1320,
    success: 1200,
    abnormal: 120,
    dedupeKey: 'seed:MONI-71:0900:A',
    note: '09:00 窗口首个快照',
  },
  {
    metricCode: 'MONI-71',
    occurredAt: at(9, 7, 30),
    collected: 1540,
    success: 1522,
    abnormal: 18,
    dedupeKey: 'seed:MONI-71:0900:B',
    note: '09:00 窗口回落后的快照',
  },
  // WIN-09：两段 15 分钟窗口分别超阈值（4 条、55 条）。
  {
    metricCode: 'MONI-72',
    occurredAt: at(8, 3, 5),
    collected: 210,
    success: 206,
    abnormal: 4,
    dedupeKey: 'seed:MONI-72:0800:A',
  },
  {
    metricCode: 'MONI-72',
    occurredAt: at(8, 12, 40),
    collected: 280,
    success: 276,
    abnormal: 4,
    dedupeKey: 'seed:MONI-72:0800:B',
  },
  {
    metricCode: 'MONI-72',
    occurredAt: at(8, 18, 10),
    collected: 720,
    success: 665,
    abnormal: 55,
    dedupeKey: 'seed:MONI-72:0815:A',
  },
  {
    metricCode: 'MONI-72',
    occurredAt: at(8, 27, 50),
    collected: 810,
    success: 755,
    abnormal: 55,
    dedupeKey: 'seed:MONI-72:0815:B',
  },
  // MONI-73：两个相邻 5 分钟窗口都超阈值，后者应被静默窗口抑制。
  {
    metricCode: 'MONI-73',
    occurredAt: at(10, 0, 20),
    collected: 96,
    success: 84,
    abnormal: 12,
    dedupeKey: 'seed:MONI-73:1000',
  },
  {
    metricCode: 'MONI-73',
    occurredAt: at(10, 6, 15),
    collected: 110,
    success: 96,
    abnormal: 14,
    dedupeKey: 'seed:MONI-73:1005',
  },
  // 缺少时间戳：不进入任何时间窗，单独说明。
  {
    metricCode: 'MONI-71',
    occurredAt: null,
    collected: 40,
    success: 36,
    abnormal: 4,
    dedupeKey: 'seed:MONI-71:missing',
    note: '上游回调未带采集时间',
  },
]

export const SEED_SCRAPE_RESULTS: ScrapeResult[] = RAW_RESULTS.map((item, index) => {
  const metricConfig = CONFIG_BY_CODE.get(item.metricCode)
  return {
    id: index + 1,
    metricCode: item.metricCode,
    taskCode: item.taskCode ?? metricConfig?.taskCode ?? '',
    occurredAt: item.occurredAt,
    collected: item.collected,
    success: item.success,
    abnormal: item.abnormal,
    dedupeKey: item.dedupeKey,
    note: item.note ?? '',
  }
})

export function createSeedMonitorState(): MonitorState {
  return {
    version: 1,
    configs: Object.fromEntries(
      SEED_METRIC_CONFIGS.map((item) => [item.code, JSON.parse(JSON.stringify(item)) as MetricConfig]),
    ),
    results: JSON.parse(JSON.stringify(SEED_SCRAPE_RESULTS)) as ScrapeResult[],
    windows: {},
    alerts: {},
    ledger: [],
    nextResultId: SEED_SCRAPE_RESULTS.length + 1,
    nextLedgerSeq: 1,
    createdAt: new Date().toISOString(),
  }
}
