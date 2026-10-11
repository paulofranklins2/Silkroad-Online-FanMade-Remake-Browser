/**
 * GPU diagnostics and the restricted-adapter debug profile (the Mac reports, 2026-10-11).
 *
 * - `?gpuProfile=mac`: the adapter is narrowed to typical Chrome-on-Apple-silicon values before the engine asks for its
 *   device (optional features cut to the ones Metal exposes there, limits clamped), so the Mac paths can be seen on a PC.
 *   `?gpuProfile=min`: no optional feature at all and WebGPU's default limits (the strictest device the spec allows).
 *   `?dpr=2`: devicePixelRatio forced (a Retina screen's render-target size).
 * - `gpuDiagnostics()`: the adapter's identity, the device's features and the limits the renderer depends on, the canvas
 *   format, the pixel ratio and the WebGPU validation errors seen so far. Logged once at start (`[gpu]` in the console),
 *   on `window.__sroGpu`, and as the last line of the perf overlay (Ctrl+Shift+F), so a player's screenshot tells us
 *   what their GPU offered.
 */

export type GpuProfile = 'mac' | 'min'

/** `?gpuProfile=mac|min` (anything else: the real adapter). */
export function gpuProfileParam(search: string = typeof location === 'undefined' ? '' : location.search): GpuProfile | null {
  const v = new URLSearchParams(search).get('gpuProfile')
  return v === 'mac' || v === 'min' ? v : null
}

/** WebGPU's default limits (the spec's guaranteed minimum; `min` clamps every limit to these). */
export const WEBGPU_DEFAULTS: Record<string, number> = {
  maxTextureDimension1D: 8192,
  maxTextureDimension2D: 8192,
  maxTextureDimension3D: 2048,
  maxTextureArrayLayers: 256,
  maxBindGroups: 4,
  maxBindingsPerBindGroup: 1000,
  maxDynamicUniformBuffersPerPipelineLayout: 8,
  maxDynamicStorageBuffersPerPipelineLayout: 4,
  maxSampledTexturesPerShaderStage: 16,
  maxSamplersPerShaderStage: 16,
  maxStorageBuffersPerShaderStage: 8,
  maxStorageTexturesPerShaderStage: 4,
  maxUniformBuffersPerShaderStage: 12,
  maxUniformBufferBindingSize: 65536,
  maxStorageBufferBindingSize: 134217728,
  maxVertexBuffers: 8,
  maxBufferSize: 268435456,
  maxVertexAttributes: 16,
  maxVertexBufferArrayStride: 2048,
  maxInterStageShaderVariables: 16,
  maxColorAttachments: 8,
  maxColorAttachmentBytesPerSample: 32,
  maxComputeWorkgroupStorageSize: 16384,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupSizeY: 256,
  maxComputeWorkgroupSizeZ: 64,
  maxComputeWorkgroupsPerDimension: 65535,
}

/**
 * Chrome on Apple silicon (Metal, M1..M3, webgpureport-style values): ASTC/ETC2 and BC, float32-filterable,
 * rg11b10ufloat-renderable and shader-f16; the per-stage limits at the spec's defaults, larger buffers and textures.
 */
const MAC_FEATURES = new Set(['texture-compression-bc', 'texture-compression-astc', 'texture-compression-etc2', 'float32-filterable', 'rg11b10ufloat-renderable', 'shader-f16', 'depth32float-stencil8', 'indirect-first-instance', 'bgra8unorm-storage', 'depth-clip-control', 'timestamp-query'])
const MAC_LIMITS: Record<string, number> = {
  ...WEBGPU_DEFAULTS,
  maxTextureDimension1D: 16384,
  maxTextureDimension2D: 16384,
  maxTextureArrayLayers: 2048,
  maxBufferSize: 4294967296,
  maxStorageBufferBindingSize: 4294967292,
  maxInterStageShaderVariables: 28,
  maxColorAttachmentBytesPerSample: 64,
  maxComputeWorkgroupStorageSize: 32768,
  maxComputeInvocationsPerWorkgroup: 1024,
  maxComputeWorkgroupSizeX: 1024,
  maxComputeWorkgroupSizeY: 1024,
}

