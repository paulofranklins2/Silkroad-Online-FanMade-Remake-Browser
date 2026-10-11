/**
 * The water's sky reflection (Overall Pass: AAA water): the modern sky dome itself (the new sky's atmosphere, sun halo,
 * moon, and the 2.5D / volumetric clouds, docs/SKY.md §13) rendered into a small HDR cube around the camera, so the
 * sea, the rivers and the ponds mirror the real sky with its clouds instead of a two-colour gradient (the ocean) or
 * the blurred 32–64² IBL cube (Babylon's environment radiance). One `ReflectionProbe` whose render list is the dome
 * alone (no other mesh: never a second scene render), linear (the dome's own scene-linear HDR, before the exposure),
 * mipmapped (the shaders pick the level from the roughness), refreshed every `refreshFrames` frames.
 *
 * Tiers (OceanQuality.skyProbe): Low none (Classic), Medium 64² / 30 frames, High 128² / 8, Ultra 256² / 4. The faces
 * at 256² cover ~19 % of a 1080p frame's pixels once per refresh; the sky's cost per pixel is the dome's own tier.
 * Only the modern dome is drawn (the Classic sky gives no probe: `texture` stays null and the shaders keep their
 * fallback). The probe's target never takes the prepass (post.ts: a render target without `noPrePassRenderer`
 * switched the prepass off mid-frame).
 *
 * The cube's orientation: `dirToCube` (the shaders' `sroSkyDir`) maps a world direction to the lookup vector; the
 * scene is right-handed and the probe flips z (Babylon's `invertZ`), so the lookup negates z (checked in the lab by
 * reading the faces back: the brightest texel lies along the sun, `brightestDir`).
 */
import { ReflectionProbe, type BaseTexture, type Camera, type Mesh, type Scene } from '@babylonjs/core'

/** A preset's probe: face size (px) and frames between refreshes. */
export interface SkyProbeQuality {
  size: number
  refreshFrames: number
}

/**
 * The lookup's sign per axis: a ReflectionProbe's +Y face looks down (Babylon's `invertYAxis` false) and, in a
 * right-handed scene, its +Z face looks along −z, so a world direction (x, y, z) is looked up at (x, −y, −z)
 * (checked in the lab with `brightestDir` against the sun).
 */
export const CUBE_LOOKUP: readonly [number, number, number] = [1, -1, -1]

/** The lookup vector of a world direction (and back: the map is its own inverse). */
export function dirToCube(x: number, y: number, z: number): [number, number, number] {
  return [x * CUBE_LOOKUP[0], y * CUBE_LOOKUP[1], z * CUBE_LOOKUP[2]]
}

/** The shaders' lookup of a reflected ray `r` (y clamped to the upper hemisphere first): `vec3(±r.x, ±max(r.y, 0), ±r.z)`. */
export function cubeLookupCode(lang: 'wgsl' | 'glsl', r: string): string {
  const s = (v: number) => (v < 0 ? '-' : '')
  return `${lang === 'wgsl' ? 'vec3f' : 'vec3'}(${s(CUBE_LOOKUP[0])}${r}.x, ${s(CUBE_LOOKUP[1])}max(${r}.y, 0.0), ${s(CUBE_LOOKUP[2])}${r}.z)`
}

export class WaterSkyReflection {
  private probe: ReflectionProbe | null = null
  private q: SkyProbeQuality | null = null
  private dome: Mesh | null = null
  private frames = 0

  constructor(readonly scene: Scene) {}

  /** The cube (null: no probe on this preset, or no modern dome yet / not rendered once). */
  get texture(): BaseTexture | null {
    return this.probe && this.frames > 0 ? this.probe.cubeTexture : null
  }

  /** Mip levels of the cube (the shaders' roughness → level scale). */
  get levels(): number {
    return this.q ? Math.max(1, Math.log2(this.q.size)) : 1
  }

  /** A preset change (null: none). Rebuilds only when the size changes. */
  setQuality(q: SkyProbeQuality | null): void {
    if (q && this.q && q.size === this.q.size) {
      this.q = q
      if (this.probe) this.probe.refreshRate = Math.max(1, q.refreshFrames)
      return
    }
    this.disposeProbe()
    this.q = q
  }

  /**
   * Per frame: follows the camera and the active dome (`dome` = the modern dome mesh, null with the Classic sky).
   * Returns true when the texture became available or went away (the materials' defines change).
   */
  update(camera: Camera | null, dome: Mesh | null): boolean {
    const before = this.texture !== null
    if (!this.q || !dome || !camera) {
      if (this.probe && !dome) this.disposeProbe()
      return before !== (this.texture !== null)
    }
    if (!this.probe) {
      const p = new ReflectionProbe('sroWaterSky', this.q.size, this.scene, true, true, true)
      p.refreshRate = Math.max(1, this.q.refreshFrames)
      const rt = p.cubeTexture
      rt.noPrePassRenderer = true
      rt.renderParticles = false
      rt.renderSprites = false
      rt.skipInitialClear = false
      rt.onAfterRenderObservable.add(() => {
        this.frames++
      })
      this.probe = p
      this.dome = null
    }
    if (this.dome !== dome) {
      const list = this.probe.renderList
      if (list) {
        list.length = 0
        list.push(dome)
      }
      this.dome = dome
    }
    this.probe.position.copyFrom(camera.globalPosition)
    return before !== (this.texture !== null)
  }

  /** The whole frame's sky in one direction (lab check): the brightest texel's world direction, face by face. */
  async brightestDir(): Promise<[number, number, number] | null> {
    const t = this.probe?.cubeTexture
    if (!t) return null
    const n = t.getSize().width
    let best = -1
    let dir: [number, number, number] | null = null
    for (let f = 0; f < 6; f++) {
      const px = (await t.readPixels(f, 0)) as ArrayBufferView | null
      if (!px) continue
      const a = px instanceof Uint16Array ? Array.from(px, halfToFloat) : Array.from(px as Float32Array)
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const o = (j * n + i) * 4
          const l = a[o]! + a[o + 1]! + a[o + 2]!
          if (l > best) {
            best = l
            const u = (2 * (i + 0.5)) / n - 1, v = (2 * (j + 0.5)) / n - 1
            const d = faceDir(f, u, v)
            dir = dirToCube(d[0], d[1], d[2])
          }
        }
      }
    }
    return dir
  }

  private disposeProbe(): void {
    this.probe?.dispose()
    this.probe = null
    this.dome = null
    this.frames = 0
  }

  dispose(): void {
    this.disposeProbe()
    this.q = null
  }
}

/** GL cube-map convention (sky/ibl.ts cubeDir), normalised. */
function faceDir(f: number, u: number, v: number): [number, number, number] {
  let x: number, y: number, z: number
  switch (f) {
    case 0: x = 1; y = -v; z = -u; break
    case 1: x = -1; y = -v; z = u; break
    case 2: x = u; y = 1; z = v; break
    case 3: x = u; y = -1; z = -v; break
    case 4: x = u; y = -v; z = 1; break
    default: x = -u; y = -v; z = -1; break
  }
  const l = Math.hypot(x, y, z)
  return [x / l, y / l, z / l]
}

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >> 10) & 0x1f
  const m = h & 0x3ff
  if (e === 0) return s * Math.pow(2, -14) * (m / 1024)
  if (e === 31) return m ? NaN : s * Infinity
  return s * Math.pow(2, e - 15) * (1 + m / 1024)
}
