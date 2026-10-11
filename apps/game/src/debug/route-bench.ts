/**
 * The route bench (docs/PERF_OVERALL.md): a fixed, repeatable walk with the frame probe on, for the stutter hunt.
 * Noon, clear weather held, the bench character teleported to the Jangan plaza; then
 *
 *   spin-plaza   6 s standing, the camera orbiting at SPIN_DEG_S (turning the camera in town)
 *   walk-town    walking out of Jangan towards the Grassland (waypoints, the server's path), the camera orbiting slowly
 *   walk-fields  on into the fields to the Grassland place (a blocked waypoint is reached by a GM hop, counted)
 *   spin-fields  6 s standing in the grass, the camera orbiting
 *
 * then (optional) the grass cost: the fields frame with the grass meshes drawn and hidden, interleaved.
 * Every leg sets the probe's tag, so each spike says where it happened. Runs on the display's own frame pacing
 * (requestAnimationFrame: the frames the player sees), not the uncapped pump of `measure`.
 */
import { AbstractMesh, AnimationGroup, EngineInstrumentation, Geometry, Material, Mesh, Skeleton, TransformNode, type Observer, type Scene } from '@babylonjs/core'
import type { World } from '@sro/world-render'
import { CharacterActor, ModelLibrary } from '../three/models.ts'
import { CrowdBudget } from '../world/crowd-budget.ts'
import { EffectList } from '../world/effects.ts'
import { EntityView } from '../world/entities.ts'
import { WORLD_FEATURES, type WorldFeature, type WorldFeatureContext, type WorldFeatureFactory } from '../world/features.ts'
import { WorldGraphics } from '../world/graphics.ts'
import { intents } from '../world/intents.ts'
import { HudMinimap } from '../world/jangan/minimap.ts'
import { NameplateLayout } from '../world/nameplates.ts'
import { PipelineWarm } from '../screens/pipelines.ts'
import { FrameProbe, type ProbeSummary } from './frame-probe.ts'

/**
 * The plaza start (the char bench's spot) and the Grassland GM place (the jangan-fields manifest's places): ≈ 330 m,
 * walked as waypoints every WAYPOINT_M on the straight line (the server paths each); the first half is the town leg.
 */
export const ROUTE = {
  start: { x: 101, z: -56 },
  end: { x: -146, z: 167 },
} as const
export const WAYPOINT_M = 30

/** The route's waypoints, each tagged with its leg. */
export function routeWaypoints(): { tag: string; x: number; z: number }[] {
  const { start: a, end: b } = ROUTE
  const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / WAYPOINT_M)
  return Array.from({ length: n }, (_, i) => {
    const k = (i + 1) / n
    return { tag: k <= 0.5 ? 'walk-town' : 'walk-fields', x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k }
  })
}
export const SPIN_DEG_S = 90
export const WALK_SPIN_DEG_S = 30

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Own-prototype methods of a class worth timing (no constructor, getters, tiny per-sample lookups). */
function methodsOf(proto: object, skip: RegExp = /^(constructor|densityAt|meadowAt|lightAt|heightAt|state|chunk|regionOf|navCovers|progress|isDone)$/): string[] {
  return Object.getOwnPropertyNames(proto).filter(n => !skip.test(n) && typeof Object.getOwnPropertyDescriptor(proto, n)?.value === 'function')
}

let factoriesWrapped = false

/**
 * The systems the probe times (once per page for the classes; the world's parts each time a new world appears).
 * Called at install (the feature factories must be wrapped before the world screen builds its features).
 */
