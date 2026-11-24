/**
 * 本地模拟撮合引擎 —— 服务器版 matching.py + portfolio.py 的等价移植。
 *
 * 口径与服务器版逐项对齐（同一套实测数字验证）：
 * - 手续费 0.1%：买入现金扣 成交额+费，持仓均价按「含费成本」摊薄；
 *   卖出现金加 成交额-费，已实现盈亏 = (成交价-均价)×数量-卖出费。
 * - 市价单滑点 0.05%（买高卖低）；限价单按用户价成交、不加滑点。
 * - 限价单挂单后，由前端轮询行情时扫描触发（App 打开期间有效；
 *   App 关掉就没人盯盘，这是主屏幕版与服务器版的本质区别，不假装能后台跑）。
 * - 已实现盈亏与累计手续费一律以成交流水逐笔加总，与现金/权益可互相核对。
 * - 纯现货：无杠杆、无保证金、不能做空（卖出不能超过持仓）。
 */
import { db, type OrderRow, type PositionRow, type TradeRow } from './db'

export const FEE_RATE = 0.001
export const SLIPPAGE_PCT = 0.0005

/** 可调参数（默认值与服务器版 config 一致；测试时可临时改，如关掉滑点专心核对手续费数学） */
export const engineConfig = { feeRate: FEE_RATE, slippagePct: SLIPPAGE_PCT }
export const DEFAULT_INITIAL_CAPITAL = 10000
export const APP_VERSION = '2.1.0'

export class EngineError extends Error {}

const nowIso = () => new Date().toISOString()

// ---------- 纯计算（可单测，与服务器版 _apply_fill 对应） ----------

export interface PosState {
  quantity: number
  avg_price: number
}

export function feeOf(notional: number): number {
  return engineConfig.feeRate > 0 ? Math.max(notional * engineConfig.feeRate, 0) : 0
}

export function applySlippage(price: number, side: 'buy' | 'sell'): number {
  const pct = engineConfig.slippagePct
  if (pct <= 0) return price
  return side === 'buy' ? price * (1 + pct) : price * (1 - pct)
}

/** 买入：返回新现金、新持仓、手续费 */
export function computeBuy(
  cash: number,
  pos: PosState | null,
  qty: number,
  fillPrice: number
): { cash: number; pos: PosState; fee: number } {
  const notional = qty * fillPrice
  const fee = feeOf(notional)
  const costWithFee = notional + fee
  const newCash = cash - costWithFee
  if (!pos || pos.quantity <= 0) {
    return { cash: newCash, fee, pos: { quantity: qty, avg_price: qty > 0 ? costWithFee / qty : fillPrice } }
  }
  const totalQty = pos.quantity + qty
  return {
    cash: newCash,
    fee,
    pos: { quantity: totalQty, avg_price: (pos.avg_price * pos.quantity + costWithFee) / totalQty },
  }
}

/** 卖出：返回新现金、新持仓、手续费、已实现盈亏 */
export function computeSell(
  cash: number,
  pos: PosState,
  qty: number,
  fillPrice: number
): { cash: number; pos: PosState; fee: number; realized: number } {
  const notional = qty * fillPrice
  const fee = feeOf(notional)
  const realized = (fillPrice - pos.avg_price) * qty - fee
  return {
    cash: cash + (notional - fee),
    fee,
    realized,
    pos: { quantity: pos.quantity - qty, avg_price: pos.avg_price },
  }
}

// ---------- 账户状态 ----------

interface AccountState {
  cash: number
  initial_capital: number
}

async function getAccountState(): Promise<AccountState> {
  const row = await db.meta.get('account')
  if (row?.value) return row.value as AccountState
  const init: AccountState = { cash: DEFAULT_INITIAL_CAPITAL, initial_capital: DEFAULT_INITIAL_CAPITAL }
  await db.meta.put({ key: 'account', value: init })
  return init
}

async function setAccountState(s: AccountState): Promise<void> {
  await db.meta.put({ key: 'account', value: s })
}

async function getPosition(symbol: string): Promise<PositionRow | undefined> {
  return db.positions.get(symbol)
}

// ---------- 成交落账 ----------

