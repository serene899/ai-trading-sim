/**
 * 本地数据库（IndexedDB / Dexie）——主屏幕版的数据层。
 * 数据只存在这台设备上，与钱在哪/生息/阅迹同一原则：不上传任何服务器。
 * 表结构对应服务器版的 account / position / order / trade / equity_snapshot。
 */
import Dexie, { type Table } from 'dexie'

export interface MetaRow {
  key: string
  value: any
}

export interface PositionRow {
  symbol: string
  quantity: number
  avg_price: number // 含买入手续费摊薄的成本均价（与服务器版口径一致）
  updated_at: string
}

export interface OrderRow {
  id?: number
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

export interface TradeRow {
  id?: number
  order_id: number
  symbol: string
  side: 'buy' | 'sell'
  quantity: number
  price: number
  fee: number
  realized_pnl: number
  created_at: string
}

export interface EquityRow {
  id?: number
  ts: string
  equity: number
  cash: number
  position_value: number
  unrealized_pnl: number
}

class TradingDB extends Dexie {
  meta!: Table<MetaRow, string>
  positions!: Table<PositionRow, string>
  orders!: Table<OrderRow, number>
  trades!: Table<TradeRow, number>
  equity!: Table<EquityRow, number>

  constructor() {
    super('ai-trading-sim')
    this.version(1).stores({
      meta: 'key',
      positions: 'symbol',
      orders: '++id,status',
      trades: '++id',
      equity: '++id,ts',
    })
  }
}

export const db = new TradingDB()
