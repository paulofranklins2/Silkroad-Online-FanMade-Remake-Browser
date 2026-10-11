import { Effect, WebGPUEngine, type AbstractEngine } from '@babylonjs/core'
import { gpuInfoFromEngine, type GpuInfo } from '@sro/world-render'
import { SOFTWARE_GPU } from './settings.ts'
import { installGpuProfile, startGpuDiagnostics } from './gpu-profile.ts'
import { trimCpuCopies } from './three/cpu-copies.ts'
import { installPositionsTrim } from './three/positions-trim.ts'
import { installShaderReadyCache } from './three/shader-ready-cache.ts'
import { PERF } from './world/perf.ts'

export type EngineKind = 'WebGPU' | 'WebGL2' | 'WebGL1'

export interface EngineResult {
  engine: AbstractEngine
  /** Always 'WebGPU': the game runs WebGPU only (Overall Pass item 0); the type stays wide for the shared render code. */
  kind: EngineKind
  canvas: HTMLCanvasElement
  /** The adapter is a software or fallback one (`isSoftwareAdapter`): it runs, slowly, and the game warns. */
  software: boolean
  /**
   * Wave 9 (docs/WAVE_PLAN3.md D10): the device's limits and features and the adapter's identity, for the first-run
   * preset (GAME) and World (LoadWorldOptions.gpu).
   */
  gpu: GpuInfo
}

/**
 * How the WebGPU device's limits are requested: 'max' copies every adapter limit (setMaximumLimits; the one that
 * matters is maxInterStageShaderVariables, 16 → 28 on the dev GPU: PBR + CSM + the SSAO prepass need 17, and with 16
 * the frame goes black), 'default' keeps WebGPU's defaults (the `?gpuLimits=default` debug flag, to test the 16-varying
 * fallback on a strong GPU).
 */
export type GpuLimitsMode = 'max' | 'default'

/**
 * Optional device features used when the adapter has them: the compressed-texture families KTX2 transcodes to (BC on
 * PC GPUs; ASTC and ETC2 on Apple silicon, where BC may be missing: the friends' Macs, the 9B handoff) and GPU timers
 * (perf overlay).
 */
// 'float32-filterable': the PCSS sun shadows' float32 colour shadow map (Ultra; docs/LIGHTING.md §4, §8).
export const WANTED_GPU_FEATURES = ['texture-compression-bc', 'texture-compression-astc', 'texture-compression-etc2', 'timestamp-query', 'float32-filterable'] as const

/**
 * Ask for the discrete GPU on dual-GPU laptops (the friends play on gaming laptops; the coast doc's handoff):
 * requestAdapter's powerPreference (also passed to Babylon, which requests the engine's own adapter with its options).
 * Chrome on Windows ignores it for WebGPU and says so once in the console (it picks the
 * high-performance adapter by the OS's per-app setting); it is harmless there.
 */
export const GPU_POWER_PREFERENCE = 'high-performance' as const

/** The part of a GPUAdapter the options read (tests pass a fake). */
export interface AdapterLike {
  readonly features: Iterable<string>
  readonly info?: { vendor?: string; architecture?: string; device?: string; description?: string; isFallbackAdapter?: boolean }
  /** Older spelling of info.isFallbackAdapter. */
  readonly isFallbackAdapter?: boolean
}

/**
 * A WebGPU adapter that is no GPU: the browser's fallback adapter (SwiftShader in Chrome, what it hands out when the
 * GPU is blocklisted or its process keeps crashing) or a software renderer the strings name (settings.ts SOFTWARE_GPU:
 * SwiftShader, llvmpipe, Microsoft Basic Render Driver). The game runs there but warns (gpu-help.ts
 * `showSoftwareGpuWarning`): every frame is drawn by the CPU.
 */
export function isSoftwareAdapter(adapter: AdapterLike | null | undefined): boolean {
  if (!adapter) return false
  if (adapter.info?.isFallbackAdapter || adapter.isFallbackAdapter) return true
  const i = adapter.info
  return SOFTWARE_GPU.test(`${i?.vendor ?? ''} ${i?.architecture ?? ''} ${i?.description ?? ''}`.toLowerCase())
}

type WebGPUOptions = NonNullable<ConstructorParameters<typeof WebGPUEngine>[1]>
type FeatureList = NonNullable<NonNullable<WebGPUOptions['deviceDescriptor']>['requiredFeatures']>

/** The WebGPU engine options: HEAD's plus the high-performance adapter, the limits mode and the wanted features the adapter has. */
export function webgpuEngineOptions(adapter: AdapterLike | null, limits: GpuLimitsMode): WebGPUOptions {
  const opts: WebGPUOptions = { antialias: true, adaptToDeviceRatio: true, powerPreference: GPU_POWER_PREFERENCE }
  if (limits === 'max') opts.setMaximumLimits = true
  if (adapter) {
    const have = new Set(adapter.features)
    opts.deviceDescriptor = { requiredFeatures: WANTED_GPU_FEATURES.filter(f => have.has(f)) as unknown as FeatureList }
  }
  return opts
}

/** Bind groups Babylon's WebGPU cache may hold before it starts over (trimBindGroupCache). */
export const BIND_GROUP_CACHE_LIMIT = 20_000

/** The statics of Babylon's WebGPUCacheBindGroups (internal) that the trim uses. */
interface BindGroupCacheClass {
  NumBindGroupsCreatedTotal: number
  ResetCache(): void
}

