/**
 * `SroWaterPlugin`: the water on the PBR presets (docs/RENDER.md §7, docs/WAVE_PLAN3.md §6.14, D21, D24). Owned by
 * RND-W; water.ts builds the material (`createPbrWater`) and feeds `WaterPbrState` each frame. The Classic water
 * (ShaderMaterial, WX-R's chunk) is untouched.
 *
 * One PBRMaterial per world: alpha blend, no depth write, metallic 0, roughness 0.04 (0.15 in rain), so the sky cube
 * (RND-L's `scene.environmentTexture`) gives the Fresnel sky reflection and the celestial light a sun glint; the
 * reflection stays visible where the water is thin (`useRadianceOverAlpha`, `useSpecularOverAlpha`). The fog is the
 * PBR height fog (RND-P's SroFogPlugin joins every PBR material). The plugin, in both languages at the same points:
 *
 * - `CUSTOM_FRAGMENT_MAIN_BEGIN`: everything is computed once, in the fragment's uniform control flow (so every tap is
 *   a plain textureSample): the retail frame (the 30-frame animation of the Classic water, 8 m per repeat, from the
 *   world position: the PBR water has no uv) × the water colour stays the albedo (the scattering colour) at 60 %,
 *   darker with depth (× the deep colour); the normal from our own tileable normal map sampled twice, scrolling at
 *   (0.03, 0.01) m/s with a 6 m period and (−0.02, 0.025) m/s with a 17 m period, × the block's wave type (0.5 / 0.8 /
 *   1.0 / 1.3); in rain, WX-R's ripple texture (D21: one ripple source) as expanding rings, two layers.
 * - `CUSTOM_FRAGMENT_UPDATE_ALBEDO` / `_ALPHA` / `_METALLICROUGHNESS`: the albedo, the alpha and the normal, the
 *   roughness.
 * - Alpha: SRO_WATER_SHORE (High+, `waterDepthShore`) = saturate(depth / 1.5 m) with a foam band under 0.3 m. The depth
 *   is the water height minus the terrain height per vertex; the water grid is the terrain's 2 m grid, so across a cell
 *   the interpolated depth is the water's real depth over the terrain surface, and the shore line lands where the
 *   water meets the ground without a depth pass (RENDER §7's depth renderer would draw every opaque mesh again: the
 *   game is CPU-bound). Without it (Medium) the retail per-vertex alpha (full at 3 m) stays.
 *
 * Vertex colour of the PBR water meshes: r = (depth + 1) / 9 (−1..8 m), g = wave amplitude / 2, b = 0, a = the retail
 * alpha. The plugin overwrites Babylon's vertex-colour multiply on the albedo and the alpha.
 */
import {
  Color3,
  Constants,
  MaterialPluginBase,
  PBRMaterial,
  RawTexture,
  ShaderLanguage,
  Texture,
  Vector4,
  type AbstractEngine,
  type AbstractMesh,
  type BaseTexture,
  type Material,
  type MaterialDefines,
  type Scene,
  type SubMesh,
  type UniformBuffer,
} from '@babylonjs/core'
import { useWindowedLightFalloff } from '../render/babylon-fixes.ts'
import { rainRingCode, ringTaps } from '../weather/ripples.ts'
import { cubeLookupCode } from '../ocean/sky-reflection.ts'

export const SRO_WATER_PLUGIN = 'SroWaterPlugin'
/** Retail frame repeat (m): 4 repeats per 32 m block, as the Classic water. */
export const WATER_FRAME_REPEAT_M = 8
/** The two normal-map layers: scroll (m/s) and period (m) (RENDER §7). */
export const WATER_NORMAL_LAYERS = [
  { scroll: [0.03, 0.01], periodM: 6 },
  { scroll: [-0.02, 0.025], periodM: 17 },
] as const
/** Wave-type amplitude (the block's `water.wave`, 0..3; RENDER §7). */
export const WATER_WAVE_AMPLITUDE = [0.5, 0.8, 1, 1.3] as const
/** The shore alpha reaches 1 at this depth (m) and the foam band ends here (High+). */
export const WATER_SHORE_M = 1.5
export const WATER_FOAM_M = 0.3
/**
 * Roughness dry and in full rain. Wave 12 (RAIN-P): 0.15 → 0.07 in rain, so the rain rings stay sharp in the sky's
 * reflection (the rings are what rain on water looks like; a blurred reflection hid them).
 */