export function instrumentClasses(probe: FrameProbe): void {
  probe.wrapProto(EntityView.prototype, ['update', 'updateLabel', 'dispose', 'die', 'beginFade'], 'entities')
  // what a despawn costs (entities.dispose holds these)
  probe.wrapProto(CharacterActor.prototype, ['dispose'], 'actor')
  probe.wrapProto(AnimationGroup.prototype, ['dispose', 'stop'], 'bjs.AnimationGroup')
  probe.wrapProto(AbstractMesh.prototype, ['dispose'], 'bjs.mesh')
  probe.wrapProto(TransformNode.prototype, ['dispose'], 'bjs.node')
  probe.wrapProto(Skeleton.prototype, ['dispose'], 'bjs.skeleton')
  probe.wrapProto(Material.prototype, ['dispose'], 'bjs.material')
  probe.wrapProto(Mesh.prototype, ['releaseSubMeshes'], 'bjs.mesh')
  probe.wrapProto(Geometry.prototype, ['releaseForMesh'], 'bjs.geometry')
  probe.wrapProto(EffectList.prototype, ['update'], 'effects')
  probe.wrapProto(WorldGraphics.prototype, ['frame'], 'graphics')
  probe.wrapProto(HudMinimap.prototype, ['update'], 'minimap')
  probe.wrapProto(CrowdBudget.prototype, ['update', 'plan'], 'crowd')
  probe.wrapProto(ModelLibrary.prototype, ['lodActors', 'cullActors', 'character', 'dress', 'ensureClips'], 'models')
  probe.wrapProto(CharacterActor.prototype, ['setOutfitMerge', 'setMergeParts', 'setCrowd', 'lodTick'], 'actor')
  probe.wrapProto(NameplateLayout.prototype, methodsOf(NameplateLayout.prototype), 'nameplates')
  if (factoriesWrapped) return
  factoriesWrapped = true
  const list = WORLD_FEATURES as WorldFeatureFactory[]
  for (let i = 0; i < list.length; i++) {
    const make = list[i]!
    const name = make.name || `feature${i}`
    const wrapped: WorldFeatureFactory = ctx => {
      const f: WorldFeature = make(ctx)
      probe.wrap(f, 'onFrame', `feature.${name}`)
      probe.wrap(f, 'onEntityRemoved', `removed.${name}`)
      probe.wrap(f, 'onEntityAdded', `added.${name}`)
      return f
    }
    Object.defineProperty(wrapped, 'name', { value: make.name })
    list[i] = wrapped
  }
}

let wrappedWorld: World | null = null

/** The world's parts (World.update's steps), the streamer, the grass; and the network's message handler. */
export function instrumentWorld(probe: FrameProbe, ctx: WorldFeatureContext): void {
  probe.hookScene(ctx.scene)
  const wire = (ctx.session as unknown as { wire?: { onMessage?: (m: { t: string }) => void } | null }).wire
  if (wire?.onMessage && !(wire.onMessage as { sroNet?: true }).sroNet) {
    const orig = wire.onMessage
    const w = (m: { t: string }) => probe.time('net.messages', () => probe.time('net.' + m.t, () => orig(m)))
    ;(w as { sroNet?: true }).sroNet = true
    wire.onMessage = w
  }
  const world = ctx.world()?.world ?? null
  if (!world || world === wrappedWorld) return
  wrappedWorld = world
  probe.wrap(world, 'update', 'world.update')
  probe.wrap(world, 'applyEnv', 'world.applyEnv')
  const W = world as unknown as Record<string, Record<string, unknown> | null | undefined>
  for (const part of ['sky', 'weather', 'winter', 'nearFade', 'render', 'objects', 'trees', 'ocean', 'scatter', 'grassTint', 'life', 'town']) probe.wrap(W[part], 'update', `world.${part}`)
  probe.wrap(W.objects, 'tickAnimationSpeed', 'world.objects.tickAnim')
  const scatter = W.scatter as { field?: object | null; grass?: object | null } | null | undefined
  if (scatter?.field) probe.wrapProto(Object.getPrototypeOf(scatter.field), methodsOf(Object.getPrototypeOf(scatter.field)), 'grass')
  probe.wrap(scatter?.grass, 'update', 'grass.uniforms')
  probe.wrap(scatter, 'generate', 'scatter.generate')
  const stream = world.stream as unknown as Record<string, unknown> | null
  if (stream) {
    probe.wrapProto(Object.getPrototypeOf(stream), methodsOf(Object.getPrototypeOf(stream)), 'stream')
    probe.wrap(stream.models as object, 'update', 'stream.models.update')
    // each budgeted job (one job can overrun the budget: the hitch), commit steps under their own names
    const jobs = stream.jobs as { pop(): { run: () => void; sroJob?: true } | undefined } | undefined
    const pop = jobs?.pop.bind(jobs)
    if (jobs && pop) {
      jobs.pop = () => {
        const j = pop()
        if (j && !j.sroJob) {
          const run = j.run
          j.run = () => probe.time('stream.job', run)
          j.sroJob = true
        }
        return j
      }
    }
    for (const s of (stream.steps as { name: string; run: (r: unknown) => void }[] | undefined) ?? []) probe.wrap(s, 'run', `stream.step:${s.name}`)
  }
}

