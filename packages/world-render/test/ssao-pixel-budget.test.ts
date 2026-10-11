/**
 * 2026-10-11 (device-loss risk at 3440×1440 Ultra): above SSAO_FULL_RES_MAX_PIXELS Ultra's full-res SSAO runs at half
 * resolution (render/post.ts planPost `pixels`); at or below it, and on presets already half-res, nothing changes.
 */
import { describe, expect, it } from 'vitest'
import { RENDER_PRESETS, type GpuInfo } from '../src/index.ts'
import { SSAO_FULL_RES_MAX_PIXELS, planPost } from '../src/render/post.ts'

const GPU: GpuInfo = { maxInterStageShaderVariables: 28, maxSampledTexturesPerShaderStage: 16, features: [], vendor: 'amd', architecture: 'rdna-4', isFallbackAdapter: false }

describe('SSAO pixel budget', () => {
  it('Ultra keeps full-res SSAO up to 2560×1440, half-res on an ultrawide or 4K canvas', () => {
    expect(planPost('pbr', RENDER_PRESETS.ultra, GPU).ssao!.ratio).toBe(1)
    expect(planPost('pbr', RENDER_PRESETS.ultra, GPU, { pixels: 2560 * 1440 }).ssao!.ratio).toBe(1)
    const wide = planPost('pbr', RENDER_PRESETS.ultra, GPU, { pixels: 3440 * 1440 })
    expect(wide.ssao).toEqual({ ratio: 0.5, samples: RENDER_PRESETS.ultra.ssao!.samples })
    expect(wide.dropped.some(d => d.includes('half-res'))).toBe(true)
    expect(planPost('pbr', RENDER_PRESETS.ultra, GPU, { pixels: 3840 * 2160 }).ssao!.ratio).toBe(0.5)
    expect(SSAO_FULL_RES_MAX_PIXELS).toBe(2560 * 1440)
  })

  it('High (already half-res) is untouched at any size', () => {
    const p = planPost('pbr', RENDER_PRESETS.high, GPU, { pixels: 3840 * 2160 })
    expect(p.ssao!.ratio).toBe(0.5)
    expect(p.dropped.some(d => d.includes('half-res'))).toBe(false)
  })
})