export const WATER_ROUGHNESS: readonly [number, number] = [0.04, 0.07]
/**
 * Rain rings on the water (wave 12 RAIN-P; weather/ripples.ts `rainRingCode`): ripple-texture repeats per metre (a
 * 2.9 m tile, rings up to 26 cm: a pond is seen from farther than the paving), the normal gain at full strength, the
 * camera distance (m) over which they fade (the taps are two mips sharper, RAIN_RING_LOD_BIAS: the aliasing would show
 * beyond), and the linear grey a drop's impact crown lifts the albedo toward.
 */
export const WATER_RING_SCALE = 0.35
export const WATER_RING_GAIN = 1.1
export const WATER_RING_FADE_M: readonly [number, number] = [30, 70]
export const WATER_CROWN_ALBEDO = 0.5
/**
 * The rings' glint: a ring's crests and a drop's crown add this × the sky the surface mirrors (Babylon's environment
 * radiance, scene-linear) on top of the tilted normal's own reflection. Seen from above (a small Fresnel) the tilt
 * alone left the rings invisible on the town's dark pond.
 */
export const WATER_RING_GLINT = 0.8
/**
 * The ring lines: a crest lifts the water's albedo toward this linear grey by up to WATER_RING_LINE × its height, and
 * raises the alpha with it (the shallow pond is nearly transparent, so a surface feature needs its own opacity). After
 * the town plugin's profile (UPDATE_ALBEDO / UPDATE_ALPHA), so the turbid pond keeps its lines.
 */
export const WATER_RING_LINE = 0.55
export const WATER_RING_LINE_ALBEDO = 0.32
/** The albedo weight of the retail colour (RENDER §7: 60 %). */
export const WATER_ALBEDO_WEIGHT = 0.6
/** Deep water: the albedo × this at 4 m. */
export const WATER_DEEP: readonly [number, number, number] = [0.35, 0.5, 0.55]

/**
 * Overall Pass (AAA water), flowing rivers: the flow layer's period (m), the two-phase flow map's cycle (s; each phase
 * is pushed along the flow for a cycle, then fades out while the other, half a cycle apart, fades in) and the river's
 * speed (m/s) at full strength (water.ts `riverFlow`).
 */
export const FLOW_PERIOD_M = 4
export const FLOW_CYCLE_S = 3
export const FLOW_SPEED_MS = 0.9
/** The sun's glitter on the retail water (a coarser facet than the sea's: the normal map's 17 m layer), fading with the camera distance (m). */
export const WATER_GLINT_SLOPE = 0.1
export const WATER_GLINT_SHARP = 900
export const WATER_GLINT_GAIN = 40
export const WATER_GLINT_FADE_M: readonly [number, number] = [30, 120]

/** Amplitude of a block's wave type (unknown types: 1). */
export function waveAmplitude(wave: number): number {
  return WATER_WAVE_AMPLITUDE[wave as 0 | 1 | 2 | 3] ?? 1
}

/** The High+ shore alpha at a water depth (m): the shader's `saturate(depth / 1.5)`. */
export function shoreAlpha(depthM: number): number {
  return Math.min(1, Math.max(0, depthM / WATER_SHORE_M))
}

/** The foam weight of the shader at a depth (m): 0 on dry ground, 1 at the water line, 0 from 0.3 m. */
export function foamAmount(depthM: number): number {
  const s = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)
  }
  return s(-0.05, 0.02, depthM) * (1 - s(0.05, WATER_FOAM_M, depthM))
}

/** Vertex colour r of a depth (m): (depth + 1) / 9, clamped (the shader decodes r × 9 − 1). */
export function encodeWaterDepth(depthM: number): number {
  return Math.min(1, Math.max(0, (depthM + 1) / 9))
}

/** The water colour's hue at its noon brightness: the PBR light carries the time of day, not the retail palette. */
export function waterHue(c: readonly [number, number, number], level = 0.69): [number, number, number] {
  const m = Math.max(c[0], c[1], c[2])
  if (!(m > 1e-4)) return [level * 0.52, level, level * 0.9]
  return [(c[0] / m) * level, (c[1] / m) * level, (c[2] / m) * level]
}

// ---- the normal map -----------------------------------------------------------------------------------------------

/**
 * A tileable tangent-space normal map (+Z up, green up): height = Σ a·sin(2π(k·p) + φ) with integer wave vectors,
 * amplitudes falling with frequency; the normal is the analytic gradient. Our own art (the same method as
 * tools/make-render-textures.ts `water-normal.png`, built here in memory so no asset URL is needed).
 */