/**
 * Draw-submission census (round 3, the batching question): the active meshes grouped by geometry + material. A group
 * of plain meshes (no instances, no thin instances) drawn more than once is a candidate for instancing; the totals say
 * how many draws instancing could save at most. Top 12 groups by count.
 */
export function drawCensus(scene: Scene): { active: number; instanced: number; thin: number; plain: number; dupGroups: number; dupDraws: number; top: [string, number][] } {
  const active = scene.getActiveMeshes()
  const groups = new Map<string, { n: number; name: string }>()
  let instanced = 0
  let thin = 0
  let plain = 0
  for (let i = 0; i < active.length; i++) {
    const m = active.data[i] as AbstractMesh & { geometry?: { uniqueId: number } | null; hasThinInstances?: boolean; hasInstances?: boolean; sourceMesh?: unknown }
    if (m.sourceMesh) {
      instanced++
      continue
    }
    if (m.hasThinInstances) {
      thin++
      continue
    }
    plain++
    const g = m.geometry?.uniqueId
    if (g === undefined) continue
    const k = `${g}|${m.material?.uniqueId ?? -1}`
    const e = groups.get(k)
    if (e) e.n++
    else groups.set(k, { n: 1, name: m.name.replace(/\d+/g, '#') })
  }
  let dupGroups = 0
  let dupDraws = 0
  for (const e of groups.values()) if (e.n > 1) {
    dupGroups++
    dupDraws += e.n - 1
  }
  const top = [...groups.values()].filter(e => e.n > 1).sort((a, b) => b.n - a.n).slice(0, 12).map(e => [e.name, e.n] as [string, number])
  return { active: active.length, instanced, thin, plain, dupGroups, dupDraws, top }
}

export interface RouteOptions {
  spinDegS?: number
  walkSpinDegS?: number
  /** Max seconds per waypoint. */
  legTimeoutS?: number
  /** Measure the grass with its meshes drawn / hidden at the end (frames per arm, 0 = skip). */
  grassFrames?: number
  /** Seconds to settle at the plaza before the run. */
  settleS?: number
}

export interface RouteResult {
  engine: string
  preset: string | null
  /** `hops`: waypoints the walk could not reach and teleported to (blocked path). */
  legs: { tag: string; seconds: number; walkedM: number; reached: boolean; hops?: number }[]
  probe: ProbeSummary
  gpuMs: { p50: number; p95: number; max: number; samples: number } | null
  grass: unknown
  census: unknown
  /** drawCensus at the plaza (before the walk) and in the fields (after it). */
  draws: { plaza: ReturnType<typeof drawCensus>; fields: ReturnType<typeof drawCensus> } | null
  /** Pipelines made in the background during the route: in-play skips (a visible mesh waited), new meshes prewarmed, started. */
  warm: { skippedInPlay: number; prewarmed: number; started: number } | null
}

