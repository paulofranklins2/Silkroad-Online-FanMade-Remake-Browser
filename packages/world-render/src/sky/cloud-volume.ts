/**
 * The volumetric clouds' 3D noise (Overall Pass item 10): one tileable RGBA8 volume, built on the CPU at sky start
 * (48³, a few slices per frame, so no load hitch), sampled by the dome's raymarch (sky-shaders.ts SKY_CLOUDS_VOLUME)
 * with linear filtering, repeat.
 *
 *   R  Perlin–Worley base shape (billowy cauliflower lobes)
 *   G  Worley fBm at 2× (edge erosion)
 *   B  Worley fBm at 4× (fine wisps, Ultra's detail octave)
 *   A  periodic value-noise fBm (storm churn / domain warp)
 *
 * The 2D cloud-noise texture stays the weather map (coverage per column), so the CPU's sun occlusion and the ground
 * cloud shadows (clouds.ts) still line up with the clouds drawn overhead. Pure apart from `makeCloudVolume`.
 */
import { Constants, RawTexture3D, type Scene } from '@babylonjs/core'

export const CLOUD_VOLUME_SIZE = 48

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 144665) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967295
}

/** Feature points of one tileable Worley octave (cells³ × xyz in cell units), cached. */
const POINTS = new Map<string, Float32Array>()
function points(cells: number, seed: number): Float32Array {
  const key = `${cells}:${seed}`
  let p = POINTS.get(key)
  if (!p) {
    p = new Float32Array(cells * cells * cells * 3)
    for (let z = 0, o = 0; z < cells; z++) for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
      p[o++] = hash3(x, y, z, seed)
      p[o++] = hash3(x, y, z, seed + 17)
      p[o++] = hash3(x, y, z, seed + 31)
    }
    POINTS.set(key, p)
  }
  return p
}

/** Tileable Worley (1 − F1) at `cells` cells per period. */
function worley(x: number, y: number, z: number, cells: number, seed: number): number {
  const pts = points(cells, seed)
  const px = x * cells, py = y * cells, pz = z * cells
  const cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz)
  let best = 9
  for (let k = -1; k <= 1; k++) {
    const gz = cz + k
    const wz = gz < 0 ? gz + cells : gz >= cells ? gz - cells : gz
    for (let j = -1; j <= 1; j++) {
      const gy = cy + j
      const wy = gy < 0 ? gy + cells : gy >= cells ? gy - cells : gy
      for (let i = -1; i <= 1; i++) {
        const gx = cx + i
        const wx = gx < 0 ? gx + cells : gx >= cells ? gx - cells : gx
        const o = ((wz * cells + wy) * cells + wx) * 3
        const fx = gx + pts[o]! - px, fy = gy + pts[o + 1]! - py, fz = gz + pts[o + 2]! - pz
        const d = fx * fx + fy * fy + fz * fz
        if (d < best) best = d
      }
    }
  }
  return 1 - Math.min(1, Math.sqrt(best))
}

const fade = (t: number) => t * t * (3 - 2 * t)

/** Tileable value noise at `cells` per period. */
function value(x: number, y: number, z: number, cells: number, seed: number): number {
  const px = x * cells, py = y * cells, pz = z * cells
  const x0 = Math.floor(px), y0 = Math.floor(py), z0 = Math.floor(pz)
  const tx = fade(px - x0), ty = fade(py - y0), tz = fade(pz - z0)
  const w = (v: number) => ((v % cells) + cells) % cells
  const h = (i: number, j: number, k: number) => hash3(w(x0 + i), w(y0 + j), w(z0 + k), seed)
  const l = (a: number, b: number, t: number) => a + (b - a) * t
  return l(
    l(l(h(0, 0, 0), h(1, 0, 0), tx), l(h(0, 1, 0), h(1, 1, 0), tx), ty),
    l(l(h(0, 0, 1), h(1, 0, 1), tx), l(h(0, 1, 1), h(1, 1, 1), tx), ty),
    tz,
  )
}

const remap = (v: number, a: number, b: number, c: number, d: number) => c + ((v - a) / (b - a)) * (d - c)
const sat = (v: number) => Math.max(0, Math.min(1, v))

/** Fills z-slices [z0, z1) of the RGBA8 voxels (x fastest, then y, then z). */
export function fillCloudVolume(out: Uint8Array, n: number, z0: number, z1: number): void {
  let o = z0 * n * n * 4
  for (let z = z0; z < z1; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = x / n, v = y / n, w = z / n
    const vf = value(u, v, w, 4, 1) * 0.5 + value(u, v, w, 8, 2) * 0.3 + value(u, v, w, 16, 3) * 0.2
    const wf = worley(u, v, w, 4, 5) * 0.625 + worley(u, v, w, 8, 6) * 0.25 + worley(u, v, w, 16, 7) * 0.125
    const pw = sat(remap(vf, wf - 1, 1, 0, 1))
    const g = worley(u, v, w, 8, 9) * 0.625 + worley(u, v, w, 16, 10) * 0.375
    const b = worley(u, v, w, 16, 11) * 0.625 + worley(u, v, w, 24, 12) * 0.375
    const a = value(u, v, w, 3, 13) * 0.6 + value(u, v, w, 6, 14) * 0.4
    out[o++] = Math.round(sat((pw - 0.35) * 1.6) * 255)
    out[o++] = Math.round(sat(g) * 255)
    out[o++] = Math.round(sat(b) * 255)
    out[o++] = Math.round(sat(a) * 255)
  }
}

export function buildCloudVolume(n = CLOUD_VOLUME_SIZE): Uint8Array {
  const out = new Uint8Array(n * n * n * 4)
  fillCloudVolume(out, n, 0, n)
  return out
}

/**
 * The volume as a linear (no mips), repeating 3D texture. It starts flat grey (the clouds render from the 2D weather
 * map alone) and is filled a few slices per frame (≤ 2 ms per frame), then uploaded once.
 */
export function makeCloudVolume(scene: Scene, n = CLOUD_VOLUME_SIZE): RawTexture3D {
  const data = new Uint8Array(n * n * n * 4).fill(150)
  const tex = new RawTexture3D(
    data, n, n, n, Constants.TEXTUREFORMAT_RGBA, scene, false, false,
    Constants.TEXTURE_BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE,
  )
  tex.name = 'skyCloudVolume'
  tex.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE
  tex.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE
  tex.wrapR = Constants.TEXTURE_WRAP_ADDRESSMODE
  let z = 0
  let done = false
  const obs = scene.onBeforeRenderObservable.add(() => {
    if (done) return
    const t0 = performance.now()
    while (z < n && performance.now() - t0 < 2) {
      fillCloudVolume(data, n, z, z + 1)
      z++
    }
    if (z >= n) {
      done = true
      tex.update(data)
      scene.onBeforeRenderObservable.remove(obs)
    }
  })
  tex.onDisposeObservable.addOnce(() => scene.onBeforeRenderObservable.remove(obs))
  return tex
}