export function waterNormalPixels(size = 128, seed = 7, waves = 28, strength = 0.8): Uint8Array<ArrayBuffer> {
  let a = seed >>> 0
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const list: Array<{ kx: number; ky: number; a: number; ph: number }> = []
  for (let i = 0; i < waves; i++) {
    const f = 1 + Math.floor(Math.pow(rand(), 1.6) * 10)
    const ang = rand() * Math.PI * 2
    const kx = Math.round(Math.cos(ang) * f), ky = Math.round(Math.sin(ang) * f)
    if (kx === 0 && ky === 0) continue
    list.push({ kx, ky, a: 1 / Math.pow(Math.hypot(kx, ky), 1.3), ph: rand() * Math.PI * 2 })
  }
  const out = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size
      let gx = 0, gy = 0
      for (const w of list) {
        const c = Math.cos(2 * Math.PI * (w.kx * u + w.ky * v) + w.ph) * w.a * 2 * Math.PI
        gx += c * w.kx
        gy += c * w.ky
      }
      const sx = (-gx * strength / size) * 8, sy = (-gy * strength / size) * 8
      const l = Math.hypot(sx, sy, 1)
      const o = (y * size + x) * 4
      out[o] = Math.round((sx / l * 0.5 + 0.5) * 255)
      out[o + 1] = Math.round((-sy / l * 0.5 + 0.5) * 255)
      out[o + 2] = Math.round((1 / l * 0.5 + 0.5) * 255)
      out[o + 3] = 255
    }
  }
  return out
}

// ---- shader code --------------------------------------------------------------------------------------------------

const FOAM = `(1.0 - smoothstep(0.05, ${WATER_FOAM_M.toFixed(2)}, sroWD)) * smoothstep(-0.05, 0.02, sroWD)`
const L0 = WATER_NORMAL_LAYERS[0], L1 = WATER_NORMAL_LAYERS[1]
const v2 = (lang: 'wgsl' | 'glsl', x: number, y: number) => `${lang === 'wgsl' ? 'vec2f' : 'vec2'}(${x.toFixed(3)}, ${y.toFixed(3)})`

/**
 * The fragment code in one language (Overall Pass, AAA water, on top of RND-W's): the flow map (SRO_WATER_FLOW: the
 * river's two-phase flow layer and its rapids foam, from the `sroFlow` vertex attribute), the sky cube's reflection
 * (SRO_WATER_SKY), the sun's glitter (SRO_WATER_GLINT) and the Fresnel blend of the ocean's P-LOOK (ocean-plugin.ts
 * `blendCode`: the reflected light reaches the screen at full strength through thin water; the background is
 * weighted by what the surface transmits).
 */