/** The run (see the header). `bench` supplies the GM commands, the status and the uncapped measure for the grass arms. */
export async function runRoute(
  ctx: WorldFeatureContext,
  probe: FrameProbe,
  bench: {
    gm(cmd: string, ...a: string[]): boolean
    status(): { worldReady: boolean; preset: string | null; engine: string }
    measure(label: string, o: { frames: number; warm?: number }): Promise<Record<string, unknown>>
    census(): unknown
  },
  o: RouteOptions = {},
): Promise<RouteResult> {
  const scene: Scene = ctx.scene
  const cam = ctx.camera
  bench.gm('time', '12:00')
  bench.gm('weather', 'clear', '30', '0')
  bench.gm('tp', String(ROUTE.start.x), String(ROUTE.start.z))
  await sleep(3000)
  for (let i = 0; i < 240 && !bench.status().worldReady; i++) await sleep(500)
  cam.alpha = Math.PI / 2
  cam.beta = 1.2
  cam.radius = 14
  await sleep((o.settleS ?? 10) * 1000)
  instrumentWorld(probe, ctx)

  let spin = 0
  const spinObs: Observer<Scene> = scene.onBeforeRenderObservable.add(() => {
    if (spin) cam.alpha += (spin * Math.PI / 180) * Math.min(0.1, scene.getEngine().getDeltaTime() / 1000)
  })!
  const eng = scene.getEngine()
  let gi: EngineInstrumentation | null = null
  try {
    gi = new EngineInstrumentation(eng)
    gi.captureGPUFrameTime = true
  } catch {
    gi = null
  }
  const gpu: number[] = []
  const gpuObs = eng.onEndFrameObservable.add(() => {
    const ns = gi?.gpuFrameTimeCounter.current ?? 0
    if (ns > 0) gpu.push(ns / 1e6)
  })
  const self = () => {
    const id = ctx.selfId()
    return id === null ? null : ctx.view(id) ?? null
  }
  const legs: RouteResult['legs'] = []
  const spinLeg = async (tag: string) => {
    probe.tag = tag
    spin = o.spinDegS ?? SPIN_DEG_S
    const t0 = performance.now()
    await sleep(6000)
    spin = 0
    legs.push({ tag, seconds: Math.round(performance.now() - t0) / 1000, walkedM: 0, reached: true })
  }
  const plazaDraws = drawCensus(scene)
  const pw = PipelineWarm.for(eng)
  const w0 = pw ? { skippedInPlay: pw.skippedInPlay, prewarmed: pw.prewarmed, started: pw.started } : null
  probe.start()
  try {
    await spinLeg('spin-plaza')
    for (const tag of ['walk-town', 'walk-fields']) {
      probe.tag = tag
      spin = o.walkSpinDegS ?? WALK_SPIN_DEG_S
      const t0 = performance.now()
      let walked = 0
      let hops = 0
      let last = self()?.pos.clone() ?? null
      for (const wp of routeWaypoints().filter(w => w.tag === tag)) {
        const w0 = performance.now()
        let still = 0
        ctx.send(intents.moveTo(wp.x, wp.z))
        while (performance.now() - w0 < (o.legTimeoutS ?? 20) * 1000) {
          await sleep(250)
          instrumentWorld(probe, ctx)
          const p = self()?.pos
          if (!p) continue
          const step = last ? Math.hypot(p.x - last.x, p.z - last.z) : 0
          walked += step
          last = p.clone()
          if (Math.hypot(p.x - wp.x, p.z - wp.z) < 5) break
          // stopped short (blocked, a fight, a wall): ask again, then hop there (the route must stay comparable)
          still = step < 0.1 ? still + 1 : 0
          if (still === 6) ctx.send(intents.moveTo(wp.x, wp.z))
          if (still >= 12) {
            bench.gm('tp', String(Math.round(wp.x)), String(Math.round(wp.z)))
            hops++
            last = null
            await sleep(500)
            break
          }
        }
      }
      spin = 0
      legs.push({ tag, seconds: Math.round(performance.now() - t0) / 1000, walkedM: Math.round(walked), reached: hops === 0, hops })
    }
    await spinLeg('spin-fields')
  } finally {
    spin = 0
    probe.tag = ''
  }
  const summary = probe.stop()
  const fieldsDraws = drawCensus(scene)
  const warm = pw && w0 ? { skippedInPlay: pw.skippedInPlay - w0.skippedInPlay, prewarmed: pw.prewarmed - w0.prewarmed, started: pw.started - w0.started } : null
  scene.onBeforeRenderObservable.remove(spinObs)
  eng.onEndFrameObservable.remove(gpuObs)
  gi?.dispose()
  const qs = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(p * (a.length - 1))] ?? 0
  const r2 = (v: number) => Math.round(v * 100) / 100

  // the grass cost: the same view with the grass meshes drawn / hidden (uncapped frames, CPU + GPU), interleaved
  let grass: unknown = null
  const frames = o.grassFrames ?? 240
  const scatter = (ctx.world()?.world as unknown as { scatter?: { meshes(): { setEnabled(on: boolean): void; isEnabled(): boolean }[] } } | undefined)?.scatter
  if (frames > 0 && scatter) {
    cam.alpha = Math.PI / 2
    const arms: Record<string, unknown>[] = []
    for (const arm of ['on', 'off', 'off', 'on']) {
      const meshes = scatter.meshes()
      const was = meshes.map(m => m.isEnabled())
      if (arm === 'off') for (const m of meshes) m.setEnabled(false)
      try {
        await sleep(1000)
        const m = await bench.measure(`grass-${arm}`, { frames, warm: 30 })
        arms.push({ arm, frameMs: m.frameMs, cpuMs: m.cpuMs, gpuMs: m.gpuMs, draws: m.draws, segments: m.segments, meshes: meshes.length })
      } finally {
        meshes.forEach((m, i) => m.setEnabled(was[i]!))
      }
    }
    grass = arms
  }
  return {
    engine: bench.status().engine,
    preset: bench.status().preset,
    legs,
    probe: summary,
    gpuMs: gpu.length ? { p50: r2(qs(gpu, 0.5)), p95: r2(qs(gpu, 0.95)), max: r2(Math.max(...gpu)), samples: gpu.length } : null,
    grass,
    census: bench.census(),
    warm,
    draws: { plaza: plazaDraws, fields: fieldsDraws },
  }
}

