/**
 * The frame probe (docs/PERF_OVERALL.md): per-system CPU time of every frame, for the stutter hunt ("the game stutters
 * when walking and turning the camera, at any graphics setting"). Stutter is spikes, so it keeps every frame, not
 * averages: per system p50 / p95 / max, the frame-time histogram, each frame over 33 ms with what ran in it, the long
 * animation frames the browser saw (with their script attribution, style and layout), and the JS heap.
 *
 * Zero cost when off: nothing in the game knows about it. `?bench=1` (or `?charbench=1`) loads the bench module, and
 * `install()` wraps methods of the systems in place (class prototypes, the world's parts as they appear, the scene's
 * observers) only then. A wrapper records only while `start()`..`stop()` samples.
 *
 * Labels nest (inclusive times): `game.frame` (screens/world.ts per-frame observer) holds `entities.*`, `effects`,
 * `world.update` (which holds `world.<part>`, `stream.*`, `grass.*`), `minimap`, `features.*`, `graphics.frame`;
 * `bjs.*` are Babylon's render phases (animations, active-mesh evaluation, render targets = shadows, main draw, post).
 * `outside` is time between frames that is no frame's work (network messages, timers, promise callbacks, GC, the
 * browser's own style/layout/paint): `net.messages` and `stream.job*` that ran there are counted as `outside.*`.
 */
import type { AbstractEngine, Observable, Observer, Scene } from '@babylonjs/core'

type Fn = (...a: unknown[]) => unknown

/** One frame's record. */
interface FrameRec {
  /** performance.now() at the engine's begin-frame. */
  t0: number
  /** Begin-frame to begin-frame of the previous frame (what the player sees). */
  interval: number
  /** Begin to end of the frame (the CPU work of the render loop). */
  cpu: number
  /** Work between the previous frame's end and this frame's begin that the wrappers saw. */
  outside: number
  sys: Map<string, number>
  heapMB: number
  /** Route marks active during the frame (walking, spinning, the leg name). */
  tag: string
  /** WebGPU render pipelines and bind groups Babylon created in the frame (a new pipeline compiles on the main thread). */
  pipelines: number
  bindGroups: number
}

export interface ProbeSummary {
  frames: number
  seconds: number
  fps: number
  frameMs: { p50: number; p95: number; p99: number; max: number; mean: number }
  cpuMs: { p50: number; p95: number; max: number }
  /** Frame-interval histogram: bucket upper bounds (ms) → frames. */
  histogram: Record<string, number>
  over33: number
  over50: number
  /** Per system, ranked by the time it costs in spike frames, then by the mean. */
  systems: { label: string; calls: number; meanMs: number; p50: number; p95: number; max: number; inSpikesMs: number; spikeFrames: number }[]
  /** Every frame over 33 ms (up to 60, worst first): when, how long, its CPU part, the top systems in it. */
  spikes: { atS: number; ms: number; cpu: number; outside: number; tag: string; pipelines: number; pipelinesBefore: number; top: [string, number][] }[]
  /** New render pipelines: in all, in spike frames, and the frames that made any. */
  pipelines: { total: number; inSpikes: number; frames: number; spikeFramesWithPipelines: number; spikeFramesAfterPipelines: number; bindGroups: number }
  /** Long animation frames (Chrome LoAF ≥ 50 ms) during the run: duration, blocking, style+layout, top scripts. */
  longFrames: { atS: number; ms: number; blockingMs: number; styleLayoutMs: number; scripts: [string, number][] }[]
  longTasks: { count: number; totalMs: number; maxMs: number }
  heap: { startMB: number; endMB: number; maxMB: number; drops: number; droppedMB: number } | null
}

const q = (a: readonly number[], p: number): number => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]!
}
const r2 = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0)
const BUCKETS = [8.4, 16.7, 20, 25, 33.4, 50, 100, 250, Infinity]
const WRAPPED = Symbol('sroProbe')