function profileOf(p: GpuProfile): { features: (f: string) => boolean; limits: Record<string, number> } {
  return p === 'mac' ? { features: f => MAC_FEATURES.has(f), limits: MAC_LIMITS } : { features: () => false, limits: WEBGPU_DEFAULTS }
}

type Adapter = { features: Iterable<string> & { has(f: string): boolean }; limits: Record<string, number>; requestDevice(d?: Record<string, unknown>): Promise<unknown> }

/** The adapter seen through the profile: fewer features, lower limits, and a device asked for within them. */
function narrowAdapter(real: Adapter, p: GpuProfile): Adapter {
  const prof = profileOf(p)
  const features = new Set([...real.features].filter(prof.features))
  const limits: Record<string, number> = {}
  for (const k in real.limits) {
    const v = real.limits[k]
    if (typeof v !== 'number') continue
    const cap = prof.limits[k]
    limits[k] = cap === undefined ? v : k.startsWith('min') ? Math.max(v, cap) : Math.min(v, cap)
  }
  return new Proxy(real, {
    get(target, key) {
      if (key === 'features') return features
      if (key === 'limits') return limits
      if (key === 'requestDevice') {
        return (d: Record<string, unknown> = {}) => {
          const req = (d.requiredFeatures as string[] | undefined)?.filter(f => features.has(f))
          const lim = d.requiredLimits as Record<string, number> | undefined
          const clamped: Record<string, number> = {}
          if (lim) for (const k in lim) if (k in limits) clamped[k] = k.startsWith('min') ? Math.max(lim[k]!, limits[k]!) : Math.min(lim[k]!, limits[k]!)
          // Default limits are what the device gets for anything not asked for: the profile's lower ones are asked
          // explicitly only where they exceed the defaults, so the real device never offers more than the profile.
          return target.requestDevice.call(target, { ...d, requiredFeatures: req ?? [], ...(lim ? { requiredLimits: clamped } : {}) })
        }
      }
      const v = Reflect.get(target, key, target)
      return typeof v === 'function' ? v.bind(target) : v
    },
  }) as Adapter
}

let activeProfile: GpuProfile | null = null

/** Installs `?gpuProfile=` and `?dpr=` (before the engine is made). No-op without them. */
export function installGpuProfile(search: string = typeof location === 'undefined' ? '' : location.search): GpuProfile | null {
  const dpr = Number(new URLSearchParams(search).get('dpr'))
  if (dpr > 0 && dpr <= 4 && typeof window !== 'undefined') Object.defineProperty(window, 'devicePixelRatio', { get: () => dpr, configurable: true })
  const p = gpuProfileParam(search)
  const gpu = typeof navigator === 'undefined' ? undefined : ((navigator as unknown as { gpu?: unknown }).gpu as { requestAdapter(o?: unknown): Promise<Adapter | null> } | undefined)
  if (!p || !gpu || activeProfile) return activeProfile
  activeProfile = p
  const orig = gpu.requestAdapter.bind(gpu)
  gpu.requestAdapter = async (o?: unknown) => {
    const a = await orig(o)
    return a ? narrowAdapter(a, p) : null
  }
  console.warn(`[gpu] debug profile '${p}': the adapter's features and limits are narrowed`)
  return p
}

// ---- diagnostics ----------------------------------------------------------------------------------------------------

/** The limits the renderer depends on (shown in the overlay line in this order, short names). */
const KEY_LIMITS: [string, string][] = [
  ['maxSampledTexturesPerShaderStage', 'tex'],
  ['maxSamplersPerShaderStage', 'smp'],
  ['maxInterStageShaderVariables', 'var'],
  ['maxStorageBuffersPerShaderStage', 'ssbo'],
  ['maxUniformBuffersPerShaderStage', 'ubo'],
  ['maxColorAttachmentBytesPerSample', 'cbps'],
  ['maxTextureDimension2D', 'tex2d'],
  ['maxTextureArrayLayers', 'layers'],
  ['maxBindGroups', 'groups'],
]

