/**
 * The cloth sway chunk (docs/TOWN_LIFE.md §5.1; docs/WAVE_PLAN7.md D3, §6.1 TL-M). The foliage plugin
 * (pbr/foliage-plugin.ts) injects these strings into a region batch's `+sheen` group material under the define
 * `SRO_CLOTH_WIND` (W11-S's slot); **TL-M owns this file** and never edits the plugin.
 *
 * What the slot gives the chunk, in both languages (no GLSL reaches WebGPU):
 *   - `CLOTH_VERTEX_DEFS_*` sit in `CUSTOM_VERTEX_DEFINITIONS` under `SRO_CLOTH_WIND`, after the slot's declarations:
 *     the attribute `sroPivot` (vec4: pin height, hanging height, kind code, phase; world space, batch/region-batch.ts
 *     `clothPivots`) and WX-R's `sroWind(root)` (weather/chunks.ts).
 *   - `CLOTH_WORLDPOS_*` sit in `CUSTOM_VERTEX_UPDATE_WORLDPOS` under `SRO_CLOTH_WIND`, inside a block that declares
 *     `clothPivot` (the attribute; kind 0 = no sway: a `+sheen` piece without a cloth record) and, after the chunk,
 *     writes `worldPos.xyz` to `vPositionW`. The chunk moves `worldPos`.
 *   - The uniforms are the foliage plugin's UBO: `wxA`, `wxB` (the weather's wind vectors; `wxB.w` its clock) and
 *     `sroFol` (`.y`: the minimum breeze, FOLIAGE_MIN_BREEZE; `SRO_FOL_BREEZE` is on with it). No new uniform, sampler or
 *     varying (material-budgets.test.ts).
 *
 * TL-M (the prototype's `TownSway` math, work/tmp/town-life/lab/town-lab.ts, made per piece): a vertex `u` along the
 * piece, from its pin (`hanging`, `awning`: 0 at the top edge, 1 at the free edge; `tent`: 0 at the base, 1 at the
 * top), a weight `w` (hanging, awning: `u²`, and 0 below the band, `u > 1.02`, so a converter pin can name the cloth
 * part of a primitive and leave the rest still; tent: `sin(π u)`, both edges held and the middle breathing), and the
 * offset `strength × min(0.35 × height, 1 m) × w × gust × (0.55 + flap)` along the weather's wind: a slow gust per
 * piece (its phase) and a flap wave running down and across the cloth. A hanging piece also lifts as it swings out;
 * an awning swings half as far and flutters up and down; a tent billows at 0.6×. The strength is the weather's
 * (`wxB.z`) or the minimum breeze, so calm air still breathes. `clothSway` is the TS mirror (tests).
 */

/** The weight band's end for `hanging` and `awning`: below `pin − height × CLOTH_BAND_END` nothing moves. */
export const CLOTH_BAND_END = 1.02
/** Metres of sway per metre of hanging height at strength 1 (before the weight, the gust and the flap). */
export const CLOTH_AMP_PER_M = 0.35
/** The largest sway amplitude (m) at strength 1. */
export const CLOTH_AMP_MAX_M = 1
/** A tent's panels billow this fraction of a hanging piece's sway. */
export const CLOTH_TENT_SCALE = 0.6

/** Overall Pass: a UV-pinned piece's (`banner`, `flag`) flutter along its normal, metres per metre of sway amplitude. */
export const CLOTH_FLUTTER = 0.45

const F = (v: number): string => v.toFixed(2)

/*
 * The function returns (along the wind, up, along the normal, slope): the slope (sway per metre down the cloth) tilts
 * the normal in the move below so the light runs over the folds. Overall Pass: kinds 4 (`banner`) and 5 (`flag`) take
 * `u` from the texture (`uvc.y`, `uvc.x`) minus the pin, so a primitive with many banners pins each at its own top; the
 * flap wave runs from the pin to the free edge and a flutter (CLOTH_FLUTTER) moves the cloth along its normal.
 */