export class FrameProbe {
  private sampling = false
  private cur: FrameRec | null = null
  /** Work done between frames, flushed into the next frame's record. */
  private between = new Map<string, number>()
  private betweenMs = 0
  private lastEnd = 0
  private lastT0 = 0
  private readonly frames: FrameRec[] = []
  private readonly active = new Set<string>()
  private readonly counts = new Map<string, number>()
  private readonly restore: (() => void)[] = []
  private longFrames: ProbeSummary['longFrames'] = []
  private longTasks = { count: 0, totalMs: 0, maxMs: 0 }
  private po: PerformanceObserver[] = []
  private startAt = 0
  /** The route's current tag (route legs set it). */
  tag = ''
  private hooked: Scene | null = null
  private eng: AbstractEngine | null = null

  /** Times `fn` under `label` while sampling (re-entrant calls of one label count once). */
  time<T>(label: string, fn: () => T): T {
    if (!this.sampling || this.active.has(label)) return fn()
    this.active.add(label)
    const t = performance.now()
    try {
      return fn()
    } finally {
      this.active.delete(label)
      this.add(label, performance.now() - t)
    }
  }

  private add(label: string, ms: number): void {
    this.counts.set(label, (this.counts.get(label) ?? 0) + 1)
    if (this.cur) this.cur.sys.set(label, (this.cur.sys.get(label) ?? 0) + ms)
    else if (!this.active.size || label.startsWith('net') || label.startsWith('stream')) {
      // between frames: only the outermost wrapped call counts toward `outside`
      const key = 'outside.' + label
      this.between.set(key, (this.between.get(key) ?? 0) + ms)
      if (!this.active.size) this.betweenMs += ms
    }
  }

  /** Wraps `obj[name]` (an own or inherited method) in place; idempotent. */
  wrap(obj: object | null | undefined, name: string, label: string): void {
    if (!obj) return
    const o = obj as Record<string, unknown>
    const orig = o[name] as (Fn & { [WRAPPED]?: true }) | undefined
    if (typeof orig !== 'function' || orig[WRAPPED]) return
    const probe = this
    const own = Object.prototype.hasOwnProperty.call(o, name)
    const w = function (this: unknown, ...a: unknown[]) {
      return probe.time(label, () => orig.apply(this, a))
    } as Fn & { [WRAPPED]?: true }
    w[WRAPPED] = true
    o[name] = w
    this.restore.push(() => {
      if (own) o[name] = orig
      else delete o[name]
    })
  }

  /** Wraps every listed method of a class prototype under `prefix.method`. */
  wrapProto(proto: object | null | undefined, names: readonly string[], prefix: string): void {
    for (const n of names) this.wrap(proto, n, `${prefix}.${n}`)
  }

  /**
   * Wraps the observers of a scene/engine observable (those there now and those added later), each labelled by its
   * callback's first source line (an unminified build reads well) unless `label` names it.
   */
  wrapObservable(obs: Observable<unknown> | undefined, name: string, label?: (cb: Fn) => string | null): void {
    if (!obs) return
    const probe = this
    const wrapOne = (o: Observer<unknown>) => {
      const cb = o.callback as Fn & { [WRAPPED]?: true }
      if (cb[WRAPPED]) return
      const l = label?.(cb) ?? `${name}:${snippet(cb)}`
      const w = function (this: unknown, ...a: unknown[]) {
        return probe.time(l, () => cb.apply(this, a))
      } as Fn & { [WRAPPED]?: true }
      w[WRAPPED] = true
      o.callback = w as never
    }
    for (const o of obs.observers) wrapOne(o)
    const add = obs.add
    const own = Object.prototype.hasOwnProperty.call(obs, 'add')
    ;(obs as { add: unknown }).add = function (this: Observable<unknown>, ...a: Parameters<typeof add>) {
      const o = add.apply(this, a)
      if (o) wrapOne(o)
      return o
    }
    this.restore.push(() => {
      if (own) (obs as { add: unknown }).add = add
      else delete (obs as { add?: unknown }).add
    })
  }