async function applyFill(order: OrderRow, fillPrice: number): Promise<void> {
  const acc = await getAccountState()
  const posRow = await getPosition(order.symbol)
  const pos: PosState | null = posRow ? { quantity: posRow.quantity, avg_price: posRow.avg_price } : null

  let fee = 0
  let realized = 0
  if (order.side === 'buy') {
    const r = computeBuy(acc.cash, pos, order.quantity, fillPrice)
    acc.cash = r.cash
    fee = r.fee
    await db.positions.put({
      symbol: order.symbol,
      quantity: r.pos.quantity,
      avg_price: r.pos.avg_price,
      updated_at: nowIso(),
    })
  } else {
    if (!pos || pos.quantity < order.quantity) throw new EngineError('持仓不足')
    const r = computeSell(acc.cash, pos, order.quantity, fillPrice)
    acc.cash = r.cash
    fee = r.fee
    realized = r.realized
    await db.positions.put({
      symbol: order.symbol,
      quantity: r.pos.quantity,
      avg_price: r.pos.avg_price,
      updated_at: nowIso(),
    })
  }

  order.status = 'filled'
  order.filled_price = fillPrice
  order.filled_at = nowIso()
  await db.orders.put(order)
  await setAccountState(acc)
  const trade: TradeRow = {
    order_id: order.id!,
    symbol: order.symbol,
    side: order.side,
    quantity: order.quantity,
    price: fillPrice,
    fee,
    realized_pnl: order.side === 'sell' ? realized : 0,
    created_at: nowIso(),
  }
  await db.trades.add(trade)
}

// ---------- 下单 ----------

export interface PlaceOrderBody {
  symbol: string
  side: 'buy' | 'sell'
  type: 'market' | 'limit'
  quantity: number
  price?: number
}

export async function placeOrder(
  body: PlaceOrderBody,
  lastPrice: number
): Promise<OrderRow> {
  let quantity = Number(body.quantity)
  if (!isFinite(quantity) || quantity <= 0) throw new EngineError('数量必须 > 0')
  quantity = Math.round(quantity * 1e8) / 1e8
  if (quantity <= 0) throw new EngineError('数量舍入后为 0，请提高下单金额')

  let price: number | null = null
  if (body.price !== undefined && body.price !== null) {
    price = Number(body.price)
    if (!isFinite(price) || price <= 0) throw new EngineError('价格必须 > 0')
    price = Math.round(price * 1e8) / 1e8
  }
  if (body.type === 'limit' && price === null) throw new EngineError('限价单必须提供价格')
  if (body.type !== 'market' && body.type !== 'limit') throw new EngineError(`未知订单类型: ${body.type}`)
  if (body.side !== 'buy' && body.side !== 'sell') throw new EngineError(`未知方向: ${body.side}`)

  const acc = await getAccountState()
  const order: OrderRow = {
    symbol: body.symbol,
    side: body.side,
    type: body.type,
    quantity,
    price,
    status: 'open',
    filled_price: null,
    filled_at: null,
    created_at: nowIso(),
  }
  order.id = await db.orders.add(order)

  // 预检（买入按预估成交额+手续费；卖出按持仓）
  const checkPrice = body.type === 'market' ? applySlippage(lastPrice, body.side) : price!
  if (body.side === 'buy') {
    const estCost = quantity * checkPrice
    const estFee = feeOf(estCost)
    if (acc.cash < estCost + estFee) {
      order.status = 'cancelled'
      await db.orders.put(order)
      throw new EngineError(`现金余额不足（需 $${(estCost + estFee).toFixed(2)}，含手续费 $${estFee.toFixed(4)}）`)
    }
  } else {
    const pos = await getPosition(body.symbol)
    if (!pos || pos.quantity < quantity) {
      order.status = 'cancelled'
      await db.orders.put(order)
      throw new EngineError('持仓不足')
    }
  }

  if (body.type === 'market') {
    await applyFill(order, applySlippage(lastPrice, body.side))
  }
  return order
}

export async function cancelOrder(id: number): Promise<OrderRow> {
  const order = await db.orders.get(id)
  if (!order) throw new EngineError('订单不存在')
  if (order.status !== 'open') throw new EngineError(`订单状态不可撤销: ${order.status}`)
  order.status = 'cancelled'
  await db.orders.put(order)
  return order
}

