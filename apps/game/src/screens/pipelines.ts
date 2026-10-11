/**
 * WebGPU render pipelines made in the background (lane P-STALL; docs/RENDER.md §11.6). Babylon 9.28 makes a render
 * pipeline the first time a draw needs it, with the synchronous `device.createRenderPipeline`, and Chrome compiles it
 * (WGSL to HLSL to DXIL, then the driver's pipeline state) on the GPU process's main thread. Every later GPU call of
 * the page queues behind that work, so a warm-up that drew 30-odd new pipelines left the GPU process 2-3 s behind:
 * measured on the select stage (WebGPU Medium, dev PC), `onSubmittedWorkDone` took up to 2.9 s after the warm-up's
 * views, and a `writeBuffer` 1.5-2.4 s after the select screen appeared blocked for 0.3-0.97 s (the stall the deploy
 * check saw as 2.3 s on the first login to character select).
 *
 * `PipelineWarm` replaces that with `createRenderPipelineAsync`, which Dawn compiles on its worker threads, in
 * parallel and without holding the GPU process's command stream:
 *
 * - **A session** (`begin`): a draw whose pipeline is not in Babylon's pipeline cache starts its creation in the
 *   background with that draw's exact state (Babylon's own `preWarmPipeline` path: the cache lookup sets the state,
 *   `_buildRenderPipelineDescriptor` builds the descriptor from it) and is skipped. The pipeline is stored in the cache
 *   when it is made, and the same draw finds it on a later frame. Only for frames nobody sees (behind a loading
 *   picture): a skipped draw is missing from that frame.
 * - **Ghost meshes** (`ghost`): their draws are never issued while they are ghosts, their pipelines are still made in
 *   the background. An actor about to appear is drawn this way for a few frames, then shown with every pipeline made.
 *
 * - **In play** (`PERF.pipelinesInPlay`, docs/PERF_OVERALL.md): a mesh draw whose pipeline is missing (a material
 *   first seen while walking or turning the camera: streamed regions, a new character, a weather mesh) is made the
 *   same way and skipped, so the mesh appears a frame or two later instead of the whole frame waiting 100-470 ms for
 *   the GPU process to compile it (the route bench: 29 of 39 frames over 33 ms came within 3 frames of a new pipeline).
 *   Only mesh draws (Mesh._draw: the main pass, shadow maps, prepasses): full-screen passes (post-processes, the sky's
 *   LUTs) are drawn as before, a skipped one would leave a whole frame wrong.
 *
 * - **New meshes, ahead of view** (`watchScene`, `PERF.prewarmNew`): a mesh added during play (a streamed region's
 *   objects, a character, a plant chunk) has its effects compiled in idle time (`requestIdleCallback`, one compile per
 *   idle period, never inside a frame; `isReady(true)`: its material and shadow depth effect, also for hidden meshes)
 *   and is then drawn out of view as a ghost until a frame starts no new pipeline for it, so its pipelines are made in
 *   the background before the camera turns to it. The in-play skip above is then the rare case, not the rule.
 *
 * Other draws go straight to Babylon (one branch per draw). Not WebGPU, a Babylon whose internals differ, or a
 * disabled pipeline cache: `PipelineWarm.for` returns null and everything is as before.
 */
import { Mesh, type AbstractEngine, type AbstractMesh, type Observer, type Scene } from '@babylonjs/core'
import { PERF } from '../world/perf.ts'

type Token = object

interface PipelineParam {
  token: Token | undefined
  pipeline: unknown
}

/** The part of Babylon's WebGPUCacheRenderPipeline used here (9.28). */
interface PipelineCache {
  disabled?: boolean
  _parameter: PipelineParam
  _lookupRenderPipeline(fillMode: number, effect: unknown, sampleCount: number, textureState: number): unknown
  _buildRenderPipelineDescriptor(effect: unknown, topology: unknown, sampleCount: number): unknown
  _setRenderPipeline(param: PipelineParam): void
}

interface TextureLike {
  type?: number
  format?: number
}

