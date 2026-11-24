/**
 * 本地 API 门面（主屏幕版）：签名与服务器版保持一致，实现全部换成本地引擎。
 * - 行情：直连 OKX 公共接口（src/engine/market.ts）
 * - 账户/订单/成交：本地 IndexedDB 引擎（src/engine/engine.ts）
 * - 分析：本地规则计算（src/engine/analysis.ts）
 * 没有后端、没有登录：数据只存在这台设备上。
 */
import { ElMessage } from 'element-plus'
import {
  APP_VERSION,
  buildSnapshot,
  cancelOrder as engineCancelOrder,
  equityCurve as engineEquityCurve,
  exportBackup,
  importBackup,
  listOrders as engineListOrders,
  listTrades as engineListTrades,
  placeOrder as enginePlaceOrder,
  resetAccount as engineResetAccount,
  sampleEquity,
  scanLimitOrders,
  type AccountSnapshot as EngineSnapshot,
} from '@/engine/engine'
import type { OrderRow, TradeRow } from '@/engine/db'
import { DEFAULT_SYMBOLS, getKline, getTicker, getTickers, lastPriceOrNull, type Ticker } from '@/engine/market'
import { analyzeSymbol } from '@/engine/analysis'

// -------- Types（与服务器版一致，视图层不用改） --------
export type { Ticker }

export interface Kline {
  symbol: string
  interval: string
  candles: number[][]
}

export interface Position {
  symbol: string
  quantity: number
  avg_price: number
  last_price: number
  market_value: number
  unrealized_pnl: number
  pnl_pct: number
}

export interface AccountSnapshot extends EngineSnapshot {
  positions: Position[]
}

export interface EquityPoint {
  ts: string
  equity: number
  cash: number
  position_value: number
  unrealized_pnl: number
}
export interface EquityCurve {
  range: string
  points: EquityPoint[]
  first: number
  last: number
  change: number
  change_pct: number
}
export type EquityRange = '1H' | '1D' | '1W' | '1M' | 'ALL'

export interface Order {
  id: number
  symbol: string
  side: 'buy' | 'sell'
  type: 'market' | 'limit'
  quantity: number
  price: number | null
  status: 'open' | 'filled' | 'cancelled'
  filled_price: number | null
  filled_at: string | null
  created_at: string
}

export interface Trade {
  id: number
  order_id: number
  symbol: string
  side: 'buy' | 'sell'
  quantity: number
  price: number
  fee?: number
  realized_pnl?: number
  created_at: string
}

export interface Analysis {
  symbol: string
  source: string
  updated_at: string
  price: number
  change24h_pct: number
  ma5: number | null
  ma20: number | null
  trend: string
  volatility_pct: number | null
  risk_level: string
  position: (Position & { weight_pct: number }) | null
  notes: string[]
  disclaimer: string
}

// -------- 内部 --------

async function snapshot(): Promise<AccountSnapshot> {
  // 先扫一遍限价单（App 打开期间的价格触发成交），再算账
  await scanLimitOrders(lastPriceOrNull).catch(() => {})
  const snap = await buildSnapshot(lastPriceOrNull)
  await sampleEquity(snap).catch(() => {})
  return snap as AccountSnapshot
}

function toOrder(o: OrderRow): Order {
  return { ...o, id: o.id! }
}
function toTrade(t: TradeRow): Trade {
  return { ...t, id: t.id! }
}

// -------- API --------
export const api = {
  health: async () => ({ status: 'ok', version: APP_VERSION, auth_enabled: false }),
  config: async () => ({ exchange: 'OKX', symbols: DEFAULT_SYMBOLS, version: APP_VERSION }),

  ticker: (symbol: string) => getTicker(symbol),
  tickers: (symbols?: string[]) => getTickers(symbols),
  kline: async (symbol: string, interval = '1m', limit = 100): Promise<Kline> => ({
    symbol,
    interval,
    candles: await getKline(symbol, interval, limit),
  }),

  account: () => snapshot(),
  analysis: (symbol: string) => analyzeSymbol(symbol) as Promise<Analysis>,
  resetAccount: async (initial_capital: number) => {
    await engineResetAccount(initial_capital)
    return snapshot()
  },

  equityCurve: (range: EquityRange = '1D') => engineEquityCurve(range) as Promise<EquityCurve>,

  createOrder: async (body: {
    symbol: string
    side: 'buy' | 'sell'
    type: 'market' | 'limit'
    quantity: number
    price?: number
  }): Promise<Order> => {
    try {
      const last = await lastPriceOrNull(body.symbol)
      if (last === null) throw new Error('行情暂时拉不到，稍后再试')
      const order = await enginePlaceOrder(body, last)
      return toOrder(order)
    } catch (e: any) {
      ElMessage.error(e?.message || '下单失败')
      throw e
    }
  },

  listOrders: async (status?: string): Promise<Order[]> => (await engineListOrders(status)).map(toOrder),
  cancelOrder: async (id: number): Promise<Order> => {
    try {
      return toOrder(await engineCancelOrder(id))
    } catch (e: any) {
      ElMessage.error(e?.message || '撤销失败')
      throw e
    }
  },
  listTrades: async (): Promise<Trade[]> => (await engineListTrades()).map(toTrade),

  // 数据备份（本地文件，与其他 LIFEOS App 同惯例）
  exportBackup,
  importBackup,
}

export default api
