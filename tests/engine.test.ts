/**
 * 本地引擎测试：交易数学与服务器版 2026-11-19 实测数字逐项对齐
 * （同一组向量：本金 10000、费率 0.1%、关滑点、假价格）。
 * 另测：限价单触发、资金/持仓不足拦截、备份导出→清空→导入还原。
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../src/engine/db'
import {
  buildSnapshot,
  engineConfig,
  exportBackup,
  importBackup,
  listTrades,
  placeOrder,
  resetAccount,
  scanLimitOrders,
} from '../src/engine/engine'
import { describeTrend, movingAverage, riskLevel, volatilityPct } from '../src/engine/analysis'

const EPS = 1e-6
const at = (price: number) => async () => price

beforeEach(async () => {
  engineConfig.slippagePct = 0 // 专心核对手续费/盈亏数学，与服务器版测试同设置
  await db.delete()
  await db.open()
  await resetAccount(10000)
})

describe('交易全流程（对齐服务器版实测）', () => {
  it('买入→涨价→部分平仓→全部平仓，现金/盈亏/手续费全对账', async () => {
    // 买 0.5 BTC @100：成交额 50，费 0.05，现金 9949.95，均价（含费）100.1
    await placeOrder({ symbol: 'BTC-USDT', side: 'buy', type: 'market', quantity: 0.5 }, 100)
    let snap = await buildSnapshot(at(100))
    expect(snap.cash).toBeCloseTo(9949.95, 6)
    expect(snap.positions[0].avg_price).toBeCloseTo(100.1, 6)

    // 涨到 120：市值 60，未实现 +9.95，总权益 10009.95
    snap = await buildSnapshot(at(120))
    expect(snap.positions[0].market_value).toBeCloseTo(60, 6)
    expect(snap.unrealized_pnl).toBeCloseTo(9.95, 6)
    expect(snap.total_equity).toBeCloseTo(10009.95, 6)

    // 部分平仓 0.2 @120：费 0.024，已实现 +3.956，现金 9973.926，剩 0.3
    await placeOrder({ symbol: 'BTC-USDT', side: 'sell', type: 'market', quantity: 0.2 }, 120)
    snap = await buildSnapshot(at(120))
    expect(snap.cash).toBeCloseTo(9973.926, 6)
    expect(snap.positions[0].quantity).toBeCloseTo(0.3, 8)
    expect(snap.realized_pnl).toBeCloseTo(3.956, 6)
    // 恒等式：总盈亏 = 已实现 + 未实现
    expect(snap.total_pnl).toBeCloseTo(snap.realized_pnl + snap.unrealized_pnl, 6)

    // 全部平仓 0.3 @120：费 0.036，现金=总权益=10009.89，总盈亏 9.89
    await placeOrder({ symbol: 'BTC-USDT', side: 'sell', type: 'market', quantity: 0.3 }, 120)
    snap = await buildSnapshot(at(120))
    expect(snap.cash).toBeCloseTo(10009.89, 6)
    expect(snap.total_equity).toBeCloseTo(10009.89, 6)
    expect(snap.total_pnl).toBeCloseTo(9.89, 6)
    expect(snap.positions.length).toBe(0)

    // 三笔手续费合计 0.110
    const trades = await listTrades()
    expect(trades.length).toBe(3)
    expect(trades.reduce((s, t) => s + (t.fee || 0), 0)).toBeCloseTo(0.11, 6)
    expect(snap.total_fees).toBeCloseTo(0.11, 6)
  })

  it('资金不足买入被拦、超持仓卖出被拦', async () => {
    await expect(
      placeOrder({ symbol: 'BTC-USDT', side: 'buy', type: 'market', quantity: 200 }, 100)
    ).rejects.toThrow('现金余额不足')
    await expect(
      placeOrder({ symbol: 'BTC-USDT', side: 'sell', type: 'market', quantity: 0.1 }, 100)
    ).rejects.toThrow('持仓不足')
  })

  it('限价单挂单不成交，价格触达后按限价成交', async () => {
    const order = await placeOrder(
      { symbol: 'BTC-USDT', side: 'buy', type: 'limit', quantity: 0.1, price: 90 },
      100
    )
    expect(order.status).toBe('open')
    await scanLimitOrders(at(95))
    let snap = await buildSnapshot(at(95))
    expect(snap.positions.length).toBe(0)
    await scanLimitOrders(at(89))
    snap = await buildSnapshot(at(89))
    expect(snap.positions.length).toBe(1)
    expect(snap.positions[0].quantity).toBeCloseTo(0.1, 8)
    // 按限价 90 成交：成本 9 + 费 0.009
    expect(snap.cash).toBeCloseTo(10000 - 9.009, 6)
  })

  it('备份导出→重置→导入，账户原样还原', async () => {
    await placeOrder({ symbol: 'ETH-USDT', side: 'buy', type: 'market', quantity: 2 }, 3000)
    const before = await buildSnapshot(at(3100))
    const backup = await exportBackup()
    await resetAccount(10000)
    const wiped = await buildSnapshot(at(3100))
    expect(wiped.positions.length).toBe(0)
    await importBackup(JSON.parse(JSON.stringify(backup)))
    const after = await buildSnapshot(at(3100))
    expect(after.cash).toBeCloseTo(before.cash, 6)
    expect(after.total_equity).toBeCloseTo(before.total_equity, 6)
    expect(after.positions[0].quantity).toBeCloseTo(2, 8)
    await expect(importBackup({ app: 'other', version: 1 })).rejects.toThrow('不是 AI 自动交易系统')
  })
})

describe('分析纯函数', () => {
  it('均线/波动率/趋势/风险等级', () => {
    expect(movingAverage([1, 2, 3, 4, 5], 5)).toBeCloseTo(3, EPS)
    expect(movingAverage([1, 2], 5)).toBeNull()
    const flat = Array(30).fill(100)
    expect(volatilityPct(flat)).toBeCloseTo(0, EPS)
    expect(riskLevel(0)).toBe('低')
    expect(riskLevel(1.0)).toBe('中')
    expect(riskLevel(2.0)).toBe('高')
    expect(riskLevel(null)).toContain('未知')
    expect(describeTrend(110, 100, 115)).toContain('上方')
    expect(describeTrend(null, 100, 115)).toContain('不足')
  })
})