interface EngineInternals {
  isWebGPU?: boolean
  _draw(drawType: number, fillMode: number, start: number, count: number, instancesCount?: number): void
  applyStates(): void
  _currentEffect: { _pipelineContext?: { shaderProcessingContext?: { textureNames?: readonly string[] } } } | null
  _currentMaterialContext: { hasFloatOrDepthTextures?: boolean; textures?: Record<string, { texture?: TextureLike | null } | undefined> } | null
  _caps: { textureFloatLinearFiltering?: boolean }
  _cacheRenderPipeline?: PipelineCache & { constructor: { _GetTopology?(fillMode: number): unknown } }
  _device?: { createRenderPipelineAsync?(descriptor: unknown): Promise<unknown> }
  _snapshotRendering?: { play?: boolean; record?: boolean }
  readonly currentSampleCount: number
}

type MeshDraw = (subMesh: unknown, fillMode: number, instancesCount?: number) => unknown

const engines = new WeakMap<AbstractEngine, PipelineWarm | null>()

/** The prewarm queue's size unit (the queue holds 64 × this). */
export const PREWARM_MAX = 64
/** Frames a prewarmed mesh is drawn out of view at most (its pipelines are usually made within 2-3). */
export const PREWARM_FRAMES = 8
/**
 * Only meshes likely to come into view are prewarmed (round 3: prewarming everything cost ≈ 1 ms a frame and compiled
 * effects of meshes nobody looked at): within PREWARM_RADIUS_M of the camera and within the view's half-angle +
 * PREWARM_SIDE_RAD of where it looks (a turn of up to 90° finds them ready). The others wait in the queue.
 */
export const PREWARM_RADIUS_M = 140
export const PREWARM_SIDE_RAD = Math.PI / 2
/** Meshes held (drawn out of view as ghosts) at once, and the idle time an effect compile needs to start (ms). */
export const PREWARM_HELD_MAX = 16
export const PREWARM_IDLE_MS = 8
/** A held mesh: frames held, whether this frame's ghost draws started a pipeline for it, the undo. */
interface Held {
  frames: number
  pending: boolean
  undo: () => void
}
/** Frames a new mesh waits before its first prewarm try (its material is set after it is made), and tries at most. */
const PREWARM_DELAY = 2
const PREWARM_TRIES = 30

/** Mesh draws in progress (Mesh._draw, patched once): the in-play rule only skips those. */
let meshDrawDepth = 0
let meshDrawPatched = false
/** The mesh being drawn (Mesh._draw), for the bench's skip log. */
let drawingMesh: { name: string } | null = null
function patchMeshDraw(): void {
  if (meshDrawPatched) return
  meshDrawPatched = true
  const proto = Mesh.prototype as unknown as { _draw?: MeshDraw }
  const draw = proto._draw
  if (typeof draw !== 'function') return
  proto._draw = function (this: unknown, subMesh: unknown, fillMode: number, instancesCount?: number) {
    meshDrawDepth++
    drawingMesh = this as { name: string }
    try {
      return draw.call(this, subMesh, fillMode, instancesCount)
    } finally {
      meshDrawDepth--
    }
  }
}

/** Babylon's texture state bits of the current draw (webgpuEngine.pure.js `_draw`, 9.28): float or depth textures. */
function textureStateOf(e: EngineInternals): number {
  const ctx = e._currentMaterialContext
  if (!ctx?.hasFloatOrDepthTextures) return 0
  const names = e._currentEffect?._pipelineContext?.shaderProcessingContext?.textureNames ?? []
  let state = 0
  let bit = 1
  for (const name of names) {
    const t = ctx.textures?.[name]?.texture
    const depth = !!t && t.format !== undefined && t.format >= 13 && t.format <= 18
    if ((t?.type === 1 && !e._caps.textureFloatLinearFiltering) || depth) state |= bit
    bit <<= 1
  }
  return state
}

export class PipelineWarm {
  /** Pipelines being made, by their cache node. */
  private readonly pending = new Map<Token, Promise<void>>()
  /** Cache nodes whose background creation failed: Babylon makes them at their draw (and reports the error). */
  private readonly failedTokens = new WeakSet<Token>()
  private sessions = 0
  private ghostDepth = 0
  /** Background creations started, made, failed; draws skipped for a missing pipeline (counters for the warm-up). */
  started = 0
  made = 0
  failed = 0
  skipped = 0
  /** Mesh draws skipped in play for a pipeline being made (PERF.pipelinesInPlay). */
  skippedInPlay = 0
  /** Set by the bench: in-play skips by mesh name (null: not counted). */
  skipLog: Map<string, number> | null = null