/** WGSL definitions under SRO_CLOTH_WIND (functions the sway needs). */
export const CLOTH_VERTEX_DEFS_WGSL = /* wgsl */ `fn sroClothSway(pv: vec4f, wp: vec3f, z: f32, t: f32, uvc: vec2f) -> vec4f {
  if (pv.z < 0.5) {
    return vec4f(0.0);
  }
  let h = max(pv.y, 0.05);
  let uvk = pv.z > 3.5;
  let tent = pv.z > 2.5 && !uvk;
  let awn = pv.z > 1.5 && pv.z < 2.5;
  let u = select(select(pv.x - wp.y, wp.y - pv.x, tent) / h, select(uvc.y, uvc.x, pv.z > 4.5) - pv.x, uvk);
  let c = clamp(u, 0.0, 1.0);
  let w = select(c * c * step(u, ${F(CLOTH_BAND_END)}), sin(3.14159265 * c), tent);
  let q = select(pv.w - wp.y * 2.2, pv.w - c * 4.5, uvk) + dot(wp.xz, vec2f(0.9, 0.7));
  let gust = 0.55 + 0.45 * sin(t * 0.7 + pv.w * 0.3);
  let flap = sin(t * 3.1 + q) * 0.35 + sin(t * 5.3 + pv.w * 0.7 + q * 1.7) * 0.12;
  let a = z * min(${F(CLOTH_AMP_PER_M)} * h, ${F(CLOTH_AMP_MAX_M)}) * w * gust * select(1.0, ${F(CLOTH_TENT_SCALE)}, tent);
  let s = a * (0.55 + flap);
  let fl = select(0.0, ${F(CLOTH_FLUTTER)} * a * sin(t * 6.3 - c * 7.0 + q * 0.5), uvk);
  let sl = select(2.0 * s / (max(c, 0.1) * h), 0.0, tent);
  if (awn) {
    return vec4f(0.5 * s, 0.6 * a * flap, 0.0, 0.5 * sl);
  }
  return vec4f(s, select(0.25 * s * s / h, 0.12 * a * flap, tent), fl, sl);
}
`

/** GLSL definitions under SRO_CLOTH_WIND. */
export const CLOTH_VERTEX_DEFS_GLSL = /* glsl */ `vec4 sroClothSway(vec4 pv, vec3 wp, float z, float t, vec2 uvc) {
  if (pv.z < 0.5) {
    return vec4(0.0);
  }
  float h = max(pv.y, 0.05);
  bool uvk = pv.z > 3.5;
  bool tent = pv.z > 2.5 && !uvk;
  bool awn = pv.z > 1.5 && pv.z < 2.5;
  float u = uvk ? (pv.z > 4.5 ? uvc.x : uvc.y) - pv.x : (tent ? wp.y - pv.x : pv.x - wp.y) / h;
  float c = clamp(u, 0.0, 1.0);
  float w = tent ? sin(3.14159265 * c) : c * c * step(u, ${F(CLOTH_BAND_END)});
  float q = (uvk ? pv.w - c * 4.5 : pv.w - wp.y * 2.2) + dot(wp.xz, vec2(0.9, 0.7));
  float gust = 0.55 + 0.45 * sin(t * 0.7 + pv.w * 0.3);
  float flap = sin(t * 3.1 + q) * 0.35 + sin(t * 5.3 + pv.w * 0.7 + q * 1.7) * 0.12;
  float a = z * min(${F(CLOTH_AMP_PER_M)} * h, ${F(CLOTH_AMP_MAX_M)}) * w * gust * (tent ? ${F(CLOTH_TENT_SCALE)} : 1.0);
  float s = a * (0.55 + flap);
  float fl = uvk ? ${F(CLOTH_FLUTTER)} * a * sin(t * 6.3 - c * 7.0 + q * 0.5) : 0.0;
  float sl = tent ? 0.0 : 2.0 * s / (max(c, 0.1) * h);
  if (awn) {
    return vec4(0.5 * s, 0.6 * a * flap, 0.0, 0.5 * sl);
  }
  return vec4(s, tent ? 0.12 * a * flap : 0.25 * s * s / h, fl, sl);
}
`

/**
 * WGSL statements moving `worldPos` (reads `clothPivot`, `clothNormal`, `uvUpdated`, `uniforms.wxB`, `uniforms.sroFol`)
 * and leaving the tilted normal in `clN` (the slot writes it back).
 */
