/**
 * Network and tick metrics (docs/NETWORK_AUDIT.md §Measure): message counts and bytes by type in each direction, the
 * tick-time distribution, connections and disconnect reasons. Always collected (a few map increments per message);
 * read by GET /netstats, which the server answers only with NET_STATS=1 and only to loopback (the load test,
 * src/cli/netload.ts).
 */

/** Ticks kept for the percentiles (60 s at 20 Hz). */
const TICK_RING = 1200

export interface TypeCount {
  n: number
  bytes: number
}

export interface NetStatsSnapshot {
  at: number
  uptimeS: number
  in: Record<string, TypeCount>
  out: Record<string, TypeCount>
  inTotal: TypeCount
  outTotal: TypeCount
  /** Server-side drops of outbound messages (backpressure). */
  dropped: Record<string, number>
  tick: { n: number; p50: number; p95: number; p99: number; max: number; budgetMs: number }
  connections: { opened: number; open: number }
  disconnects: Record<string, number>
  process: { rssMb: number; heapMb: number; cpuUserMs: number; cpuSystemMs: number }
}

export class NetStats {
  private readonly inT = new Map<string, TypeCount>()
  private readonly outT = new Map<string, TypeCount>()
  private readonly drops = new Map<string, number>()
  private readonly closes = new Map<string, number>()
  private readonly ticks = new Float64Array(TICK_RING)
  private tickN = 0
  private tickMax = 0
  opened = 0
  open = 0
  readonly started = Date.now()

  constructor(readonly tickHz = 20) {}

  private static add(m: Map<string, TypeCount>, t: string, bytes: number): void {
    const c = m.get(t)
    if (c) {
      c.n++
      c.bytes += bytes
    } else m.set(t, { n: 1, bytes })
  }

  recvd(t: string, bytes: number): void {
    NetStats.add(this.inT, t, bytes)
  }

  sent(t: string, bytes: number): void {
    NetStats.add(this.outT, t, bytes)
  }

  dropped(t: string): void {
    this.drops.set(t, (this.drops.get(t) ?? 0) + 1)
  }

  tick(ms: number): void {
    this.ticks[this.tickN % TICK_RING] = ms
    this.tickN++
    if (ms > this.tickMax) this.tickMax = ms
  }

  /** One disconnect; `reason` is short and low-cardinality ('client 1001', 'not reading', 'heartbeat timeout'). */
  closed(reason: string): void {
    this.closes.set(reason, (this.closes.get(reason) ?? 0) + 1)
  }

  /** Clears the counters (the load test's phases), keeping open connections. */
  reset(): void {
    this.inT.clear()
    this.outT.clear()
    this.drops.clear()
    this.closes.clear()
    this.tickN = 0
    this.tickMax = 0
    this.opened = 0
  }

  snapshot(now = Date.now()): NetStatsSnapshot {
    const sum = (m: Map<string, TypeCount>): TypeCount => {
      let n = 0
      let bytes = 0
      for (const c of m.values()) {
        n += c.n
        bytes += c.bytes
      }
      return { n, bytes }
    }
    const k = Math.min(this.tickN, TICK_RING)
    const sorted = Array.from(this.ticks.subarray(0, k)).sort((a, b) => a - b)
    const pct = (p: number) => (k ? Math.round(sorted[Math.min(k - 1, Math.floor(p * k))]! * 100) / 100 : 0)
    const mem = process.memoryUsage()
    const cpu = process.cpuUsage()
    return {
      at: now,
      uptimeS: Math.round((now - this.started) / 1000),
      in: Object.fromEntries(this.inT),
      out: Object.fromEntries(this.outT),
      inTotal: sum(this.inT),
      outTotal: sum(this.outT),
      dropped: Object.fromEntries(this.drops),
      tick: { n: this.tickN, p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: Math.round(this.tickMax * 100) / 100, budgetMs: 1000 / this.tickHz },
      connections: { opened: this.opened, open: this.open },
      disconnects: Object.fromEntries(this.closes),
      process: { rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576), cpuUserMs: Math.round(cpu.user / 1000), cpuSystemMs: Math.round(cpu.system / 1000) },
    }
  }
}

/** 127.0.0.0/8, ::1 and their IPv4-mapped forms. */
export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr
  return a === '::1' || a.startsWith('127.')
}
