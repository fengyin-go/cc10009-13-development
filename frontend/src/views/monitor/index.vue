<template>
  <section class="page" data-module="monitor">
    <header class="page-head">
      <div>
        <h2>采集监控管理</h2>
        <p class="page-desc">
          按统计粒度把采集结果切成稳定的指标时间窗，汇总采集量、成功量与异常量；异常量达到预警阈值时生成告警记录，
          静默窗口内不重复告警。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="refreshWindows">刷新指标时间窗</button>
        <button class="btn" type="button" @click="exportRows">导出采集监控清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p v-if="feedbackMessage" class="notice-bar" :class="{ 'notice-error': feedbackError }">
      {{ feedbackMessage }}
    </p>

    <h3 class="section-title">指标时间窗</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>窗口编号</th>
          <th>指标 / 关联任务</th>
          <th>统计粒度</th>
          <th>窗口起止（本地时间）</th>
          <th>采集量</th>
          <th>成功量</th>
          <th>异常量（当前）</th>
          <th>异常量峰值</th>
          <th>阈值（版本）</th>
          <th>窗口状态</th>
          <th>边界口径</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="view in windowRows" :key="view.window.id">
          <td>{{ view.window.label }}</td>
          <td>{{ view.window.metricCode }} / {{ view.window.taskCode }}</td>
          <td>{{ view.window.granularity }}</td>
          <td>{{ formatRange(view.window.start, view.window.end) }}</td>
          <td>{{ view.window.collected }}</td>
          <td>{{ view.window.success }}</td>
          <td>{{ view.currentAbnormal }}</td>
          <td>{{ view.window.peakAbnormal }}</td>
          <td>{{ view.window.threshold }}（v{{ view.window.thresholdVersion }}）</td>
          <td>
            <span :class="windowStatusClass(view.window.status)">{{ view.window.status }}</span>
            <span v-if="view.window.suppressReason" class="muted-block">{{ view.window.suppressReason }}</span>
          </td>
          <td class="boundary-cell">{{ view.window.boundaryRule }}</td>
        </tr>
        <tr v-if="!windowRows.length">
          <td colspan="11" class="empty-state">还没有可统计的指标时间窗，先提交采集结果或刷新时间窗</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">告警记录</h3>
    <p class="section-hint">
      告警锁定值取窗口首次触发时的异常量峰值，窗口内异常量随后回落也不会回写；阈值调整只影响之后的时间窗。
    </p>
    <table class="data-table">
      <thead>
        <tr>
          <th>告警批次</th>
          <th>指标 / 关联任务</th>
          <th>时间窗</th>
          <th>触发阈值（版本）</th>
          <th>告警锁定值</th>
          <th>窗口当前异常量</th>
          <th>告警级别</th>
          <th>生成时间</th>
          <th>状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="record in alertRows" :key="record.alert.id">
          <td>{{ record.alert.batchId }}</td>
          <td>{{ record.alert.metricName }} / {{ record.alert.taskCode }}</td>
          <td>
            {{ record.alert.windowLabel }}
            <span class="muted-block">{{ formatRange(record.alert.windowStart, record.alert.windowEnd) }}</span>
          </td>
          <td>{{ record.alert.threshold }}（v{{ record.alert.thresholdVersion }}）</td>
          <td><strong>{{ record.alert.recordedValue }}</strong></td>
          <td>
            {{ record.currentAbnormal }}
            <span v-if="record.drift" class="muted-block">较锁定值 {{ record.drift > 0 ? '+' : '' }}{{ record.drift }}</span>
          </td>
          <td>{{ record.alert.severity }}</td>
          <td>{{ formatStamp(record.alert.createdAt) }}</td>
          <td>{{ record.alert.status }}</td>
          <td>
            <button
              v-if="record.alert.status === '待处理'"
              class="link"
              type="button"
              @click="markAlertHandled(record.alert.id)"
            >
              标记处理
            </button>
            <span v-else class="muted-block">已在待处理台账处理</span>
          </td>
        </tr>
        <tr v-if="!alertRows.length">
          <td colspan="10" class="empty-state">暂未触发告警</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">缺失时间戳结果</h3>
    <p class="section-hint">这些记录缺少可解析的采集时间，无法归入任何时间窗，单独列出而非按 0 值计入窗口统计。</p>
    <table class="data-table">
      <thead>
        <tr>
          <th>指标 / 关联任务</th>
          <th>结果条数</th>
          <th>采集量</th>
          <th>成功量</th>
          <th>异常量</th>
          <th>结果编号</th>
          <th>说明</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in dashboard.missingTimestamps" :key="item.metricCode">
          <td>{{ item.metricCode }} / {{ item.taskCode }}</td>
          <td>{{ item.resultCount }}</td>
          <td>{{ item.collected }}</td>
          <td>{{ item.success }}</td>
          <td>{{ item.abnormal }}</td>
          <td>{{ item.resultIds.join('、') }}</td>
          <td class="boundary-cell">{{ item.note }}</td>
        </tr>
        <tr v-if="!dashboard.missingTimestamps.length">
          <td colspan="7" class="empty-state">所有采集结果都带有可解析的时间戳</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">监控指标配置</h3>
    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>阈值版本</th>
          <th>当前状态</th>
          <th>可执行动作</th>
          <th>调整阈值</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>v{{ configFor(row)?.thresholdVersion ?? 1 }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
          <td>
            <div class="inline-form">
              <input
                v-model="thresholdDrafts[String(row.id)]"
                class="inline-input"
                inputmode="numeric"
                :placeholder="String(row['预警阈值'] ?? '')"
              />
              <button class="link" type="button" @click="applyThreshold(row)">保存</button>
            </div>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 4" class="empty-state">暂无采集监控数据，可先登记监控指标</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条采集监控记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  handleAlert,
  loadMonitorDashboard,
  refreshMonitorWindows,
  updateMetricThreshold,
} from '@/api/monitor-service'
import type { MonitorDashboard } from '@/data/monitor-types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('monitor')
const columns = ["指标编号", "关联任务", "指标名称", "预警阈值", "告警级别", "统计粒度", "通知渠道", "静默窗口"]
const actions = ["提交校验", "启用监控", "停用监控"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const feedbackMessage = ref('')
const feedbackError = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const thresholdDrafts = reactive<Record<string, string>>({})

const dashboard = ref<MonitorDashboard>({
  configs: [],
  windows: [],
  alerts: [],
  missingTimestamps: [],
  activeAlertCount: 0,
})

const windowRows = computed(() =>
  dashboard.value.windows.map((window) => ({
    window,
    currentAbnormal: window.abnormal,
  })),
)
const alertRows = computed(() =>
  dashboard.value.alerts.map((alert) => {
    const window = dashboard.value.windows.find((item) => item.id === alert.windowId)
    return { alert, currentAbnormal: window?.abnormal ?? 0, drift: (window?.abnormal ?? 0) - alert.recordedValue }
  }),
)

const stats = computed(() => [
  { label: '监控指标总数', value: dashboard.value.configs.length },
  { label: '指标时间窗', value: dashboard.value.windows.length },
  { label: '待处理告警', value: dashboard.value.activeAlertCount },
  { label: '缺失时间戳结果', value: dashboard.value.missingTimestamps.reduce((sum, item) => sum + item.resultCount, 0) },
])

function configFor(row: EntryRow) {
  return dashboard.value.configs.find((config) => config.code === String(row['指标编号']))
}

function formatStamp(value: string): string {
  if (!value) {
    return '—'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  const pad = (input: number) => (input < 10 ? `0${input}` : String(input))
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatRange(start: string, end: string): string {
  return `${formatStamp(start)} → ${formatStamp(end)}`
}

function windowStatusClass(status: string): string {
  if (status === '已告警') {
    return 'tag tag-alert'
  }
  if (status === '静默抑制') {
    return 'tag tag-silenced'
  }
  return 'tag'
}

function setFeedback(message: string, isError = false) {
  feedbackMessage.value = message
  feedbackError.value = isError
}

function reload() {
  errorMessage.value = ''
  try {
    dashboard.value = loadMonitorDashboard()
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '采集监控列表读取失败'
  }
}

function refreshWindows() {
  try {
    const summary = refreshMonitorWindows()
    reload()
    setFeedback(
      `时间窗已刷新：新建告警 ${summary.createdAlerts.length} 条，复用已有告警 ${summary.reusedAlerts.length} 条，静默抑制 ${summary.suppressedWindows.length} 个窗口`,
    )
  } catch (error) {
    setFeedback(error instanceof Error ? error.message : '指标时间窗刷新失败', true)
  }
}

function applyThreshold(row: EntryRow) {
  const key = String(row.id)
  const raw = thresholdDrafts[key]
  if (raw === undefined || raw.trim() === '') {
    setFeedback('请先填写新的预警阈值', true)
    return
  }
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    setFeedback('预警阈值必须是非负数字', true)
    return
  }
  try {
    const config = updateMetricThreshold(String(row['指标编号']), value)
    thresholdDrafts[key] = ''
    reload()
    setFeedback(
      `指标 ${config.code} 的预警阈值已调整为 ${config.threshold}（v${config.thresholdVersion}），仅对之后的时间窗生效，已生成的告警保留原阈值`,
    )
  } catch (error) {
    setFeedback(error instanceof Error ? error.message : '阈值调整失败', true)
  }
}

function markAlertHandled(alertId: string) {
  try {
    handleAlert(alertId)
    reload()
    setFeedback('告警已标记处理，待处理台账同步更新')
  } catch (error) {
    setFeedback(error instanceof Error ? error.message : '处理告警失败', true)
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

onMounted(reload)
</script>