/**
 * Babylon 9.28's WebGPU bind-group cache (WebGPUCacheBindGroups) is one global tree keyed by the ids of the uniform
 * buffers, samplers and textures of every bind group ever made, and nothing ever prunes it: the entries of disposed
 * meshes stay forever. Grinding makes ~160k a minute (each hit or drop effect is a few new meshes, and their shared
 * material's uniform buffer comes from a pool whose index changes every frame), +65 MB of JS heap a minute measured, the
 * 2026-10-05 black screen's tab at 1.7 GB. Starting the cache over once it holds `limit` bind groups is safe: draw
 * contexts keep the bind groups they use, and only changed ones are looked up (and made) again. Returns a remover.
 */
export function trimBindGroupCache(engine: AbstractEngine, limit = BIND_GROUP_CACHE_LIMIT): () => void {
  const cache = (engine as unknown as { _cacheBindGroups?: { constructor: Partial<BindGroupCacheClass> } })._cacheBindGroups
  const C = cache?.constructor
  if (!C || typeof C.ResetCache !== 'function' || typeof C.NumBindGroupsCreatedTotal !== 'number') return () => {}
  const reset = C.ResetCache.bind(C)
  const obs = engine.onEndFrameObservable.add(() => {
    if ((C.NumBindGroupsCreatedTotal ?? 0) >= limit) reset()
  })
  return () => obs.remove()
}

/** `?gpuLimits=default` → 'default', anything else → 'max'. */
export function gpuLimitsParam(search: string = typeof location === 'undefined' ? '' : location.search): GpuLimitsMode {
  return new URLSearchParams(search).get('gpuLimits') === 'default' ? 'default' : 'max'
}

/** The adapter the engine will get (Babylon requests one with the same powerPreference); null when unavailable. */
async function preQueryAdapter(): Promise<AdapterLike | null> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(o?: { powerPreference?: string }): Promise<AdapterLike | null> } }).gpu
    return (await gpu?.requestAdapter({ powerPreference: GPU_POWER_PREFERENCE })) ?? null
  } catch {
    return null
  }
}

/** Why the game cannot start its renderer: no WebGPU in this browser, no adapter (blocklisted GPU, hardware acceleration off), or the device failed. */
export type WebGpuFailure = 'missing' | 'no-adapter' | 'failed'

/** createEngine's error: the game needs WebGPU (main.ts shows gpu-help.ts `showWebGpuRequired`). */
export class WebGpuUnavailableError extends Error {
  constructor(readonly reason: WebGpuFailure, detail: string) {
    super(detail)
    this.name = 'WebGpuUnavailableError'
  }
}

/**
 * The game's WebGPU engine (Overall Pass item 0: WebGPU only, no WebGL2 fallback). Same setup as
 * apps/viewer/src/engine.ts, kept separate so the two apps evolve independently. Wave 9: the device gets the adapter's
 * full limits (unless `?gpuLimits=default`) and the wanted optional features it offers. A software or fallback adapter
 * runs (`software` in the result: the caller warns). Throws WebGpuUnavailableError when WebGPU is missing or fails.
 */
export async function createEngine(canvas: HTMLCanvasElement, gpuLimits: GpuLimitsMode = gpuLimitsParam()): Promise<EngineResult> {
  let supported = false
  try {
    supported = typeof navigator !== 'undefined' && 'gpu' in navigator && (await WebGPUEngine.IsSupportedAsync)
  } catch {
    supported = false
  }
  if (!supported) throw new WebGpuUnavailableError('missing', 'WebGPU is not available in this browser')
  // `?gpuProfile=mac|min` and `?dpr=` (gpu-profile.ts): the Mac paths on a PC
  installGpuProfile()
  const adapter = await preQueryAdapter()
  if (!adapter) throw new WebGpuUnavailableError('no-adapter', 'WebGPU found no graphics adapter (GPU blocklisted, or hardware acceleration off)')
  let engine: WebGPUEngine | undefined
  try {
    engine = new WebGPUEngine(canvas, webgpuEngineOptions(adapter, gpuLimits))
    await engine.initAsync()
  } catch (err) {
    try {
      engine?.dispose()
    } catch {
      // ignore: the engine never finished initialising
    }
    throw new WebGpuUnavailableError('failed', `WebGPU init failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  trimBindGroupCache(engine)
  // adapter, features, limits and validation errors: console, window.__sroGpu and the perf overlay (gpu-profile.ts)
  startGpuDiagnostics(engine, adapter.info)
  // Compiled shader variants stay for the session (PERF.effectsPersistent, docs/PERF_OVERALL.md round 3).
  Effect.PersistentMode = PERF.effectsPersistent
  // ShaderMaterial readiness without its per-draw define string (PERF.shaderReadyCache, round 5)
  installShaderReadyCache()
  // CPU copies kept only for an in-place context restore, which WebGPU never does here (three/cpu-copies.ts)
  trimCpuCopies(engine)
  installPositionsTrim()
  const gpu = gpuInfoFromEngine(engine, {
    isFallbackAdapter: !!(adapter.info?.isFallbackAdapter ?? adapter.isFallbackAdapter),
    ...(adapter.info?.vendor ? { vendor: adapter.info.vendor } : {}),
    ...(adapter.info?.architecture ? { architecture: adapter.info.architecture } : {}),
  })
  return { engine, kind: 'WebGPU', canvas, gpu, software: isSoftwareAdapter(adapter) }
}