  /** The engine's PipelineWarm (one per engine; null when the engine is not WebGPU or its internals differ). */
  static for(engine: AbstractEngine): PipelineWarm | null {
    if (engines.has(engine)) return engines.get(engine) ?? null
    const e = engine as unknown as EngineInternals
    const cache = e._cacheRenderPipeline
    const ok = !!e.isWebGPU && typeof e._draw === 'function' && typeof e.applyStates === 'function' && !!cache
      && typeof cache._lookupRenderPipeline === 'function' && typeof cache._buildRenderPipelineDescriptor === 'function'
      && typeof cache._setRenderPipeline === 'function' && typeof cache.constructor?._GetTopology === 'function'
      && typeof e._device?.createRenderPipelineAsync === 'function'
    const w = ok ? new PipelineWarm(e) : null
    engines.set(engine, w)
    return w
  }

  private constructor(private readonly e: EngineInternals) {
    const draw = e._draw
    const self = this
    patchMeshDraw()
    e._draw = function (this: EngineInternals, drawType: number, fillMode: number, start: number, count: number, instancesCount?: number) {
      const play = self.sessions === 0 && self.ghostDepth === 0
      if (play && !(PERF.pipelinesInPlay && meshDrawDepth > 0)) return draw.call(this, drawType, fillMode, start, count, instancesCount)
      const snap = this._snapshotRendering
      if (snap?.play || snap?.record) return draw.call(this, drawType, fillMode, start, count, instancesCount)
      const state = self.prepare(this, fillMode)
      if (self.ghostDepth > 0) {
        if (state === 'pending' && self.drawingHeld) self.drawingHeld.pending = true
        return
      }
      if (state === 'cached') return draw.call(this, drawType, fillMode, start, count, instancesCount)
      if (play) {
        self.skippedInPlay++
        if (self.skipLog && drawingMesh) self.skipLog.set(drawingMesh.name, (self.skipLog.get(drawingMesh.name) ?? 0) + 1)
      }
      else self.skipped++
    }
  }

  /** New meshes prewarmed in play (watchScene): effects compiled, pipelines started ahead of view. */
  prewarmed = 0
  private watched: { scene: Scene; off: () => void } | null = null