  /** Marks a callback as the probe's own (never wrapped). */
  private mine<T extends Fn>(f: T): T {
    ;(f as T & { [WRAPPED]?: true })[WRAPPED] = true
    return f
  }

  /** Babylon's phases and the frame boundaries on this scene (once per scene). */
  hookScene(scene: Scene): void {
    if (this.hooked === scene) return
    this.hooked = scene
    const eng: AbstractEngine = scene.getEngine()
    this.eng = eng
    const open: Record<string, number> = {}
    const o = (k: string) => this.mine(() => {
      if (this.cur) open[k] = performance.now()
    })
    const c = (k: string, label: string) => this.mine(() => {
      const t = open[k]
      if (!this.cur || t === undefined) return
      delete open[k]
      this.cur.sys.set(label, (this.cur.sys.get(label) ?? 0) + performance.now() - t)
    })
    eng.onBeginFrameObservable.add(this.mine(() => this.beginFrame()), -1, true)
    eng.onEndFrameObservable.add(this.mine(() => this.endFrame()))
    scene.onBeforeAnimationsObservable.add(o('anim'), -1, true)
    scene.onAfterAnimationsObservable.add(c('anim', 'bjs.animations'))
    scene.onBeforeActiveMeshesEvaluationObservable.add(o('eval'), -1, true)
    scene.onAfterActiveMeshesEvaluationObservable.add(c('eval', 'bjs.activeMeshes'))
    scene.onBeforeRenderTargetsRenderObservable.add(o('rtt'), -1, true)
    scene.onAfterRenderTargetsRenderObservable.add(c('rtt', 'bjs.renderTargets(shadows)'))
    scene.onBeforeDrawPhaseObservable.add(o('draw'), -1, true)
    scene.onAfterDrawPhaseObservable.add(c('draw', 'bjs.mainDraw'))
    scene.onAfterDrawPhaseObservable.add(o('post'))
    scene.onAfterRenderObservable.add(c('post', 'bjs.post'), -1, true)
    // after the last after-render observer: the engine's end of frame (WebGPU: encoders finished and submitted)
    scene.onAfterRenderObservable.add(o('submit'))
    eng.onEndFrameObservable.add(c('submit', 'bjs.endFrame(submit)'), -1, true)
    // every other observer of the frame, each under its own name
    const S = scene as unknown as Record<string, Observable<unknown>>
    for (const n of ['onBeforeRenderObservable', 'onAfterRenderObservable', 'onBeforeAnimationsObservable', 'onAfterAnimationsObservable', 'onBeforeCameraRenderObservable', 'onAfterCameraRenderObservable', 'onBeforeRenderTargetsRenderObservable', 'onAfterRenderTargetsRenderObservable', 'onBeforeDrawPhaseObservable', 'onAfterDrawPhaseObservable', 'onAfterActiveMeshesEvaluationObservable']) {
      this.wrapObservable(S[n], 'obs.' + n.replace(/^on|Observable$/g, ''), n === 'onBeforeRenderObservable' ? cb => (/timeline\.tick/.test(String(cb)) ? 'game.frame' : null) : undefined)
    }
    const E = eng as unknown as Record<string, Observable<unknown>>
    for (const n of ['onBeginFrameObservable', 'onEndFrameObservable']) this.wrapObservable(E[n], 'obs.' + n.replace(/^on|Observable$/g, ''))
  }

  private beginFrame(): void {
    if (!this.sampling) return
    const t0 = performance.now()
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
    this.cur = {
      t0,
      interval: this.lastT0 ? t0 - this.lastT0 : 0,
      cpu: 0,
      outside: this.betweenMs,
      sys: this.between,
      heapMB: mem ? mem.usedJSHeapSize / 1048576 : 0,
      tag: this.tag,
      pipelines: 0,
      bindGroups: 0,
    }
    this.between = new Map()
    this.betweenMs = 0
    this.lastT0 = t0
  }

