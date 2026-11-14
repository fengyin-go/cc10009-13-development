<template>
  <section class="page" data-module="monitor-ledger">
    <header class="page-head">
      <div>
        <h2>待处理台账</h2>
        <p class="page-desc">
          采集监控告警与采集任务状态变化统一落到这里。台账按批次持久化，刷新或重新进入页面看到的仍是同一告警批次。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="reload">刷新台账</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p v-if="message" class="notice-bar">{{ message }}</p>
    <p v-if="errorMessage" class="notice-bar notice-error">{{ errorMessage }}</p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>类型</span>
        <select v-model="kindFilter">
          <option value="">全部</option>
          <option value="告警">告警</option>
          <option value="任务状态">任务状态</option>
        </select>
      </label>
      <label class="filter-item">
        <span>状态</span>
        <select v-model="statusFilter">
          <option value="">全部</option>
          <option value="待处理">待处理</option>
          <option value="已处理">已处理</option>
        </select>
      </label>
      <label class="filter-item">
        <span>关联任务</span>
        <input v-model="taskFilter" placeholder="按作业编号检索" />
      </label>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>台账编号</th>
          <th>告警批次</th>
          <th>类型</th>
          <th>事项</th>
          <th>关联任务</th>
          <th>时间窗</th>
          <th>锁定值 / 阈值</th>
          <th>当前异常量</th>
          <th>状态</th>
          <th>登记时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="entry in filteredEntries" :key="entry.id">
          <td>{{ entry.id }}</td>
          <td>{{ entry.batchId }}</td>
          <td>{{ entry.kind }}</td>
          <td>
            {{ entry.title }}
            <span v-if="entry.note" class="muted-block">{{ entry.note }}</span>
          </td>
          <td>{{ entry.taskCode }}</td>
          <td>
            <template v-if="entry.windowId">
              {{ entry.windowLabel }}
              <span class="muted-block">{{ formatRange(entry.windowStart!, entry.windowEnd!) }}</span>
            </template>
            <span v-else>—</span>
          </td>
          <td>
            <template v-if="entry.recordedValue !== undefined">
              {{ entry.recordedValue }} / {{ entry.threshold }}（v{{ entry.thresholdVersion }}）
            </template>
            <span v-else>—</span>
          </td>
          <td>
            <template v-if="currentAbnormal(entry) !== null">
              {{ currentAbnormal(entry) }}
              <span v-if="driftFor(entry)" class="muted-block">
                窗口已回落到当前值，锁定值保持 {{ entry.recordedValue }}
              </span>
            </template>
            <span v-else>—</span>
          </td>
          <td>{{ entry.status }}</td>
          <td>{{ formatStamp(entry.createdAt) }}</td>
          <td>
            <button
              v-if="entry.status === '待处理'"
              class="link"
              type="button"
              @click="markHandled(entry)"
            >
              标记已处理
            </button>
            <span v-else class="muted-block">{{ entry.handledAt ? formatStamp(entry.handledAt) : '已处理' }}</span>
          </td>
        </tr>
        <tr v-if="!filteredEntries.length">
          <td colspan="11" class="empty-state">暂无待处理事项，采集任务状态变化或告警触发后会出现在这里</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>台账共 {{ entries.length }} 条，其中待处理 {{ pendingCount }} 条</span>
      <span>台账随浏览器本地存储持久化，刷新或重新进入不会丢失告警批次</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { handleLedgerEntry, listLedger, loadMonitorDashboard } from '@/api/monitor-service'
import type { LedgerEntry, MonitorDashboard } from '@/data/monitor-types'

const entries = ref<LedgerEntry[]>([])
const dashboard = ref<MonitorDashboard | null>(null)
const kindFilter = ref('')
const statusFilter = ref('待处理')
const taskFilter = ref('')
const message = ref('')
const errorMessage = ref('')

const pendingCount = computed(() => entries.value.filter((entry) => entry.status === '待处理').length)

const stats = computed(() => [
  { label: '台账总数', value: entries.value.length },
  { label: '待处理', value: pendingCount.value },
  { label: '告警批次', value: new Set(entries.value.map((entry) => entry.batchId)).size },
  { label: '待处理告警', value: dashboard.value?.activeAlertCount ?? 0 },
])

const filteredEntries = computed(() =>
  entries.value.filter((entry) => {
    if (kindFilter.value && entry.kind !== kindFilter.value) {
      return false
    }
    if (statusFilter.value && entry.status !== statusFilter.value) {
      return false
    }
    if (taskFilter.value.trim() && !entry.taskCode.includes(taskFilter.value.trim())) {
      return false
    }
    return true
  }),
)

function currentAbnormal(entry: LedgerEntry): number | null {
  if (!entry.windowId || !dashboard.value) {
    return null
  }
  const window = dashboard.value.windows.find((item) => item.id === entry.windowId)
  return window ? window.abnormal : null
}

function driftFor(entry: LedgerEntry): boolean {
  const current = currentAbnormal(entry)
  return current !== null && entry.recordedValue !== undefined && current !== entry.recordedValue
}

function formatStamp(value: string): string {
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

function resetFilters() {
  kindFilter.value = ''
  statusFilter.value = ''
  taskFilter.value = ''
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    dashboard.value = loadMonitorDashboard()
    entries.value = listLedger()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '待处理台账读取失败'
  }
}

function markHandled(entry: LedgerEntry) {
  message.value = ''
  try {
    handleLedgerEntry(entry.id)
    reload()
    message.value = `台账 ${entry.id} 已标记处理`
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '处理台账失败'
  }
}

onMounted(reload)
</script>
