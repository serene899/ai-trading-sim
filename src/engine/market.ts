/**
 * 行情：浏览器直连 OKX 公共接口（无需 Key，OKX 对公开接口放行跨域）。
 * 与服务器版 exchange.py 同口径：ticker 2 秒缓存、K线 5 秒缓存，
 * 请求失败时回退到上一次缓存，避免行情抖动把界面打挂。
 */

const OKX_BASE = 'https://www.okx.com'
const TIMEOUT_MS = 8000
const TICKER_TTL = 2000
const KLINE_TTL = 5000

export const DEFAULT_SYMBOLS = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'BNB-USDT', 'XRP-USDT', 'DOGE-USDT']

export interface Ticker {
  symbol: string
  last: number
  high24h?: number
  low24h?: number
  vol24h?: number
  change24h?: number
  bid?: number
  ask?: number
}

const tickerCache = new Map<string, { ts: number; data: Ticker }>()
let tickersCache: { ts: number; key: string; data: Ticker[] } | null = null
const klineCache = new Map<string, { ts: number; data: number[][] }>()

async function okxGet(path: string, params: Record<string, string>): Promise<any[]> {
  const url = new URL(OKX_BASE + path)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const resp = await fetch(url.toString(), { signal: ctrl.signal })
    if (!resp.ok) throw new Error(`OKX HTTP ${resp.status}`)
    const json = await resp.json()
    if (json.code !== '0') throw new Error(`OKX API error: ${json.msg}`)
    return json.data ?? []
  } finally {
    clearTimeout(timer)
  }
}

function toTicker(t: any): Ticker {
  const last = parseFloat(t.last)
  const open = parseFloat(t.open24h || t.last)
  return {
    symbol: t.instId,
    last,
    bid: parseFloat(t.bidPx || '0'),
    ask: parseFloat(t.askPx || '0'),
    high24h: parseFloat(t.high24h || '0'),
    low24h: parseFloat(t.low24h || '0'),
    vol24h: parseFloat(t.vol24h || '0'),
    change24h: t.open24h ? (last - open) / (open || 1) : 0,
  }
}

export async function getTicker(symbol: string): Promise<Ticker> {
  const cached = tickerCache.get(symbol)
  if (cached && Date.now() - cached.ts <= TICKER_TTL) return cached.data
  try {
    const data = await okxGet('/api/v5/market/ticker', { instId: symbol })
    if (!data.length) throw new Error(`No ticker for ${symbol}`)
    const result = toTicker(data[0])
    tickerCache.set(symbol, { ts: Date.now(), data: result })
    return result
  } catch (e) {
    if (cached) return cached.data // 过期缓存也先用着
    throw e
  }
}

export async function getTickers(symbols: string[] = DEFAULT_SYMBOLS): Promise<Ticker[]> {
  const key = symbols.join(',')
  if (tickersCache && tickersCache.key === key && Date.now() - tickersCache.ts <= TICKER_TTL) {
    return tickersCache.data
  }
  try {
    const data = await okxGet('/api/v5/market/tickers', { instType: 'SPOT' })
    const wanted = new Set(symbols)
    const result = data.filter((t: any) => wanted.has(t.instId)).map(toTicker)
    const order = new Map(symbols.map((s, i) => [s, i]))
    result.sort((a, b) => (order.get(a.symbol) ?? 999) - (order.get(b.symbol) ?? 999))
    tickersCache = { ts: Date.now(), key, data: result }
    result.forEach((t) => tickerCache.set(t.symbol, { ts: Date.now(), data: t }))
    return result
  } catch (e) {
    if (tickersCache && tickersCache.key === key) return tickersCache.data
    throw e
  }
}

const BAR_MAP: Record<string, string> = {
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6H', '12h': '12H',
  '1d': '1D', '1w': '1W', '1M': '1M',
}

/** K线：[[ts, open, high, low, close, vol], ...] 时间升序，与服务器版一致。 */
export async function getKline(symbol: string, interval = '1m', limit = 100): Promise<number[][]> {
  const key = `${symbol}|${interval}|${limit}`
  const cached = klineCache.get(key)
  if (cached && Date.now() - cached.ts <= KLINE_TTL) return cached.data
  const bar = BAR_MAP[interval.toLowerCase()] ?? '1m'
  const raw = await okxGet('/api/v5/market/candles', { instId: symbol, bar, limit: String(limit) })
  // OKX 返回时间倒序，转成升序并只取 [ts,o,h,l,c,vol]
  const candles = raw
    .map((c: any[]) => [Number(c[0]), Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4]), Number(c[5])])
    .sort((a, b) => a[0] - b[0])
  klineCache.set(key, { ts: Date.now(), data: candles })
  return candles
}

/** 只取最新价（引擎算账/扫限价单用）；拿不到返回 null，不抛错。 */
export async function lastPriceOrNull(symbol: string): Promise<number | null> {
  try {
    const t = await getTicker(symbol)
    return t.last
  } catch {
    return null
  }
}
