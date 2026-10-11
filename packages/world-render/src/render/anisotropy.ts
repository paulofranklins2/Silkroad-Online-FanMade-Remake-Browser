/**
 * Anisotropic filtering per preset (RenderQuality.anisotropy): Babylon samples every texture at 4× by default, which
 * blurs the paving, roofs and terrain at grazing angles (most of the ground in a third-person view, all the more on
 * a wide screen). The preset's level becomes Babylon's default for new textures and is applied to the scene's
 * textures that were at the previous default (textures made at 1 on purpose, the nearest-sampled tables, stay so).
 * The sampler takes it at the next bind (WebGPU builds a sampler per level; the GPU clamps to its maximum).
 */
import { BaseTexture, type Scene } from '@babylonjs/core'

/** Babylon's own default (BaseTexture.DEFAULT_ANISOTROPIC_FILTERING_LEVEL), the level of a preset that names none. */
export const DEFAULT_ANISOTROPY = 4

/** Sets the anisotropy level for new textures and moves the scene's textures at the previous default to it. */
export function applyAnisotropy(scene: Scene, level: number = DEFAULT_ANISOTROPY): void {
  const next = Math.max(1, Math.min(16, Math.round(level)))
  const prev = BaseTexture.DEFAULT_ANISOTROPIC_FILTERING_LEVEL
  if (next === prev) return
  BaseTexture.DEFAULT_ANISOTROPIC_FILTERING_LEVEL = next
  for (const t of scene.textures) {
    if (t.anisotropicFilteringLevel === prev) t.anisotropicFilteringLevel = next
  }
}
