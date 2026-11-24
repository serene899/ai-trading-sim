/**
 * 规则版行情分析 —— 服务器版 analysis.py 的等价移植。
 * 定位不变：只做指标解读、风险提示、复盘素材；不给买卖指令、不预测涨跌，
 * 界面与数据都必须带 disclaimer 原文。以后接大模型也只能在本结果之上做解读。
 */
import { getKline, getTicker, getTickers } from './market'
import { buildSnapshot } from './engine'

export const DISCLAIMER = '本分析由本地规则指标生成，仅供学习参考，不构成交易信号或投资建议。'

export function movingAverage(values: number[], window: number): number | null {
  if (window <= 0 || values.length < window) return null
  const seg = values.slice(-window)
  return seg.reduce((s, v) => s + v, 0) / window
}

export function volatilityPct(closes: number[], window = 20): number | null {
  if (closes.length < window + 1) return null
  const seg = closes.slice(-(window + 1))
  const rets: number[] = []
  for (let i = 1; i < seg.length; i++) {
    if (seg[i - 1] > 0) rets.push(Math.log(seg[i] / seg[i - 1]))
  }
  if (rets.length < 2) return null
  const mean = rets.reduce((s, v) => s + v, 0) / rets.length
  const variance = rets.reduce((s, v) => s + (v - mean) ** 2, 0) / rets.length // 总体标准差，与 Python pstdev 一致
  return Math.sqrt(variance) * 100
}

export function describeTrend(maShort: number | null, maLong: number | null, last: number): string {
  if (maShort === null || maLong === null) return 'K 线数据不足，暂时无法判断均线趋势。'
  let base: string
  if (maShort > maLong) base = '短期均线在长期均线上方，近期价格强于中期平均成本。'
  else if (maShort < maLong) base = '短期均线在长期均线下方，近期价格弱于中期平均成本。'
  else base = '短期均线与长期均线基本重合，趋势方向不明显。'
  base += last > maShort ? '现价位于短期均线上方。' : '现价位于短期均线下方。'
  return base
}

export function riskLevel(volPct: number | null): string {
  if (volPct === null) return '未知（数据不足）'
  if (volPct < 0.5) return '低'
  if (volPct < 1.5) return '中'
  return '高'
}

export interface AnalysisResult {
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
  position: (import('./engine').PositionView & { weight_pct: number }) | null
  notes: string[]
  disclaimer: string
}

export async function analyzeSymbol(symbol: string): Promise<AnalysisResult> {
  const ticker = await getTicker(symbol)
  const tickers = await getTickers([symbol])
  const change24h = tickers.length ? tickers[0].change24h ?? 0 : 0
  const candles = await getKline(symbol, '1h', 100)
  const closes = candles.map((c) => c[4])

  const last = ticker.last
  const ma5 = movingAverage(closes, 5)
  const ma20 = movingAverage(closes, 20)
  const vol = volatilityPct(closes, 20)
  const level = riskLevel(vol)

  const snapshot = await buildSnapshot(async (s) => {
    try {
      return (await getTicker(s)).last
    } catch {
      return null
    }
  })
  let position: AnalysisResult['position'] = null
  const notes: string[] = []
  for (const p of snapshot.positions) {
    if (p.symbol === symbol) {
      const weight = snapshot.total_equity ? (p.market_value / snapshot.total_equity) * 100 : 0
      position = { ...p, weight_pct: weight }
      if (weight > 50) notes.push(`该币种占总资产 ${weight.toFixed(1)}%，仓位高度集中，单个币种波动会主导账户盈亏。`)
      if (p.pnl_pct <= -10) notes.push(`该持仓浮亏已达 ${p.pnl_pct.toFixed(1)}%，复盘一下当初的买入理由是否还成立。`)
      if (p.pnl_pct >= 20) notes.push(`该持仓浮盈已达 ${p.pnl_pct.toFixed(1)}%，注意这只是未实现盈亏，平仓后还要扣卖出手续费。`)
      break
    }
  }
  if (position === null) notes.push('当前没有该币种持仓，这份分析只反映市场状态，与账户无关。')
  if (level === '高') notes.push('近期波动率处于高档，同样的仓位金额，盈亏摆动会明显大于平时。')
  if (Math.abs(change24h) >= 0.1) {
    notes.push(`24 小时涨跌幅已达 ${(change24h * 100).toFixed(1)}%，属于大波动日，追涨杀跌的成本（滑点+手续费）会被放大。`)
  }

  return {
    symbol,
    source: 'OKX 公共行情',
    updated_at: new Date().toISOString(),
    price: last,
    change24h_pct: change24h * 100,
    ma5,
    ma20,
    trend: describeTrend(ma5, ma20, last),
    volatility_pct: vol,
    risk_level: level,
    position,
    notes,
    disclaimer: DISCLAIMER,
  }
}
