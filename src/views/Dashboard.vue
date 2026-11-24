<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/api'
import { useAppStore } from '@/store/app'
import EquityCurveChart from '@/components/EquityCurveChart.vue'

const store = useAppStore()
const loading = ref(false)
const fileInput = ref<HTMLInputElement>()
let timer: number | undefined

async function refresh() {
  try {
    loading.value = true
    await Promise.all([store.refreshAccount(), store.refreshTickers()])
  } finally {
    loading.value = false
  }
}

// ---- 数据备份（数据只存本机，定期导出一份放好） ----
async function handleExport() {
  const data = await api.exportBackup()
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `ai-trading-backup-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
  ElMessage.success('备份已导出，请存到「文件」里放好')
}

async function handleImportFile(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    await ElMessageBox.confirm(
      '导入备份会整体替换当前账户、持仓和全部记录，确定继续？',
      '导入备份',
      { type: 'warning', confirmButtonText: '替换导入', cancelButtonText: '取消' }
    )
    const data = JSON.parse(await file.text())
    await api.importBackup(data)
    ElMessage.success('备份已导入')
    await refresh()
  } catch (e: any) {
    if (e?.message) ElMessage.error(e.message)
  } finally {
    if (fileInput.value) fileInput.value.value = ''
  }
}

async function handleReset() {
  try {
    const { value } = await ElMessageBox.prompt('输入新的初始资金（USDT）', '重置账户', {
      inputValue: '10000',
      inputPattern: /^\d+(\.\d+)?$/,
      inputErrorMessage: '请输入正数',
    })
    await api.resetAccount(Number(value))
    ElMessage.success('账户已重置')
    await refresh()
  } catch {}
}

function fmt(n: number | undefined, d = 2) {
  if (n === undefined || n === null || isNaN(n)) return '--'
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
}

onMounted(async () => {
  await store.loadConfig()
  await refresh()
  timer = window.setInterval(refresh, 5000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="page">
    <div class="dashboard-header">
      <h2 class="section-title" style="margin:0">账户总览</h2>
      <div class="dashboard-actions">
        <el-button size="small" :loading="loading" @click="refresh">刷新数据</el-button>
        <el-button size="small" type="danger" plain @click="handleReset">重置账户</el-button>
      </div>
    </div>

    <div class="grid-cards">
      <div class="stat-card">
        <div class="label">总资产</div>
        <div class="value">${{ fmt(store.account?.total_equity) }}</div>
        <div class="delta" :class="{ up: (store.account?.total_pnl ?? 0) >= 0, down: (store.account?.total_pnl ?? 0) < 0 }">
          {{ (store.account?.total_pnl ?? 0) >= 0 ? '▲' : '▼' }}
          {{ fmt(store.account?.total_pnl) }} ({{ fmt(store.account?.total_pnl_pct) }}%)
        </div>
      </div>
      <div class="stat-card">
        <div class="label">现金余额 (USDT)</div>
        <div class="value">${{ fmt(store.account?.cash) }}</div>
        <div class="delta muted">初始资金: ${{ fmt(store.account?.initial_capital) }}</div>
      </div>
      <div class="stat-card">
        <div class="label">持仓市值</div>
        <div class="value">${{ fmt(store.account?.position_market_value) }}</div>
        <div class="delta muted">{{ store.account?.positions.length ?? 0 }} 个持仓</div>
      </div>
      <div class="stat-card">
        <div class="label">未实现盈亏</div>
        <div class="value" :class="{ up: (store.account?.unrealized_pnl ?? 0) >= 0, down: (store.account?.unrealized_pnl ?? 0) < 0 }">
          ${{ fmt(store.account?.unrealized_pnl) }}
        </div>
      </div>
      <div class="stat-card">
        <div class="label">已实现盈亏</div>
        <div class="value" :class="{ up: (store.account?.realized_pnl ?? 0) >= 0, down: (store.account?.realized_pnl ?? 0) < 0 }">
          ${{ fmt(store.account?.realized_pnl) }}
        </div>
        <div class="delta muted">已平仓部分落袋的结果</div>
      </div>
      <div class="stat-card">
        <div class="label">累计手续费</div>
        <div class="value">${{ fmt(store.account?.total_fees) }}</div>
        <div class="delta muted">全部成交合计 · 费率 0.1%</div>
      </div>
    </div>

    <div style="height:24px" />

    <!-- 资产净值曲线（Apple Stocks 风格） -->
    <EquityCurveChart />

    <div style="height:24px" />

    <div class="panel">
      <h2 class="section-title">我的持仓</h2>
      <el-table :data="store.account?.positions ?? []" stripe empty-text="暂无持仓，去「行情交易」页买入吧">
        <el-table-column prop="symbol" label="交易对" />
        <el-table-column prop="quantity" label="数量" :formatter="(r: any) => fmt(r.quantity, 6)" />
        <el-table-column prop="avg_price" label="持仓均价" :formatter="(r: any) => fmt(r.avg_price, 4)" />
        <el-table-column prop="last_price" label="现价" :formatter="(r: any) => fmt(r.last_price, 4)" />
        <el-table-column prop="market_value" label="市值" :formatter="(r: any) => '$' + fmt(r.market_value)" />
        <el-table-column label="盈亏">
          <template #default="{ row }">
            <span :class="{ up: row.unrealized_pnl >= 0, down: row.unrealized_pnl < 0 }">
              ${{ fmt(row.unrealized_pnl) }} ({{ fmt(row.pnl_pct) }}%)
            </span>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div style="height:24px" />

    <div class="panel">
      <h2 class="section-title">热门行情</h2>
      <div class="muted" style="font-size:12px;margin:-6px 0 10px">行情来源：OKX 公共行情 · 每 5 秒刷新</div>
      <el-table :data="store.tickers" stripe empty-text="行情加载中...">
        <el-table-column prop="symbol" label="交易对" />
        <el-table-column label="最新价" :formatter="(r: any) => fmt(r.last, 4)" />
        <el-table-column label="24小时涨跌">
          <template #default="{ row }">
            <span :class="{ up: (row.change24h ?? 0) >= 0, down: (row.change24h ?? 0) < 0 }">
              {{ fmt((row.change24h ?? 0) * 100, 2) }}%
            </span>
          </template>
        </el-table-column>
        <el-table-column label="24小时最高" :formatter="(r: any) => fmt(r.high24h, 4)" />
        <el-table-column label="24小时最低" :formatter="(r: any) => fmt(r.low24h, 4)" />
        <el-table-column label="24小时成交量" :formatter="(r: any) => fmt(r.vol24h, 2)" />
      </el-table>
    </div>

    <div style="height:24px" />

    <div class="panel">
      <h2 class="section-title">数据备份</h2>
      <p class="muted" style="font-size:12px;margin:-6px 0 12px;line-height:1.7">
        本地版的数据只存在这台手机上，换手机或清浏览器数据会丢。定期导出一份备份存到「文件」里，
        需要时用导入恢复（导入会整体替换当前数据）。
      </p>
      <el-button size="small" @click="handleExport">导出备份</el-button>
      <el-button size="small" @click="fileInput?.click()">导入备份</el-button>
      <input
        ref="fileInput"
        type="file"
        accept="application/json,.json"
        style="display:none"
        @change="handleImportFile"
      />
    </div>
  </div>
</template>

<style scoped>
.dashboard-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 18px;
  gap: 12px;
  flex-wrap: wrap;
}
.dashboard-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