const SHORT_FEATURES: Record<string, string> = {
  'texture-compression-bc': 'bc',
  'texture-compression-astc': 'astc',
  'texture-compression-etc2': 'etc2',
  'float32-filterable': 'f32filt',
  'rg11b10ufloat-renderable': 'rg11b10',
  'shader-f16': 'f16',
  'timestamp-query': 'ts',
}

export interface GpuDiagnostics {
  profile: GpuProfile | null
  adapter: { vendor: string; architecture: string; device: string; description: string }
  features: string[]
  limits: Record<string, number>
  canvasFormat: string
  devicePixelRatio: number
  /** The drawing buffer (render resolution) at the last read. */
  buffer: [number, number]
  errors: number
  firstErrors: string[]
}

interface EngineLike {
  enabledExtensions?: string[]
  currentLimits?: Record<string, number>
  getRenderWidth?(): number
  getRenderHeight?(): number
  _device?: { addEventListener(t: string, f: (e: { error?: { message?: string } }) => void): void }
}

let diag: GpuDiagnostics | null = null
let diagEngine: EngineLike | null = null

/** Starts the diagnostics for the engine's device: logs them once and counts WebGPU validation errors. */
export function startGpuDiagnostics(engine: unknown, adapterInfo: { vendor?: string; architecture?: string; device?: string; description?: string } | undefined): GpuDiagnostics {
  const e = engine as EngineLike
  diagEngine = e
  const limits: Record<string, number> = {}
  for (const [k] of KEY_LIMITS) if (typeof e.currentLimits?.[k] === 'number') limits[k] = e.currentLimits[k]!
  const gpu = (navigator as Navigator & { gpu?: { getPreferredCanvasFormat?(): string } }).gpu
  diag = {
    profile: activeProfile,
    adapter: { vendor: adapterInfo?.vendor ?? '', architecture: adapterInfo?.architecture ?? '', device: adapterInfo?.device ?? '', description: adapterInfo?.description ?? '' },
    features: [...(e.enabledExtensions ?? [])].sort(),
    limits,
    canvasFormat: gpu?.getPreferredCanvasFormat?.() ?? '?',
    devicePixelRatio: typeof window === 'undefined' ? 1 : window.devicePixelRatio,
    buffer: [e.getRenderWidth?.() ?? 0, e.getRenderHeight?.() ?? 0],
    errors: 0,
    firstErrors: [],
  }
  const d = diag
  e._device?.addEventListener('uncapturederror', ev => {
    d.errors++
    if (d.firstErrors.length < 5) {
      const msg = String(ev.error?.message ?? ev.error ?? 'unknown').slice(0, 400)
      d.firstErrors.push(msg)
      console.error('[gpu] WebGPU error', d.errors, msg)
    }
  })
  ;(globalThis as { __sroGpu?: unknown }).__sroGpu = { diagnostics: gpuDiagnostics, line: gpuDiagLine }
  console.info('[gpu]', JSON.stringify(d))
  return d
}

/** The diagnostics (null before the engine is made); the render size is read now. */
export function gpuDiagnostics(): GpuDiagnostics | null {
  if (diag && diagEngine) diag.buffer = [diagEngine.getRenderWidth?.() ?? 0, diagEngine.getRenderHeight?.() ?? 0]
  return diag
}

/** One line for the perf overlay: adapter, features, key limits, pixel ratio, render size, errors. */
export function gpuDiagLine(): string {
  const d = gpuDiagnostics()
  if (!d) return ''
  const a = [d.adapter.vendor, d.adapter.architecture, d.adapter.description].filter(Boolean).join(' ') || '?'
  const f = d.features.map(x => SHORT_FEATURES[x]).filter(Boolean).join(',')
  const l = KEY_LIMITS.filter(([k]) => k in d.limits).map(([k, s]) => `${s}${d.limits[k]}`).join(' ')
  const err = d.errors ? ` · ${d.errors} GPU errors: ${d.firstErrors[0]?.slice(0, 120) ?? ''}` : ''
  return `GPU ${a}${d.profile ? ` [${d.profile}]` : ''} · ${d.canvasFormat} · dpr ${d.devicePixelRatio} ${d.buffer[0]}x${d.buffer[1]} · ${f || 'no features'} · ${l}${err}`
}