/** One console table of a result (the CLI's summary and a person's own run). */
export function routeReport(r: RouteResult): string {
  const p = r.probe
  const lines = [
    `route ${r.engine} ${r.preset}: ${p.frames} frames in ${p.seconds} s (${p.fps} fps); frame p50 ${p.frameMs.p50} p95 ${p.frameMs.p95} p99 ${p.frameMs.p99} max ${p.frameMs.max} ms; >33 ms: ${p.over33}, >50 ms: ${p.over50}; gpu p50 ${r.gpuMs?.p50 ?? '-'} p95 ${r.gpuMs?.p95 ?? '-'}`,
    `legs: ${r.legs.map(l => `${l.tag} ${l.seconds}s ${l.walkedM}m${l.hops ? ` (${l.hops} hops)` : ''}`).join(', ')}`,
    `histogram: ${Object.entries(p.histogram).map(([k, v]) => `${k}:${v}`).join(' ')}`,
    `background pipelines: ${JSON.stringify(r.warm)}`,
    `draw census: ${JSON.stringify(r.draws)}`,
    `heap: ${JSON.stringify(p.heap)}; long tasks ${JSON.stringify(p.longTasks)}; new pipelines ${JSON.stringify(p.pipelines)}`,
    'system | mean | p50 | p95 | max | in spikes (ms, frames)',
    ...p.systems.slice(0, 40).map(s => `${s.label} | ${s.meanMs} | ${s.p50} | ${s.p95} | ${s.max} | ${s.inSpikesMs} (${s.spikeFrames})`),
    'worst frames:',
    ...p.spikes.slice(0, 15).map(s => `  ${s.atS}s ${s.tag} ${s.ms} ms (cpu ${s.cpu}, outside ${s.outside}, pipelines ${s.pipelines}/${s.pipelinesBefore} before): ${s.top.map(([k, v]) => `${k} ${v}`).join(', ')}`),
  ]
  return lines.join('\n')
}