function fragCode(lang: 'wgsl' | 'glsl'): Record<string, string> {
  const w = lang === 'wgsl'
  const V2 = w ? 'vec2f' : 'vec2', V3 = w ? 'vec3f' : 'vec3'
  const u = (n: string) => (w ? `uniforms.${n}` : n)
  const fin = (n: string) => (w ? `fragmentInputs.${n}` : n)
  const tap = (uv: string) => (w ? `textureSample(sroWaterNormal, sroWaterNormalSampler, ${uv})` : `texture(sroWaterNormal, ${uv})`)
  const L = (type: string, name: string, value: string) => (w ? `let ${name} = ${value};` : `${type} ${name} = ${value};`)
  const M = (type: string, name: string, value: string) => (w ? `var ${name} = ${value};` : `${type} ${name} = ${value};`)
  const pos = fin('vPositionW')
  const eye = w ? 'scene.vEyePosition.xyz' : 'vEyePosition.xyz'
  const col = fin('vColor')
  const n = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v))
  const defs = w
    ? `#ifdef SRO_WATER
var sroWaterFrames: texture_2d_array<f32>;
var sroWaterFramesSampler: sampler;
var sroWaterNormal: texture_2d<f32>;
var sroWaterNormalSampler: sampler;
#ifdef SRO_WATER_RIPPLE
var sroWaterRipple: texture_2d<f32>;
var sroWaterRippleSampler: sampler;
var<private> sroWGlint: f32;
var<private> sroWCrown: f32;
var<private> sroWLine: f32;
${rainRingCode('wgsl', 'sroWRing')}#endif
#ifdef SRO_WATER_FLOW
varying vSroFlow: vec4f;
#endif
#ifdef SRO_WATER_SKY
var sroWaterSky: texture_cube<f32>;
var sroWaterSkySampler: sampler;
var<private> sroWSky: vec3f;
#endif
var<private> sroWAlb: vec3f;
var<private> sroWAlpha: f32;
var<private> sroWN: vec3f;
var<private> sroWGl: vec3f;
var<private> sroWRap: f32;
#endif
`
    : `#ifdef SRO_WATER
uniform highp sampler2DArray sroWaterFrames;
uniform sampler2D sroWaterNormal;
#ifdef SRO_WATER_RIPPLE
uniform sampler2D sroWaterRipple;
float sroWGlint;
float sroWCrown;
float sroWLine;
${rainRingCode('glsl', 'sroWRing')}#endif
#ifdef SRO_WATER_FLOW
varying vec4 vSroFlow;
#endif
#ifdef SRO_WATER_SKY
uniform samplerCube sroWaterSky;
vec3 sroWSky;
#endif
vec3 sroWAlb;
float sroWAlpha;
vec3 sroWN;
vec3 sroWGl;
float sroWRap;
#endif
`
  const frames = w
    ? `textureSample(sroWaterFrames, sroWaterFramesSampler, sroWP / ${WATER_FRAME_REPEAT_M.toFixed(1)}, i32(uniforms.sroWaterA.x + 0.5)).rgb`
    : `texture(sroWaterFrames, vec3(sroWP / ${WATER_FRAME_REPEAT_M.toFixed(1)}, floor(sroWaterA.x + 0.5))).rgb`
  const clamp3 = w ? 'clamp(sroWF * uniforms.sroWaterB.rgb, vec3f(0.0), vec3f(1.0)), vec3f(2.2)' : 'clamp(sroWF * sroWaterB.rgb, 0.0, 1.0), vec3(2.2)'
  const main = `#ifdef SRO_WATER
{
  ${L(V2, 'sroWP', `${pos}.xz`)}
  ${L('float', 'sroWT', `${u('sroWaterA')}.y`)}
  ${L(V3, 'sroWF', frames)}
  ${L('float', 'sroWD', `${col}.r * 9.0 - 1.0`)}
  ${L('float', 'sroWAmp', `${col}.g * 2.0 * ${u('sroWaterC')}.w`)}
  ${M(V2, 'sroN0', `${tap(`(sroWP + sroWT * ${v2(lang, L0.scroll[0], L0.scroll[1])}) / ${L0.periodM.toFixed(1)}`)}.xy * 2.0 - ${V2}(1.0)`)}
  ${M(V2, 'sroN1', `${tap(`(sroWP + sroWT * ${v2(lang, L1.scroll[0], L1.scroll[1])}) / ${L1.periodM.toFixed(1)}`)}.xy * 2.0 - ${V2}(1.0)`)}
  sroWRap = 0.0;
#ifdef SRO_WATER_FLOW
  // AAA water: the river's flow map (two phases half a cycle apart, each pushed along the flow, cross-faded), and the
  // rapids' foam streaks where the attribute's z says fast and shallow (water.ts riverFlow).
  ${L('vec4', 'sroFl', fin('vSroFlow'))}
  ${L('float', 'sroPh', `fract(sroWT / ${n(FLOW_CYCLE_S)})`)}
  ${L('float', 'sroFw', '1.0 - abs(1.0 - 2.0 * sroPh)')}
  ${L(V2, 'sroFa', `${tap(`(sroWP - sroFl.xy * (sroPh * ${n(FLOW_CYCLE_S)})) / ${n(FLOW_PERIOD_M)}`)}.xy * 2.0 - ${V2}(1.0)`)}
  ${L(V2, 'sroFb', `${tap(`(sroWP - sroFl.xy * (fract(sroPh + 0.5) * ${n(FLOW_CYCLE_S)})) / ${n(FLOW_PERIOD_M)} + ${V2}(0.5, 0.31)`)}.xy * 2.0 - ${V2}(1.0)`)}
  ${L(V2, 'sroFn', 'sroFa * sroFw + sroFb * (1.0 - sroFw)')}
  sroN0 = mix(sroN0, sroFn * 1.4, sroFl.w);
  sroN1 = mix(sroN1, ${V2}(sroFn.y, -sroFn.x), sroFl.w * 0.6);
  sroWRap = sroFl.z * smoothstep(0.25, 0.8, max(sroFa.x * sroFw, sroFb.x * (1.0 - sroFw)) + 0.45 * sroFl.z);
#endif
  ${M(V2, 'sroSlope', '(sroN0 + sroN1 * 0.7) * (0.35 * sroWAmp)')}
#ifdef SRO_WATER_RIPPLE
  ${L(V2, 'sroRu', `sroWP * ${WATER_RING_SCALE.toFixed(3)}`)}
  ${L('float', 'sroRr', `clamp(${u('sroWaterA')}.z, 0.0, 1.0)`)}
${ringTaps(lang, 'sroWRing', 'sroWaterRipple', 'sroRu', null, null, `${u('sroWaterA')}.w`, 'sroRr', 'sroR')}  ${L('float', 'sroRa', `smoothstep(0.0, 0.15, sroRr) * (1.0 - smoothstep(${WATER_RING_FADE_M[0].toFixed(1)}, ${WATER_RING_FADE_M[1].toFixed(1)}, distance(${eye}, ${pos})))`)}
  sroSlope = sroSlope + ${V2}(sroR.x, -sroR.y) * (${WATER_RING_GAIN.toFixed(2)} * sroRa);
  sroWCrown = clamp(sroR.z * sroRa, 0.0, 1.0);
  sroWLine = clamp(max(sroR.w, 0.0) * sroRa * ${WATER_RING_LINE.toFixed(2)}, 0.0, 1.0);
  sroWGlint = (max(sroR.w, 0.0) + sroR.z) * sroRa;
#endif
  sroWN = normalize(${V3}(sroSlope.x, 1.0, -sroSlope.y));
  ${L(V3, 'sroWV', `normalize(${eye} - ${pos})`)}
#ifdef SRO_WATER_SKY
  // AAA water: the sky cube along the reflected ray (ocean/sky-reflection.ts; the probe's faces are z-flipped).
  ${L(V3, 'sroWR', 'reflect(-sroWV, sroWN)')}
  ${L('float', 'sroWLod', `clamp(${u('sroWaterB')}.w * ${u('sroWaterB')}.w * 2.0 * ${u('sroWaterD')}.x, ${u('sroWaterD')}.y, ${u('sroWaterD')}.x)`)}
  sroWSky = ${w ? `textureSampleLevel(sroWaterSky, sroWaterSkySampler, ${cubeLookupCode('wgsl', 'sroWR')}, sroWLod).rgb` : `textureLod(sroWaterSky, ${cubeLookupCode('glsl', 'sroWR')}, sroWLod).rgb`};
#endif
  sroWGl = ${V3}(0.0);
#ifdef SRO_WATER_GLINT
  // AAA water: the sun's glitter on facets tilted by the 17 m layer, fading out with the camera distance.
  ${L(V3, 'sroGn', `normalize(sroWN + ${V3}(sroN1.x, 0.0, -sroN1.y) * ${n(WATER_GLINT_SLOPE)})`)}
  ${L('float', 'sroGl', `pow(max(dot(reflect(-sroWV, sroGn), ${u('sroWaterS')}.xyz), 0.0), ${n(WATER_GLINT_SHARP)}) * (0.02 + 0.98 * pow(1.0 - clamp(dot(sroGn, sroWV), 0.0, 1.0), 5.0)) * ${n(WATER_GLINT_GAIN)} * (1.0 - smoothstep(${n(WATER_GLINT_FADE_M[0])}, ${n(WATER_GLINT_FADE_M[1])}, distance(${eye}, ${pos}))) * smoothstep(-0.02, 0.05, ${u('sroWaterS')}.y)`)}
  sroWGl = ${u('sroWaterSC')}.rgb * (sroGl * ${u('sroWaterD')}.w);
#endif
  ${L(V3, 'sroShallow', `pow(${clamp3}) * ${WATER_ALBEDO_WEIGHT.toFixed(2)}`)}
#ifdef SRO_WATER_SHORE
  ${L('float', 'sroDeep', 'clamp(sroWD / 4.0, 0.0, 1.0)')}
  ${L('float', 'sroFoam', `max(${FOAM} * clamp(0.6 + sroN0.x, 0.0, 1.0), sroWRap)`)}
  sroWAlpha = max(clamp(sroWD / ${WATER_SHORE_M.toFixed(2)}, 0.0, 1.0), sroFoam * 0.7);
  sroWAlb = mix(mix(sroShallow, sroShallow * ${u('sroWaterC')}.rgb, sroDeep), ${V3}(0.55), sroFoam);
#else
  ${L('float', 'sroDeep', `clamp(${col}.a, 0.0, 1.0)`)}
  sroWAlpha = max(clamp(${col}.a, 0.0, 1.0), sroWRap * 0.7);
  sroWAlb = mix(mix(sroShallow, sroShallow * ${u('sroWaterC')}.rgb, sroDeep), ${V3}(0.55), sroWRap);
#endif
}
#endif
`
  const albedo = `#ifdef SRO_WATER
surfaceAlbedo = sroWAlb;
#ifdef SRO_WATER_RIPPLE
surfaceAlbedo = mix(mix(surfaceAlbedo, ${V3}(${WATER_RING_LINE_ALBEDO.toFixed(2)}), sroWLine), ${V3}(${WATER_CROWN_ALBEDO.toFixed(2)}), sroWCrown * 0.8);
#endif
#endif
`
  const alpha = `#ifdef SRO_WATER
alpha = sroWAlpha;
#ifdef SRO_WATER_RIPPLE
alpha = max(alpha, max(sroWCrown * 0.85, sroWLine * 1.5));
#endif
normalW = sroWN;
#endif
`
  const rough = `#ifdef SRO_WATER
metallicRoughness = ${V2}(0.0, ${u('sroWaterB')}.w);
#endif
`
  // The blend (ocean-plugin.ts blendCode): α' = α + F (1 − α); reflected terms / α', scattered ones × α (1 − F) / α'.
  // With the sky cube, the cube replaces Babylon's blurred environment radiance. The rings' glint stays as it was.
  const F = (type: string, name: string, value: string) => L(type, name, value)
  const blend = `#ifdef SRO_WATER
{
  ${F('float', 'sroBc', `clamp(dot(sroWN, normalize(${eye} - ${pos})), 0.0, 1.0)`)}
  ${F('float', 'sroBf', 'clamp(0.02 + (max(1.0 - reflectivityOut.roughness, 0.02) - 0.02) * pow(1.0 - sroBc, 5.0), 0.0, 1.0)')}
  ${F('float', 'sroBa', 'clamp(alpha, 0.0, 1.0)')}
  ${F('float', 'sroB1', 'max(sroBa + sroBf * (1.0 - sroBa), 0.001)')}
  ${F('float', 'sroKd', 'sroBa * (1.0 - sroBf) / sroB1')}
  ${F('float', 'sroKr', '1.0 / sroB1')}
  finalDiffuse = finalDiffuse * sroKd;
  finalAmbient = finalAmbient * sroKd;
#ifdef REFLECTION
  finalIrradiance = finalIrradiance * sroKd;
#ifdef SRO_WATER_SKY
  finalRadianceScaled = finalRadianceScaled * 0.0;
#else
  finalRadianceScaled = finalRadianceScaled * sroKr;
#endif
#ifdef SRO_WATER_RIPPLE
  finalEmissive = finalEmissive + reflectionOut.environmentRadiance.rgb * (${u('vLightingIntensity')}.z * ${WATER_RING_GLINT.toFixed(2)} * sroWGlint);
#endif
#endif
#ifdef SPECULARTERM
  finalSpecularScaled = finalSpecularScaled * sroKr;
#endif
#ifdef SRO_WATER_SKY
  finalEmissive = finalEmissive + sroWSky * (sroBf * sroKr);
#endif
  finalEmissive = finalEmissive + sroWGl * sroKr;
  alpha = sroB1;
}
#endif
`
  // SSR on the water (High/Ultra, sroWaterD.z = 1): the prepass reflectivity takes the Fresnel (ocean-plugin.ts).
  const ssr = `#ifdef SRO_WATER
#ifdef PREPASS_REFLECTIVITY
specularEnvironmentR0 = max(specularEnvironmentR0, ${V3}(clamp(0.02 + 0.98 * pow(1.0 - clamp(dot(sroWN, normalize(${eye} - ${pos})), 0.0, 1.0), 5.0), 0.0, 1.0) * ${u('sroWaterD')}.z));
#endif
#endif
`
  return {
    CUSTOM_FRAGMENT_DEFINITIONS: defs,
    CUSTOM_FRAGMENT_MAIN_BEGIN: main,
    CUSTOM_FRAGMENT_UPDATE_ALBEDO: albedo,
    CUSTOM_FRAGMENT_UPDATE_ALPHA: alpha,
    CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS: rough,
    CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: blend,
    CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: ssr,
  }
}

