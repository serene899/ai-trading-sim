<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import KLineChart from '@/components/KLineChart.vue'
import OrderForm from '@/components/OrderForm.vue'
import api, { type Analysis } from '@/api'
import { useAppStore } from '@/store/app'
import { formatDateTime } from '@/utils/time'

const store = useAppStore()
const interval = ref('1m')
let timer: number | undefined

const currentTicker = computed(() =>
  store.tickers.find((t) => t.symbol === store.currentSymbol)
)

const analysis = ref<Analysis | null>(null)
const analysisLoading = ref(false)

async function refreshAnalysis() {
  try {
    analysisLoading.value = true
    analysis.value = await api.analysis(store.currentSymbol)
  } catch {
    // 行情接口抖动时静默，面板保留上次结果
  } finally {
    analysisLoading.value = false
  }
}

async function refresh() {
  await store.refreshTickers()
}

watch(() => store.currentSymbol, () => { refreshAnalysis() })

onMounted(async () => {
  await store.loadConfig()
  await refresh()
  await refreshAnalysis()
  timer = window.setInterval(refresh, 5000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

function onSubmitted() {
  store.refreshAccount()
}
</script>

<template>
  <div class="page">
    <div class="market-toolbar">
      <el-select v-model="store.currentSymbol" style="width:180px">
        <el-option v-for="s in store.symbols" :key="s" :label="s" :value="s" />
      </el-select>
      <el-radio-group v-model="interval" size="small">
        <el-radio-button label="1m" />
        <el-radio-button label="5m" />
        <el-radio-button label="15m" />
        <el-radio-button label="1h" />
        <el-radio-button label="4h" />
        <el-radio-button label="1d" />
      </el-radio-group>
      <div class="spacer" />
      <div v-if="currentTicker" class="ticker-summary">
        <div class="ticker-cell">
          <div class="muted">最新价</div>
          <div class="ticker-main">{{ currentTicker.last }}</div>
        </div>
        <div class="ticker-cell">
          <div class="muted">24H 涨跌</div>
          <div :class="{ up: (currentTicker.change24h ?? 0) >= 0, down: (currentTicker.change24h ?? 0) < 0 }">
            {{ ((currentTicker.change24h ?? 0) * 100).toFixed(2) }}%
          </div>
        </div>
        <div class="ticker-cell">
          <div class="muted">24H 最高</div>
          <div>{{ currentTicker.high24h }}</div>
        </div>
        <div class="ticker-cell">
          <div class="muted">24H 最低</div>
          <div>{{ currentTicker.low24h }}</div>
        </div>
      </div>
    </div>

    <div class="muted" style="font-size:12px;margin-bottom:12px">
      行情来源：OKX 公共行情 · 每 5 秒刷新
      <span v-if="analysis">· 分析更新于 {{ formatDateTime(analysis.updated_at) }}</span>
    </div>

    <div class="market-grid">
      <div class="panel">
        <KLineChart :symbol="store.currentSymbol" :interval="interval" />
      </div>
      <div class="panel">
        <h2 class="section-title">下单面板</h2>
        <OrderForm
          :symbol="store.currentSymbol"
          :last-price="currentTicker?.last"
          @submitted="onSubmitted"
        />
      </div>
    </div>

    <div style="height:24px" />

    <div class="panel" v-loading="analysisLoading">
      <h2 class="section-title">行情分析（规则版）</h2>
      <template v-if="analysis">
        <p style="margin:0 0 10px;line-height:1.7">{{ analysis.trend }}</p>
        <div class="analysis-grid">
          <div><span class="muted">MA5（1H）</span><b>{{ analysis.ma5 ? analysis.ma5.toFixed(2) : '--' }}</b></div>
          <div><span class="muted">MA20（1H）</span><b>{{ analysis.ma20 ? analysis.ma20.toFixed(2) : '--' }}</b></div>
          <div><span class="muted">波动率（1H）</span><b>{{ analysis.volatility_pct ? analysis.volatility_pct.toFixed(2) + '%' : '--' }}</b></div>
          <div><span class="muted">风险等级</span><b>{{ analysis.risk_level }}</b></div>
          <div v-if="analysis.position">
            <span class="muted">我的持仓占比</span><b>{{ analysis.position.weight_pct.toFixed(1) }}%</b>
          </div>
        </div>
        <ul v-if="analysis.notes.length" style="margin:12px 0 0;padding-left:18px;line-height:1.8">
          <li v-for="(n, i) in analysis.notes" :key="i">{{ n }}</li>
        </ul>
        <p class="muted" style="font-size:12px;margin:14px 0 0">⚠️ {{ analysis.disclaimer }}</p>
      </template>
      <p v-else class="muted" style="margin:0">分析加载中，或行情接口暂时不可用。</p>
    </div>
  </div>
</template>

<style scoped>
.market-toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 18px;
  flex-wrap: wrap;
}
.market-toolbar .spacer { flex: 1; }

.ticker-summary {
  display: flex;
  gap: 28px;
  align-items: center;
  flex-wrap: wrap;
}
.ticker-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.ticker-cell .muted {
  font-size: 11px;
  font-weight: 500;
}
.ticker-cell > div:last-child {
  font-size: 20px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
  white-space: nowrap;
}
.ticker-cell .ticker-main {
  font-size: 22px;
}

.market-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  gap: 18px;
}
.analysis-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px 18px;
}
.analysis-grid > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.analysis-grid b {
  font-variant-numeric: tabular-nums;
}
@media (max-width: 1100px) {
  .market-grid {
    grid-template-columns: 1fr;
  }
}
</style>