export async function listOrders(status?: string): Promise<OrderRow[]> {
  const all = await db.orders.orderBy('id').reverse().limit(200).toArray()
  return status ? all.filter((o) => o.status === status) : all
}

export async function listTrades(): Promise<TradeRow[]> {
  return db.trades.orderBy('id').reverse().limit(200).toArray()
}

/** 扫描挂单中的限价单，价格触达就成交（与服务器版 worker 同规则，成交价=限价）。 */
export async function scanLimitOrders(priceOf: (symbol: string) => Promise<number | null>): Promise<void> {
  const open = await db.orders.where('status').equals('open').toArray()
  const limits = open.filter((o) => o.type === 'limit')
  if (!limits.length) return
  for (const order of limits) {
    const last = await priceOf(order.symbol)
    if (last === null) continue
    const shouldFill =
      (order.side === 'buy' && last <= (order.price ?? Infinity)) ||
      (order.side === 'sell' && last >= (order.price ?? -Infinity))
    if (!shouldFill) continue
    // 成交前再校验一次（与服务器版一致，不足则撤单）
    const acc = await getAccountState()
    if (order.side === 'buy') {
      const estCost = order.quantity * (order.price ?? 0)
      if (acc.cash < estCost + feeOf(estCost)) {
        order.status = 'cancelled'
        await db.orders.put(order)
        continue
      }
    } else {
      const pos = await getPosition(order.symbol)
      if (!pos || pos.quantity < order.quantity) {
        order.status = 'cancelled'
        await db.orders.put(order)
        continue
      }
    }
    try {
      await applyFill(order, order.price!)
    } catch {
      /* 单笔失败不拖垮整轮扫描 */
    }
  }
}

// ---------- 账户快照（portfolio.build_account_snapshot 的等价实现） ----------

export interface PositionView {
  symbol: string
  quantity: number
  avg_price: number
  last_price: number
  market_value: number
  unrealized_pnl: number
  pnl_pct: number
}

export interface AccountSnapshot {
  cash: number
  initial_capital: number
  position_market_value: number
  total_equity: number
  total_pnl: number
  total_pnl_pct: number
  unrealized_pnl: number
  realized_pnl: number
  total_fees: number
  positions: PositionView[]
}

export async function buildSnapshot(
  priceOf: (symbol: string) => Promise<number | null>
): Promise<AccountSnapshot> {
  const acc = await getAccountState()
  const posRows = (await db.positions.toArray()).filter((p) => p.quantity > 0)
  const allTrades = await db.trades.toArray()
  const realized = allTrades.filter((t) => t.side === 'sell').reduce((s, t) => s + (t.realized_pnl || 0), 0)
  const totalFees = allTrades.reduce((s, t) => s + (t.fee || 0), 0)

  const positions: PositionView[] = []
  let positionMV = 0
  let totalUnrealized = 0
  for (const p of posRows) {
    const last = (await priceOf(p.symbol)) ?? p.avg_price // 拉不到价就按成本价，不炸界面
    const mv = p.quantity * last
    const unrealized = mv - p.quantity * p.avg_price
    positions.push({
      symbol: p.symbol,
      quantity: p.quantity,
      avg_price: p.avg_price,
      last_price: last,
      market_value: mv,
      unrealized_pnl: unrealized,
      pnl_pct: p.avg_price ? ((last - p.avg_price) / p.avg_price) * 100 : 0,
    })
    positionMV += mv
    totalUnrealized += unrealized
  }

  const totalEquity = acc.cash + positionMV
  const totalPnl = totalEquity - acc.initial_capital
  return {
    cash: acc.cash,
    initial_capital: acc.initial_capital,
    position_market_value: positionMV,
    total_equity: totalEquity,
    total_pnl: totalPnl,
    total_pnl_pct: acc.initial_capital ? (totalPnl / acc.initial_capital) * 100 : 0,
    unrealized_pnl: totalUnrealized,
    realized_pnl: realized,
    total_fees: totalFees,
    positions,
  }
}