const WGSL: Record<string, string> = fragCode('wgsl')
const GLSL: Record<string, string> = fragCode('glsl')

/** The flow attribute's vertex code (SRO_WATER_FLOW): the attribute straight into its varying. */
export function waterVertexCode(lang: 'wgsl' | 'glsl'): Record<string, string> {
  return lang === 'wgsl'
    ? {
        CUSTOM_VERTEX_DEFINITIONS: `#ifdef SRO_WATER_FLOW\nattribute ${WATER_FLOW_ATTRIBUTE}: vec4f;\nvarying vSroFlow: vec4f;\n#endif\n`,
        CUSTOM_VERTEX_MAIN_END: `#ifdef SRO_WATER_FLOW\nvertexOutputs.vSroFlow = vertexInputs.${WATER_FLOW_ATTRIBUTE};\n#endif\n`,
      }
    : {
        CUSTOM_VERTEX_DEFINITIONS: `#ifdef SRO_WATER_FLOW\nattribute vec4 ${WATER_FLOW_ATTRIBUTE};\nvarying vec4 vSroFlow;\n#endif\n`,
        CUSTOM_VERTEX_MAIN_END: `#ifdef SRO_WATER_FLOW\nvSroFlow = ${WATER_FLOW_ATTRIBUTE};\n#endif\n`,
      }
}