  /**
   * The new-mesh prewarm on this scene (see the file comment); idempotent, a new scene replaces the old one's watch.
   * Called by the warm-up (screens/warmup.ts) once the world is in.
   */
  watchScene(scene: Scene): void {
    if (this.watched?.scene === scene) return
    this.watched?.off()
    const queue: { m: AbstractMesh; at: number; tries: number; waits: number }[] = []
    const held = new Map<AbstractMesh, Held>()
    let frame = 0
    let off = false
    const added: Observer<AbstractMesh> | null = scene.onNewMeshAddedObservable.add(m => {
      if (PERF.prewarmNew && queue.length < 64 * PREWARM_MAX) queue.push({ m, at: frame, tries: 0, waits: 0 })
    })
    // the hidden meshes already there (the warm-up compiles what is shown; these are shown later in play)
    for (const m of scene.meshes) if ((!m.isEnabled() || !m.isVisible) && queue.length < 64 * PREWARM_MAX) queue.push({ m, at: frame, tries: 0, waits: 0 })
    const release = (m: AbstractMesh) => {
      held.get(m)?.undo()
      held.delete(m)
    }
    // Per frame only the held meshes: let go once a frame's ghost draws started no pipeline for them (round 5: a mesh
    // whose effect and pipelines another mesh already made is held one frame, not eight).
    const tick: Observer<Scene> | null = scene.onBeforeRenderObservable.add(() => {
      frame++
      for (const [m, h] of held) {
        if (m.isDisposed() || ++h.frames >= PREWARM_FRAMES || (h.frames >= 2 && !h.pending)) release(m)
        else h.pending = false
      }
    })
    // The queue in idle time (round 5): an effect compile (Babylon's shader processing, 5-20 ms, not splittable) never
    // runs inside a frame; at most one compile per idle period, and only with PREWARM_IDLE_MS of it left.
    const idle = (deadline: { timeRemaining(): number; didTimeout?: boolean }): void => {
      if (off) return
      this.idleRuns++
      const cam = scene.activeCamera
      const eye = cam?.globalPosition
      const fwd = cam?.getForwardRay(1).direction
      const cone = Math.cos(Math.min(Math.PI, (cam?.fov ?? 0.8) * 0.9 + PREWARM_SIDE_RAD))
      let compiled = false
      for (let i = 0; i < queue.length && held.size < PREWARM_HELD_MAX && deadline.timeRemaining() > 1; ) {
        const q = queue[i]!
        if (frame - q.at < PREWARM_DELAY) {
          i++
          continue
        }
        const m = q.m
        if (m.isDisposed() || m.getTotalVertices() === 0 || m.alwaysSelectAsActiveMesh) {
          queue.splice(i, 1)
          continue
        }
        if (!m.material) {
          if (++q.waits > 600) queue.splice(i, 1)
          else {
            q.at = frame + 15
            i++
          }
          continue
        }
        const hidden = !m.isEnabled() || !m.isVisible
        if (eye && fwd) {
          // not likely to come into view (far, or behind; a hidden mesh: far): left for later (the in-play skip covers a
          // surprise). Round 5: compiling every hidden mesh (LODs included) was ≈ 16 % of the route's garbage.
          const c = m.getBoundingInfo().boundingSphere.centerWorld
          const dx = c.x - eye.x, dy = c.y - eye.y, dz = c.z - eye.z
          const d = Math.hypot(dx, dy, dz)
          const r = m.getBoundingInfo().boundingSphere.radiusWorld
          if (d - r > PREWARM_RADIUS_M || (!hidden && d > r && (dx * fwd.x + dy * fwd.y + dz * fwd.z) / d < cone)) {
            // look again in a quarter second; after ≈ 150 s it is left to the in-play skip
            if (++q.waits > 600) queue.splice(i, 1)
            else {
              q.at = frame + 15
              i++
            }
            continue
          }
        }
        // one compile per idle period, and only with room for it
        if (compiled || deadline.timeRemaining() < PREWARM_IDLE_MS) break
        const t0 = performance.now()
        let ready = false
        try {
          // a hidden mesh (disabled or invisible: the renderer never evaluates it) gets its effects compiled for its
          // mesh state now; its pipelines follow at its first draw, in the background (the in-play rule)
          ready = m.isReady(true)
        } catch {
          ready = true // Babylon reports it at the draw, as before
        }
        if (performance.now() - t0 > 1) compiled = true
        if (!ready && ++q.tries < PREWARM_TRIES) {
          q.at = frame // compiling: try again in a few frames
          i++
          continue
        }
        queue.splice(i, 1)
        this.prewarmed++
        if (!hidden) held.set(m, this.holdOutOfView(scene, m))
      }
      schedule()
    }
    const ric = (globalThis as { requestIdleCallback?: (cb: typeof idle, o?: { timeout: number }) => number }).requestIdleCallback
    const schedule = (): void => {
      if (off) return
      if (ric) ric(idle, { timeout: 2000 })
      else setTimeout(() => idle({ timeRemaining: () => PREWARM_IDLE_MS + 2 }), 50)
    }
    schedule()
    this.watched = {
      scene,
      off: () => {
        off = true
        if (added) scene.onNewMeshAddedObservable.remove(added)
        if (tick) scene.onBeforeRenderObservable.remove(tick)
        for (const m of [...held.keys()]) release(m)
        queue.length = 0
      },
    }
    scene.onDisposeObservable.addOnce(() => {
      if (this.watched?.scene === scene) {
        this.watched.off()
        this.watched = null
      }
    })
  }

  /** Idle callbacks the prewarm ran (bench). */
  idleRuns = 0
  /** The held mesh being drawn now (its ghost draws mark it pending when they start a pipeline). */
  private drawingHeld: Held | null = null