  private endFrame(): void {
    const r = this.cur
    if (!r) return
    const t = performance.now()
    r.cpu = t - r.t0
    this.lastEnd = t
    // Babylon's WebGPU caches move this frame's counts to the *LastFrame statics before the end-frame observers run
    const e = this.eng as unknown as { _cacheRenderPipeline?: { constructor: { NumPipelineCreationLastFrame?: number } }; _cacheBindGroups?: { constructor: { NumBindGroupsCreatedLastFrame?: number } } } | null
    r.pipelines = e?._cacheRenderPipeline?.constructor.NumPipelineCreationLastFrame ?? 0
    r.bindGroups = e?._cacheBindGroups?.constructor.NumBindGroupsCreatedLastFrame ?? 0
    this.cur = null
    if (r.interval > 0) this.frames.push(r)
  }

  start(): void {
    this.frames.length = 0
    this.counts.clear()
    this.between = new Map()
    this.betweenMs = 0
    this.lastT0 = 0
    this.longFrames = []
    this.longTasks = { count: 0, totalMs: 0, maxMs: 0 }
    this.startAt = performance.now()
    this.sampling = true
    const observe = (type: string, cb: (e: PerformanceEntry) => void) => {
      try {
        const po = new PerformanceObserver(l => l.getEntries().forEach(cb))
        po.observe({ type, buffered: false })
        this.po.push(po)
      } catch {
        // not in this browser
      }
    }
    observe('long-animation-frame', e => {
      const f = e as PerformanceEntry & { blockingDuration?: number; styleAndLayoutStart?: number; renderStart?: number; scripts?: { invoker?: string; sourceURL?: string; sourceFunctionName?: string; duration: number }[] }
      const scripts = (f.scripts ?? []).map(s => [`${s.invoker ?? ''} ${s.sourceFunctionName ?? ''} ${(s.sourceURL ?? '').split('/').pop() ?? ''}`.trim(), r2(s.duration)] as [string, number]).sort((a, b) => b[1] - a[1]).slice(0, 4)
      const sl = f.styleAndLayoutStart ? e.startTime + e.duration - f.styleAndLayoutStart : 0
      this.longFrames.push({ atS: r2((e.startTime - this.startAt) / 1000), ms: r2(e.duration), blockingMs: r2(f.blockingDuration ?? 0), styleLayoutMs: r2(sl), scripts })
    })
    observe('longtask', e => {
      this.longTasks.count++
      this.longTasks.totalMs += e.duration
      this.longTasks.maxMs = Math.max(this.longTasks.maxMs, e.duration)
    })
  }

  stop(): ProbeSummary {
    this.sampling = false
    this.cur = null
    for (const p of this.po) p.disconnect()
    this.po = []
    return this.summary()
  }

  /** Removes every wrapper (the probe stays usable: install again). */
  uninstall(): void {
    for (const r of this.restore.splice(0).reverse()) r()
  }