/** The fragment injection points per language (the same keys in both; test/water-pbr.test.ts). */
export function waterFragmentCode(lang: 'wgsl' | 'glsl'): Readonly<Record<string, string>> {
  return lang === 'wgsl' ? WGSL : GLSL
}

const UBO = ['sroWaterA', 'sroWaterB', 'sroWaterC', 'sroWaterD', 'sroWaterS', 'sroWaterSC'] as const
export const WATER_PLUGIN_SAMPLERS = ['sroWaterFrames', 'sroWaterNormal', 'sroWaterRipple', 'sroWaterSky'] as const
/** The flow vertex attribute (water.ts `riverFlow`): flow x, flow z (m/s), rapids 0..1, flow strength 0..1. */
export const WATER_FLOW_ATTRIBUTE = 'sroFlow'

// ---- state and plugin -----------------------------------------------------------------------------------------------

/**
 * What the water material binds (water.ts writes it each frame; the ocean writes d, s, sc and the sky cube):
 *   a  frame index, animation time (s), rain 0..1 (ripple strength), ripple time (the weather clock, s)
 *   b  water colour rgb (display, noon level), roughness
 *   c  deep multiplier rgb, wave amplitude scale
 *   d  AAA water: the sky cube's top level, its lowest level, SSR on the water (1/0), the glitter's strength
 *   s  the key light's direction (to the light)
 *   sc the key light's radiance (rgb, scene-linear)
 */
