/**
 * CPU copies Babylon keeps only to rebuild after a lost context (Overall Pass round 7, docs/PERF_OVERALL.md memory pass).
 * On WebGPU the game never rebuilds in place: a lost device reloads the page (gpu-loss.ts). Two kinds of copy add up:
 *
 * - every compiled effect's shader source (its processed WGSL, kept by the effect and by its pipeline context): with
 *   the persistent effects (PERF.effectsPersistent) ≈ 200 MB of strings on the route;
 * - the raw data of 2D-array and 3D textures (the terrain's tile atlases, the grass and sky volumes: `_bufferView`).
 *
 * `trimCpuCopies` drops both, every TRIM_INTERVAL_MS, for ready effects and array / volume textures only. Kept on
 * purpose: the encoded bytes of glTF images (`_buffer`: the batcher's atlas reads them, world-render batch/atlas.ts) and
 * plain 2D raw textures (`_bufferView`: Babylon reads a VAT's data for the crowd's bounding boxes).
 */
import type { AbstractEngine } from '@babylonjs/core'
import { PERF } from '../world/perf.ts'

export const TRIM_INTERVAL_MS = 10_000

interface EffectLike {
  isReady(): boolean
  clearCodeCache(): void
  _pipelineContext?: { sources?: unknown } | null
  _sroTrimmed?: true
}
interface TextureLike {
  is2DArray?: boolean
  is3D?: boolean
  _bufferView?: unknown
}

/** One pass (see the header); returns what it trimmed. */
export function trimCpuCopiesOnce(engine: AbstractEngine): { effects: number; textures: number } {
  let effects = 0
  let textures = 0
  const compiled = (engine as unknown as { _compiledEffects?: Record<string, EffectLike> })._compiledEffects ?? {}
  for (const k in compiled) {
    const e = compiled[k]!
    if (e._sroTrimmed || !e.isReady()) continue
    e.clearCodeCache()
    if (e._pipelineContext && 'sources' in e._pipelineContext) e._pipelineContext.sources = undefined
    e._sroTrimmed = true
    effects++
  }
  for (const t of engine.getLoadedTexturesCache() as unknown as TextureLike[]) {
    if ((t.is2DArray || t.is3D) && t._bufferView) {
      t._bufferView = null
      textures++
    }
  }
  return { effects, textures }
}

/** Trims every TRIM_INTERVAL_MS while PERF.trimCpuCopies (WebGPU only); returns the stop. */
export function trimCpuCopies(engine: AbstractEngine): () => void {
  if (!engine.isWebGPU) return () => {}
  const timer = setInterval(() => {
    if (PERF.trimCpuCopies && !engine.isDisposed) trimCpuCopiesOnce(engine)
  }, TRIM_INTERVAL_MS)
  return () => clearInterval(timer)
}
