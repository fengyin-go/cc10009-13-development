<template>
  <section class="page" data-module="spider">
    <header class="page-head">
      <div>
        <h2>采集任务管理</h2>
        <p class="page-desc">维护采集作业的输入、执行约束与结果记录，为采集任务提供可验证的数据工程流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记采集作业</button>
        <button class="btn" type="button" @click="exportRows">导出采集任务清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <h3 class="section-title">采集结果按任务汇总</h3>
    <p class="section-hint">
      按指标时间窗的当前快照汇总，与采集监控页的异常量口径一致；缺失时间戳的结果单独计数，不按 0 值并入窗口。
    </p>
    <table class="data-table">
      <thead>
        <tr>
          <th>作业编号</th>
          <th>指标时间窗数</th>
          <th>采集量</th>
          <th>成功量</th>
          <th>异常量</th>
          <th>缺失时间戳结果</th>
          <th>最近观测时间</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in taskSummaries" :key="item.taskCode">
          <td>{{ item.taskCode }}</td>
          <td>{{ item.windowCount }}</td>
          <td>{{ item.collected }}</td>
          <td>{{ item.success }}</td>
          <td>{{ item.abnormal }}</td>
          <td>{{ item.missingTimestampCount }}</td>
          <td>{{ item.lastObservedAt ? formatStamp(item.lastObservedAt) : '—' }}</td>
        </tr>
        <tr v-if="!taskSummaries.length">
          <td colspan="7" class="empty-state">还没有采集结果，监控指标收到数据后会汇总到这里</td>
        </tr>
      </tbody>
    </table>
    <p v-if="transitionNote" class="notice-bar">{{ transitionNote }}</p>

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
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
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
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无采集任务数据，可先登记采集作业</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条采集任务记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { listTaskResults } from '@/api/monitor-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('spider')
const columns = ["作业编号", "目标站点", "抽取模板", "起始地址", "并发线程数", "请求间隔秒", "每日上限条数", "超时秒数"]
const actions = ["提交执行", "启动采集", "终止采集", "归档结果"]
const statuses = ["草稿", "待执行", "运行中", "已完成", "已失败"]
const stats = [{"label": "采集作业总数", "value": 0}, {"label": "运行中作业", "value": 0}, {"label": "已完成作业", "value": 0}]

const taskSummaries = ref<ReturnType<typeof listTaskResults>>([])
const transitionNote = ref('')
const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '采集作业登记入口尚未接入审批流'
}

function formatStamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  const pad = (input: number) => (input < 10 ? `0${input}` : String(input))
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  transitionNote.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  transitionNote.value = `${result.message}；已写入采集监控的待处理台账`
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    taskSummaries.value = listTaskResults()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '采集任务列表读取失败'
  }
}

onMounted(reload)
</script>