export const CLOTH_WORLDPOS_WGSL = /* wgsl */ `#ifdef SRO_FOL_BREEZE
  let clZ = max(clamp(uniforms.wxB.z, 0.0, 1.0), uniforms.sroFol.y);
#else
  let clZ = clamp(uniforms.wxB.z, 0.0, 1.0);
#endif
  let clS = sroClothSway(clothPivot, worldPos.xyz, clZ, uniforms.wxB.w, uvUpdated);
  let clW = vec3f(uniforms.wxB.x, 0.0, uniforms.wxB.y);
  worldPos = vec4f(worldPos.xyz + clW * clS.x + vec3f(0.0, clS.y, 0.0) + clothNormal * clS.z, worldPos.w);
  let clN = normalize(clothNormal + vec3f(0.0, clS.w * dot(clothNormal, clW), 0.0) - clW * (clS.w * 0.3 * clothNormal.y));
`

/** GLSL statements moving `worldPos` (reads `clothPivot`, `clothNormal`, `uvUpdated`, `wxB`, `sroFol`); the normal in `clN`. */
export const CLOTH_WORLDPOS_GLSL = /* glsl */ `#ifdef SRO_FOL_BREEZE
  float clZ = max(clamp(wxB.z, 0.0, 1.0), sroFol.y);
#else
  float clZ = clamp(wxB.z, 0.0, 1.0);
#endif
  vec4 clS = sroClothSway(clothPivot, worldPos.xyz, clZ, wxB.w, uvUpdated);
  vec3 clW = vec3(wxB.x, 0.0, wxB.y);
  worldPos.xyz += clW * clS.x + vec3(0.0, clS.y, 0.0) + clothNormal * clS.z;
  vec3 clN = normalize(clothNormal + vec3(0.0, clS.w * dot(clothNormal, clW), 0.0) - clW * (clS.w * 0.3 * clothNormal.y));
`

/**
 * The chunk's offset in TS (tests, the lab): `pivot` = (pin, height, kind code, phase) as `clothPivots` writes it,
 * `p` the vertex's world position at rest, `strength` the wind's (or the breeze), `t` the weather clock (`wxB.w`),
 * `wind` the wind direction (`wxB.xy`), `uv` the vertex's texture coordinate (kinds 4, 5), `normal` its world normal
 * (the flutter's direction). Returns the world offset [x, y, z] (m).
 */
export function clothSway(
  pivot: readonly [number, number, number, number],
  p: readonly [number, number, number],
  strength: number,
  t: number,
  wind: readonly [number, number] = [1, 0],
  uv: readonly [number, number] = [0, 0],
  normal: readonly [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const [pin, height, kind, phase] = pivot
  if (kind < 0.5) return [0, 0, 0]
  const h = Math.max(height, 0.05)
  const uvk = kind > 3.5
  const tent = kind > 2.5 && !uvk
  const awn = kind > 1.5 && kind < 2.5
  const u = uvk ? (kind > 4.5 ? uv[0] : uv[1]) - pin : (tent ? p[1] - pin : pin - p[1]) / h
  const c = Math.min(1, Math.max(0, u))
  const w = tent ? Math.sin(3.14159265 * c) : c * c * (u <= CLOTH_BAND_END ? 1 : 0)
  const q = (uvk ? phase - c * 4.5 : phase - p[1] * 2.2) + p[0] * 0.9 + p[2] * 0.7
  const gust = 0.55 + 0.45 * Math.sin(t * 0.7 + phase * 0.3)
  const flap = Math.sin(t * 3.1 + q) * 0.35 + Math.sin(t * 5.3 + phase * 0.7 + q * 1.7) * 0.12
  const z = Math.min(1, Math.max(0, strength))
  const a = z * Math.min(CLOTH_AMP_PER_M * h, CLOTH_AMP_MAX_M) * w * gust * (tent ? CLOTH_TENT_SCALE : 1)
  const s = a * (0.55 + flap)
  const fl = uvk ? CLOTH_FLUTTER * a * Math.sin(t * 6.3 - c * 7.0 + q * 0.5) : 0
  const [sx, sy, sn] = awn ? [0.5 * s, 0.6 * a * flap, 0] : [s, tent ? 0.12 * a * flap : 0.25 * s * s / h, fl]
  return [wind[0] * sx + normal[0] * sn, sy + normal[1] * sn, wind[1] * sx + normal[2] * sn]
}