  /** Draws `m` whatever the frustum says, as a ghost while it is out of the camera's view. */
  private holdOutOfView(scene: Scene, m: AbstractMesh): Held {
    m.alwaysSelectAsActiveMesh = true
    const target = m as unknown as { _draw?: MeshDraw }
    const draw = target._draw
    const own = Object.prototype.hasOwnProperty.call(target, '_draw')
    const self = this
    const h: Held = { frames: 0, pending: false, undo: () => {} }
    if (typeof draw === 'function') {
      target._draw = function (this: unknown, subMesh: unknown, fillMode: number, instancesCount?: number) {
        const planes = scene.frustumPlanes
        if (planes && !m.isInFrustum(planes)) {
          self.ghostDepth++
          self.drawingHeld = h
          try {
            return draw.call(this, subMesh, fillMode, instancesCount)
          } finally {
            self.ghostDepth--
            self.drawingHeld = null
          }
        }
        return draw.call(this, subMesh, fillMode, instancesCount)
      }
    }
    h.undo = () => {
      if (!m.isDisposed()) m.alwaysSelectAsActiveMesh = false
      if (typeof draw !== 'function') return
      if (own) target._draw = draw
      else delete target._draw
    }
    return h
  }

  /** Pipelines started and not made yet. */
  get pendingCount(): number {
    return this.pending.size
  }

  /** A session is open. */
  get active(): boolean {
    return this.sessions > 0
  }

  /** Opens a session (see the file comment); the returned function ends it (once). */
  begin(): () => void {
    this.sessions++
    let open = true
    return () => {
      if (!open) return
      open = false
      this.sessions--
    }
  }

  /** Resolves when every pipeline started so far is made (or failed). */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending.values()])
  }

  /**
   * Makes these meshes ghosts (see the file comment) until the returned function runs (once). Their draws are skipped
   * whatever the cache holds; a missing pipeline is started in the background.
   */
  ghost(meshes: readonly AbstractMesh[]): () => void {
    const undo: Array<() => void> = []
    for (const m of meshes) {
      const target = m as unknown as { _draw?: MeshDraw }
      const draw = target._draw
      if (typeof draw !== 'function') continue
      const own = Object.prototype.hasOwnProperty.call(target, '_draw')
      const self = this
      target._draw = function (this: unknown, subMesh: unknown, fillMode: number, instancesCount?: number) {
        self.ghostDepth++
        try {
          return draw.call(this, subMesh, fillMode, instancesCount)
        } finally {
          self.ghostDepth--
        }
      }
      undo.push(() => {
        if (own) target._draw = draw
        else delete target._draw
      })
    }
    let done = false
    return () => {
      if (done) return
      done = true
      for (const u of undo) u()
    }
  }

  /** The draw's pipeline: in the cache ('cached'), or being made now ('pending'; started here when it was not). */
  private prepare(e: EngineInternals, fillMode: number): 'cached' | 'pending' {
    const cache = e._cacheRenderPipeline!
    const effect = e._currentEffect
    if (cache.disabled || !effect) return 'cached'
    e.applyStates()
    const textureState = textureStateOf(e)
    const sampleCount = e.currentSampleCount > 1 ? 4 : 1
    if (cache._lookupRenderPipeline(fillMode, effect, sampleCount, textureState)) return 'cached'
    const token = cache._parameter.token
    if (!token || this.failedTokens.has(token)) return 'cached'
    if (this.pending.has(token)) return 'pending'
    let descriptor: unknown
    try {
      descriptor = cache._buildRenderPipelineDescriptor(effect, cache.constructor._GetTopology!(fillMode), sampleCount)
    } catch {
      // Babylon draws it itself (and reports whatever is wrong with it, as it would have).
      return 'cached'
    }
    const param: PipelineParam = { token, pipeline: null }
    this.started++
    const job = e._device!.createRenderPipelineAsync!(descriptor).then(
      pipeline => {
        param.pipeline = pipeline
        cache._setRenderPipeline(param)
        this.made++
      },
      (err: unknown) => {
        this.failed++
        this.failedTokens.add(token)
        if (this.failed <= 3) console.warn('[pipelines] background pipeline failed; it is made at its first draw', err)
      },
    ).finally(() => this.pending.delete(token))
    this.pending.set(token, job)
    return 'pending'
  }
}