export class WaterPbrState {
  readonly a = new Vector4(0, 0, 0, 0)
  readonly b = new Vector4(0.25, 0.69, 0.62, WATER_ROUGHNESS[0])
  readonly c = new Vector4(WATER_DEEP[0], WATER_DEEP[1], WATER_DEEP[2], 1)
  readonly d = new Vector4(7, 0.5, 0, 1)
  readonly s = new Vector4(0, 1, 0, 0)
  readonly sc = new Vector4(0, 0, 0, 0)
  frames: BaseTexture | null = null
  normal: BaseTexture | null = null
  ripple: BaseTexture | null = null
  /** AAA water: the sky reflection cube (ocean/sky-reflection.ts; null: Babylon's environment radiance). */
  sky: BaseTexture | null = null
  /** AAA water: the flow layer on meshes that carry the flow attribute, and the glitter (Medium+). */
  flow = false
  glint = false
  /** Depth shore (High+): the per-vertex depth alpha and the foam band. */
  shore = false
  readonly plugins = new Set<SroWaterPlugin>()

  /** Switches that change defines (a preset or weather-level change; never per frame). */
  setSwitches(shore: boolean, ripple: BaseTexture | null): void {
    const changed = shore !== this.shore || (ripple !== null) !== (this.ripple !== null)
    this.shore = shore
    this.ripple = ripple
    if (changed) for (const p of this.plugins) p.markAllDefinesAsDirty()
  }

  /** AAA water's switches (the sky cube appeared or went, the preset's flow and glitter). */
  setLook(o: { sky?: BaseTexture | null; flow?: boolean; glint?: boolean }): void {
    let changed = false
    if (o.sky !== undefined) {
      changed ||= (o.sky !== null) !== (this.sky !== null)
      this.sky = o.sky
    }
    if (o.flow !== undefined && o.flow !== this.flow) {
      this.flow = o.flow
      changed = true
    }
    if (o.glint !== undefined && o.glint !== this.glint) {
      this.glint = o.glint
      changed = true
    }
    if (changed) for (const p of this.plugins) p.markAllDefinesAsDirty()
  }
}

export class SroWaterPlugin extends MaterialPluginBase {
  constructor(material: Material, readonly state: WaterPbrState) {
    super(material, SRO_WATER_PLUGIN, 240, { SRO_WATER: false, SRO_WATER_SHORE: false, SRO_WATER_RIPPLE: false, SRO_WATER_SKY: false, SRO_WATER_FLOW: false, SRO_WATER_GLINT: false }, true, true)
    state.plugins.add(this)
  }

