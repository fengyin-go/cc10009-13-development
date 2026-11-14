/**
 * 采集监控领域回归测试（零依赖，node --experimental-strip-types 直接跑）。
 * 覆盖：时间窗统计、告警锁定峰值、静默窗口、并发幂等、阈值版本、跨日/月末边界、缺失时间戳、台账持久化。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  evaluateMonitor,
  ingestScrapeResults,
  missingTimestampSummary,
  recordTaskStatusChange,
  resolveAlert,
  resolveLedgerEntry,
  reviseThreshold,
} from '../src/data/monitor-engine.ts'
import { createSeedMonitorState } from '../src/data/monitor-seed.ts'
import type { MetricConfig, MonitorState } from '../src/data/monitor-types.ts'

const NOW = '2026-11-14T20:30:00.000Z'

/** 按运行机器的本地日历构造时间，断言不依赖时区。 */
function local(year: number, month: number, day: number, hour: number, minute: number): string {
  return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString()
}

function localLabel(date: Date): string {
  const pad = (value: number) => (value < 10 ? `0${value}` : String(value))
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function emptyState(): MonitorState {
  return {
    version: 1,
    configs: {},
    results: [],
    windows: {},
    alerts: {},
    ledger: [],
    nextResultId: 1,
    nextLedgerSeq: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
  }
}

function config(
  code: string,
  overrides: Partial<MetricConfig> = {},
): MetricConfig {
  const threshold = overrides.threshold ?? 5
  return {
    code,
    rowId: 1,
    name: code,
    taskCode: 'SPID-T',
    threshold,
    thresholdVersion: 1,
    thresholdHistory: [{ version: 1, threshold, effectiveFrom: '2026-10-01T00:00:00.000Z' }],
    granularity: 'minute',
    granularityMinutes: 10,
    granularityLabel: '10 分钟',
    silenceMinutes: 0,
    severity: '警告',
    channel: '邮件',
    windowGroup: `WIN-${code}`,
    enabled: true,
    ...overrides,
  }
}

function windowByLabel(state: MonitorState, label: string) {
  const window = Object.values(state.windows).find((item) => item.label === label)
  assert.ok(window, `缺少时间窗 ${label}`)
  return window
}

test('MONI-71 在 09:00-09:10 先升后降，告警锁定峰值 120 而非回落的 18', () => {
  const outcome = evaluateMonitor(createSeedMonitorState(), NOW)
  const window = windowByLabel(outcome.state, 'WIN-71#2026-11-14 09:00')
  assert.equal(window.peakAbnormal, 120)
  assert.equal(window.abnormal, 18)
  assert.equal(window.collected, 1540)
  assert.equal(window.success, 1522)
  assert.equal(window.status, '已告警')

  const alert = Object.values(outcome.state.alerts).find((item) => item.metricCode === 'MONI-71')
  assert.ok(alert)
  assert.equal(alert.recordedValue, 120)
  assert.equal(alert.threshold, 100)

  // 台账跟随告警锁定值，不能随窗口当前异常量回写成 18。
  const ledger = outcome.state.ledger.find((entry) => entry.alertId === alert.id)
  assert.ok(ledger)
  assert.equal(ledger.recordedValue, 120)
  assert.match(ledger.note, /120/)
})

test('WIN-09 的 08:00-08:15（4 条）与 08:15-08:30（55 条）各自落地告警', () => {
  const outcome = evaluateMonitor(createSeedMonitorState(), NOW)
  const first = windowByLabel(outcome.state, 'WIN-09#2026-11-14 08:00')
  const second = windowByLabel(outcome.state, 'WIN-09#2026-11-14 08:15')
  assert.equal(first.abnormal, 4)
  assert.equal(second.abnormal, 55)
  assert.notEqual(first.alertId, second.alertId)

  const firstAlert = outcome.state.alerts[first.alertId as string]
  const secondAlert = outcome.state.alerts[second.alertId as string]
  assert.equal(firstAlert.recordedValue, 4)
  assert.equal(secondAlert.recordedValue, 55)
  assert.equal(outcome.state.ledger.filter((entry) => entry.kind === '告警').length >= 2, true)
})

test('静默窗口内不重复告警', () => {
  const outcome = evaluateMonitor(createSeedMonitorState(), NOW)
  const silenced = windowByLabel(outcome.state, 'WIN-73#2026-11-14 10:05')
  assert.equal(silenced.status, '静默抑制')
  assert.equal(silenced.alertId, null)
  assert.match(silenced.suppressReason, /静默/)

  const alerts = Object.values(outcome.state.alerts).filter((item) => item.metricCode === 'MONI-73')
  assert.equal(alerts.length, 1)
})

test('刷新与重新进入复用同一告警批次，台账不重复', () => {
  const first = evaluateMonitor(createSeedMonitorState(), NOW)
  const second = evaluateMonitor(first.state, NOW)
  const third = evaluateMonitor(second.state, NOW)

  assert.deepEqual(Object.keys(third.state.alerts).sort(), Object.keys(first.state.alerts).sort())
  assert.equal(third.summary.createdAlerts.length, 0)
  assert.equal(third.state.ledger.length, first.state.ledger.length)
  assert.deepEqual(third.state.ledger.map((entry) => entry.batchId), first.state.ledger.map((entry) => entry.batchId))
})

test('同一指标并发提交只生成一条活跃告警', () => {
  const state = emptyState()
  state.configs.C = config('C')
  const outcome = ingestScrapeResults(
    state,
    [
      { metricCode: 'C', occurredAt: local(2026, 11, 14, 9, 0), collected: 50, success: 45, abnormal: 6, dedupeKey: 'same' },
      { metricCode: 'C', occurredAt: local(2026, 11, 14, 9, 0), collected: 50, success: 45, abnormal: 6, dedupeKey: 'same' },
    ],
    NOW,
  )
  assert.equal(outcome.accepted.length, 1)
  assert.equal(outcome.rejected.length, 1)
  assert.equal(Object.keys(outcome.state.alerts).length, 1)
  assert.equal(Object.keys(outcome.state.windows).length, 1)
})

test('阈值调整只对之后的时间窗生效，已生成的告警与台账保留原阈值', () => {
  const state = emptyState()
  state.configs.T = config('T', { threshold: 5 })
  const first = ingestScrapeResults(
    state,
    [{ metricCode: 'T', occurredAt: local(2026, 11, 14, 9, 0), collected: 100, success: 90, abnormal: 9, dedupeKey: 't-0900' }],
    local(2026, 11, 14, 9, 5),
  )
  const revised = reviseThreshold(first.state, 'T', 50, local(2026, 11, 14, 9, 20))
  const second = ingestScrapeResults(
    revised,
    [{ metricCode: 'T', occurredAt: local(2026, 11, 14, 9, 20), collected: 100, success: 85, abnormal: 15, dedupeKey: 't-0920' }],
    local(2026, 11, 14, 9, 25),
  )

  const oldWindow = windowByLabel(second.state, 'WIN-T#2026-11-14 09:00')
  const newWindow = windowByLabel(second.state, 'WIN-T#2026-11-14 09:20')
  assert.equal(oldWindow.threshold, 5)
  assert.equal(oldWindow.thresholdVersion, 1)
  assert.equal(newWindow.threshold, 50)
  assert.equal(newWindow.thresholdVersion, 2)
  assert.equal(newWindow.status, '正常')

  const oldAlert = Object.values(second.state.alerts).find((item) => item.windowId === oldWindow.id)
  assert.ok(oldAlert)
  assert.equal(oldAlert.threshold, 5)
  assert.equal(oldAlert.recordedValue, 9)

  const oldLedger = second.state.ledger.find((entry) => entry.windowId === oldWindow.id)
  assert.ok(oldLedger)
  assert.equal(oldLedger.threshold, 5)
})

test('日 / 月窗口在跨日与月末给出稳定边界', () => {
  const state = emptyState()
  state.configs.D = config('D', { granularity: 'day', granularityMinutes: null, windowGroup: 'WIN-D' })
  state.configs.M = config('M', { granularity: 'month', granularityMinutes: null, windowGroup: 'WIN-M' })
  state.configs.X = config('X', { granularity: 'minute', granularityMinutes: 30, windowGroup: 'WIN-X' })

  const outcome = ingestScrapeResults(
    state,
    [
      { metricCode: 'D', occurredAt: local(2026, 10, 31, 23, 30), collected: 5, success: 5, abnormal: 0, dedupeKey: 'd1' },
      { metricCode: 'D', occurredAt: local(2026, 11, 1, 0, 10), collected: 7, success: 7, abnormal: 0, dedupeKey: 'd2' },
      { metricCode: 'M', occurredAt: local(2026, 10, 31, 12, 0), collected: 1, success: 1, abnormal: 0, dedupeKey: 'm1' },
      { metricCode: 'M', occurredAt: local(2026, 11, 2, 12, 0), collected: 2, success: 2, abnormal: 0, dedupeKey: 'm2' },
      { metricCode: 'X', occurredAt: local(2026, 11, 14, 23, 57), collected: 3, success: 3, abnormal: 0, dedupeKey: 'x1' },
    ],
    NOW,
  )

  const days = Object.values(outcome.state.windows)
    .filter((item) => item.metricCode === 'D')
    .sort((left, right) => Date.parse(left.start) - Date.parse(right.start))
  assert.equal(days.length, 2, '跨日的两条结果必须落在两个自然日窗口')
  assert.equal(localLabel(new Date(days[0].start)), '2026-10-31 00:00')
  assert.equal(localLabel(new Date(days[0].end)), '2026-11-01 00:00')
  assert.equal(localLabel(new Date(days[1].start)), '2026-11-01 00:00')
  assert.equal(days[0].collected, 5)
  assert.equal(days[1].collected, 7)

  const months = Object.values(outcome.state.windows)
    .filter((item) => item.metricCode === 'M')
    .sort((left, right) => Date.parse(left.start) - Date.parse(right.start))
  assert.equal(months.length, 2)
  assert.equal(localLabel(new Date(months[0].start)), '2026-10-01 00:00')
  assert.equal(localLabel(new Date(months[0].end)), '2026-11-01 00:00')
  assert.equal(localLabel(new Date(months[1].start)), '2026-11-01 00:00')
  assert.equal(localLabel(new Date(months[1].end)), '2026-12-01 00:00')

  const lateNight = Object.values(outcome.state.windows).find((item) => item.metricCode === 'X')
  assert.ok(lateNight)
  assert.equal(localLabel(new Date(lateNight.start)), '2026-11-14 23:30')
  assert.equal(localLabel(new Date(lateNight.end)), '2026-11-15 00:00')
  assert.equal(Date.parse(lateNight.end) - Date.parse(lateNight.start), 30 * 60 * 1000)
})

test('缺失时间戳的结果单独汇总，不按 0 值计入时间窗', () => {
  const state = emptyState()
  state.configs.T = config('T')
  const outcome = ingestScrapeResults(
    state,
    [
      { metricCode: 'T', occurredAt: '', collected: 40, success: 36, abnormal: 4, dedupeKey: 'miss' },
      { metricCode: 'T', occurredAt: 'not-a-date', collected: 10, success: 8, abnormal: 2, dedupeKey: 'bad' },
    ],
    NOW,
  )
  assert.equal(Object.keys(outcome.state.windows).length, 0)
  const summary = missingTimestampSummary(outcome.state)
  assert.equal(summary.length, 1)
  assert.equal(summary[0].resultCount, 2)
  assert.equal(summary[0].collected, 50)
  assert.equal(summary[0].abnormal, 6)
  assert.match(summary[0].note, /未按 0 值/)
})

test('采集任务状态变化写入持久化待处理台账，并与告警台账独立', () => {
  const outcome = evaluateMonitor(createSeedMonitorState(), NOW)
  const withTask = recordTaskStatusChange(
    outcome.state,
    { taskCode: 'SPID-0003', fromStatus: '运行中', toStatus: '已失败', action: '终止采集' },
    '2026-11-14T20:37:00.000Z',
  )
  const taskEntry = withTask.ledger.find((entry) => entry.kind === '任务状态')
  assert.ok(taskEntry)
  assert.equal(taskEntry.status, '待处理')
  assert.match(taskEntry.batchId, /BATCH:TASK:SPID-0003/)

  // 重新评估不会把任务台账冲掉，也不会重复写入。
  const refreshed = evaluateMonitor(withTask, '2026-11-14T20:38:00.000Z')
  assert.equal(refreshed.state.ledger.filter((entry) => entry.kind === '任务状态').length, 1)

  const resolved = resolveLedgerEntry(refreshed.state, taskEntry.id, '2026-11-14T20:39:00.000Z')
  assert.equal(resolved.ledger.find((entry) => entry.id === taskEntry.id)?.status, '已处理')
})

test('告警处理同步待处理台账状态', () => {
  const outcome = evaluateMonitor(createSeedMonitorState(), NOW)
  const alert = Object.values(outcome.state.alerts).find((item) => item.metricCode === 'MONI-71')
  assert.ok(alert)
  const resolved = resolveAlert(outcome.state, alert.id, '2026-11-14T20:40:00.000Z')
  assert.equal(resolved.alerts[alert.id].status, '已处理')
  assert.equal(resolved.ledger.find((entry) => entry.alertId === alert.id)?.status, '已处理')
})