// ---------- 净值采样与曲线 ----------

let lastSampleAt = 0

/** 采样一条净值点（最快 1 分钟一条），供总览页曲线使用；曲线随使用慢慢长出来。 */
export async function sampleEquity(snap: AccountSnapshot): Promise<void> {
  const now = Date.now()
  if (now - lastSampleAt < 60_000) return
  lastSampleAt = now
  await db.equity.add({
    ts: nowIso(),
    equity: snap.total_equity,
    cash: snap.cash,
    position_value: snap.position_market_value,
    unrealized_pnl: snap.unrealized_pnl,
  })
}

export interface EquityPoint {
  ts: string
  equity: number
  cash: number
  position_value: number
  unrealized_pnl: number
}

export async function equityCurve(range: string): Promise<{
  range: string
  points: EquityPoint[]
  first: number
  last: number
  change: number
  change_pct: number
}> {
  const all = await db.equity.orderBy('ts').toArray()
  const now = Date.now()
  const span: Record<string, number> = {
    '1H': 3600e3,
    '1D': 86400e3,
    '1W': 7 * 86400e3,
    '1M': 30 * 86400e3,
    ALL: Infinity,
  }
  const cutoff = now - (span[range] ?? 86400e3)
  const rows = all.filter((r) => new Date(r.ts).getTime() >= cutoff)
  const points: EquityPoint[] = rows.map((r) => ({
    ts: r.ts,
    equity: r.equity,
    cash: r.cash,
    position_value: r.position_value,
    unrealized_pnl: r.unrealized_pnl,
  }))
  const first = points.length ? points[0].equity : 0
  const last = points.length ? points[points.length - 1].equity : 0
  return {
    range,
    points,
    first,
    last,
    change: last - first,
    change_pct: first ? ((last - first) / first) * 100 : 0,
  }
}

// ---------- 重置与备份 ----------

export async function resetAccount(initialCapital: number): Promise<void> {
  await db.transaction('rw', [db.meta, db.positions, db.orders, db.trades, db.equity], async () => {
    await db.positions.clear()
    await db.orders.clear()
    await db.trades.clear()
    await db.equity.clear()
    await setAccountState({ cash: initialCapital, initial_capital: initialCapital })
  })
}

export interface BackupData {
  app: 'ai-trading-sim'
  version: 1
  exported_at: string
  account: AccountState
  positions: PositionRow[]
  orders: OrderRow[]
  trades: TradeRow[]
  equity: { ts: string; equity: number; cash: number; position_value: number; unrealized_pnl: number }[]
}

export async function exportBackup(): Promise<BackupData> {
  const acc = await getAccountState()
  return {
    app: 'ai-trading-sim',
    version: 1,
    exported_at: nowIso(),
    account: acc,
    positions: await db.positions.toArray(),
    orders: await db.orders.toArray(),
    trades: await db.trades.toArray(),
    equity: (await db.equity.toArray()).map(({ id, ...rest }) => rest),
  }
}

export async function importBackup(data: any): Promise<void> {
  if (!data || data.app !== 'ai-trading-sim' || data.version !== 1) {
    throw new EngineError('备份文件不对：不是 AI 自动交易系统的备份')
  }
  const acc = data.account
  if (!acc || typeof acc.cash !== 'number' || typeof acc.initial_capital !== 'number') {
    throw new EngineError('备份文件损坏：账户数据缺失')
  }
  if (!Array.isArray(data.positions) || !Array.isArray(data.orders) || !Array.isArray(data.trades)) {
    throw new EngineError('备份文件损坏：持仓/订单/成交缺失')
  }
  await db.transaction('rw', [db.meta, db.positions, db.orders, db.trades, db.equity], async () => {
    await db.positions.clear()
    await db.orders.clear()
    await db.trades.clear()
    await db.equity.clear()
    await setAccountState({ cash: acc.cash, initial_capital: acc.initial_capital })
    await db.positions.bulkPut(data.positions)
    await db.orders.bulkPut(data.orders)
    await db.trades.bulkPut(data.trades)
    if (Array.isArray(data.equity)) await db.equity.bulkAdd(data.equity)
  })
}