  override getClassName(): string {
    return 'SroWaterPlugin'
  }

  override isCompatible(_language: ShaderLanguage): boolean {
    return true
  }

  override prepareDefines(defines: MaterialDefines, _scene?: Scene, mesh?: AbstractMesh): void {
    const s = this.state
    const on = s.frames !== null && s.normal !== null
    defines['SRO_WATER'] = on
    defines['SRO_WATER_SHORE'] = on && s.shore
    defines['SRO_WATER_RIPPLE'] = on && s.ripple !== null
    defines['SRO_WATER_SKY'] = on && s.sky !== null
    defines['SRO_WATER_FLOW'] = on && s.flow && !!mesh?.isVerticesDataPresent(WATER_FLOW_ATTRIBUTE)
    defines['SRO_WATER_GLINT'] = on && s.glint
  }

  override getAttributes(attributes: string[], _scene: Scene, mesh: AbstractMesh): void {
    const s = this.state
    if (s.flow && s.frames && s.normal && mesh.isVerticesDataPresent(WATER_FLOW_ATTRIBUTE) && !attributes.includes(WATER_FLOW_ATTRIBUTE)) attributes.push(WATER_FLOW_ATTRIBUTE)
  }

  override getUniforms(language: ShaderLanguage = ShaderLanguage.GLSL) {
    const ubo = UBO.map(name => ({ name, size: 4, type: 'vec4' }))
    if (language === ShaderLanguage.WGSL) return { ubo }
    return { ubo, fragment: `#ifdef SRO_WATER\n${UBO.map(n => `uniform vec4 ${n};`).join('\n')}\n#endif` }
  }

  override getSamplers(samplers: string[]): void {
    samplers.push(...WATER_PLUGIN_SAMPLERS)
  }

  override bindForSubMesh(ubo: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    const s = this.state
    if (!s.frames || !s.normal) return
    ubo.updateVector4('sroWaterA', s.a)
    ubo.updateVector4('sroWaterB', s.b)
    ubo.updateVector4('sroWaterC', s.c)
    ubo.updateVector4('sroWaterD', s.d)
    ubo.updateVector4('sroWaterS', s.s)
    ubo.updateVector4('sroWaterSC', s.sc)
    ubo.setTexture('sroWaterFrames', s.frames)
    ubo.setTexture('sroWaterNormal', s.normal)
    if (s.ripple) ubo.setTexture('sroWaterRipple', s.ripple)
    if (s.sky) ubo.setTexture('sroWaterSky', s.sky)
  }

  override getCustomCode(shaderType: string, language: ShaderLanguage = ShaderLanguage.GLSL): Record<string, string> | null {
    const lang = language === ShaderLanguage.WGSL ? 'wgsl' : 'glsl'
    if (shaderType === 'vertex') return waterVertexCode(lang)
    if (shaderType !== 'fragment') return null
    return { ...waterFragmentCode(lang) }
  }

  override dispose(forceDisposeTextures?: boolean): void {
    this.state.plugins.delete(this)
    super.dispose(forceDisposeTextures)
  }
}

/** The water normal map texture (tiling, mipmapped). */
export function createWaterNormalTexture(scene: Scene, size = 128): RawTexture {
  const tex = new RawTexture(waterNormalPixels(size), size, size, Constants.TEXTUREFORMAT_RGBA, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE)
  tex.name = 'sroWaterNormal'
  tex.wrapU = Texture.WRAP_ADDRESSMODE
  tex.wrapV = Texture.WRAP_ADDRESSMODE
  return tex
}

/** The PBR water material with its plugin (water.ts; one per world). */
export function createPbrWater(scene: Scene, state: WaterPbrState): { material: PBRMaterial; plugin: SroWaterPlugin } {
  const m = useWindowedLightFalloff(new PBRMaterial('waterPbr', scene))
  m.metallic = 0
  m.roughness = WATER_ROUGHNESS[0]
  m.albedoColor = Color3.White()
  m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND
  m.disableDepthWrite = true
  m.backFaceCulling = false
  m.useRadianceOverAlpha = true
  m.useSpecularOverAlpha = true
  const plugin = new SroWaterPlugin(m, state)
  return { material: m, plugin }
}

/** The PBR ice (RENDER §7: roughness 0.2, stone-like, no plugin). */
export function createPbrIce(scene: Scene, texture: BaseTexture | null): PBRMaterial {
  const m = useWindowedLightFalloff(new PBRMaterial('icePbr', scene))
  m.metallic = 0
  m.roughness = 0.2
  if (texture) m.albedoTexture = texture
  return m
}