  summary(): ProbeSummary {
    const F = this.frames
    const iv = F.map(f => f.interval)
    const cpu = F.map(f => f.cpu)
    const hist: Record<string, number> = {}
    for (const b of BUCKETS) hist[b === Infinity ? '>250' : `<=${b}`] = 0
    for (const v of iv) {
      const b = BUCKETS.find(x => v <= x)!
      hist[b === Infinity ? '>250' : `<=${b}`]!++
    }
    const per = new Map<string, number[]>()
    const inSpikes = new Map<string, { ms: number; n: number }>()
    for (const f of F) {
      for (const [k, v] of f.sys) {
        let a = per.get(k)
        if (!a) per.set(k, (a = []))
        a.push(v)
        if (f.interval > 33.4) {
          const s = inSpikes.get(k) ?? { ms: 0, n: 0 }
          s.ms += v
          s.n++
          inSpikes.set(k, s)
        }
      }
    }
    const n = F.length || 1
    const systems = [...per].map(([label, a]) => ({
      label,
      calls: this.counts.get(label.replace(/^outside\./, '')) ?? a.length,
      meanMs: r2(a.reduce((x, y) => x + y, 0) / n),
      p50: r2(q(a, 0.5)),
      p95: r2(q(a, 0.95)),
      max: r2(Math.max(...a)),
      inSpikesMs: r2(inSpikes.get(label)?.ms ?? 0),
      spikeFrames: inSpikes.get(label)?.n ?? 0,
    }))
    systems.sort((a, b) => b.inSpikesMs - a.inSpikesMs || b.meanMs - a.meanMs)
    const idx = new Map(F.map((f, i) => [f, i]))
    const before = (f: FrameRec) => {
      const i = idx.get(f)!
      let n = 0
      for (let j = Math.max(0, i - 3); j < i; j++) n += F[j]!.pipelines
      return n
    }
    const spikes = F.filter(f => f.interval > 33.4)
      .sort((a, b) => b.interval - a.interval)
      .slice(0, 60)
      .map(f => ({
        atS: r2((f.t0 - this.startAt) / 1000),
        ms: r2(f.interval),
        cpu: r2(f.cpu),
        outside: r2(f.outside),
        tag: f.tag,
        pipelines: f.pipelines,
        pipelinesBefore: before(f),
        top: [...f.sys].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => [k, r2(v)] as [string, number]),
      }))
    const heaps = F.map(f => f.heapMB).filter(h => h > 0)
    let drops = 0
    let dropped = 0
    for (let i = 1; i < heaps.length; i++) {
      const d = heaps[i - 1]! - heaps[i]!
      if (d > 1) {
        drops++
        dropped += d
      }
    }
    const secs = F.length ? (F.at(-1)!.t0 - F[0]!.t0) / 1000 : 0
    return {
      frames: F.length,
      seconds: r2(secs),
      fps: r2(secs > 0 ? F.length / secs : 0),
      frameMs: { p50: r2(q(iv, 0.5)), p95: r2(q(iv, 0.95)), p99: r2(q(iv, 0.99)), max: r2(Math.max(0, ...iv)), mean: r2(iv.reduce((a, b) => a + b, 0) / n) },
      cpuMs: { p50: r2(q(cpu, 0.5)), p95: r2(q(cpu, 0.95)), max: r2(Math.max(0, ...cpu)) },
      histogram: hist,
      over33: iv.filter(v => v > 33.4).length,
      over50: iv.filter(v => v > 50).length,
      systems,
      spikes,
      pipelines: {
        total: F.reduce((a, f) => a + f.pipelines, 0),
        inSpikes: F.filter(f => f.interval > 33.4).reduce((a, f) => a + f.pipelines, 0),
        frames: F.filter(f => f.pipelines > 0).length,
        spikeFramesWithPipelines: F.filter(f => f.interval > 33.4 && f.pipelines > 0).length,
        spikeFramesAfterPipelines: F.filter(f => f.interval > 33.4 && f.pipelines === 0 && before(f) > 0).length,
        bindGroups: F.reduce((a, f) => a + f.bindGroups, 0),
      },
      longFrames: this.longFrames.sort((a, b) => b.ms - a.ms).slice(0, 40),
      longTasks: { count: this.longTasks.count, totalMs: r2(this.longTasks.totalMs), maxMs: r2(this.longTasks.maxMs) },
      heap: heaps.length ? { startMB: r2(heaps[0]!), endMB: r2(heaps.at(-1)!), maxMB: r2(Math.max(...heaps)), drops, droppedMB: r2(dropped) } : null,
    }
  }
}

/** A callback's first meaningful source line (labels of anonymous observers). */
function snippet(f: Fn): string {
  const s = String(f).replace(/\s+/g, ' ')
  return (f.name ? f.name + ' ' : '') + s.slice(s.indexOf('{') + 1, s.indexOf('{') + 56).trim()
}
