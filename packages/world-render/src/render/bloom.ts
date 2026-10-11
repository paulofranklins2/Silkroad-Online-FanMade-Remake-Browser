/**
 * Item 16 (the AAA lighting pass): a mip-chain bloom in the HDR chain (WebGPU), replacing Babylon's single-scale blur,
 * whose half-resolution box kernel turned the bright pillar lamps into blocky blobs.
 *
 *   prefilter ½   13-tap downsample with a Karis average (fireflies weigh less), the soft-knee threshold and a clamp
 *   down ¼ … 1/32 13-tap downsamples (bilinear taps: a smooth, alias-free pyramid)
 *   up 1/16 … ½   3 × 3 tent upsample of the coarser level + this level (the classic "progressive" upsample)
 *   composite 1   scene + weight × tent(½) / levels
 *
 * The threshold is the tone-map input luminance (RenderQuality.bloomThreshold, scene × exposure), so the same lamps glow
 * by day and by night; sunlit white cloth and stone (≤ ~2.7 at noon) stay under it. Ten small passes after the eye
 * adaptation and before the default pipeline (whose own bloom is then off). Lane RND-P.
 */
import { Constants, PostProcess, ShaderLanguage, ShaderStore, Texture, type Camera, type Effect, type Scene } from '@babylonjs/core'

/** Levels below the prefilter (¼ … 1/32). */
export const BLOOM_LEVELS_DOWN = 4
/** The knee as a share of the threshold, and the clamp (× the threshold) that keeps single hot pixels from flashing. */
export const BLOOM_KNEE = 0.5
export const BLOOM_CLAMP = 16

const COMMON = /* wgsl */ `
varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;
fn sroTap(t: texture_2d<f32>, s: sampler, uv: vec2f) -> vec3f { return textureSampleLevel(t, s, uv, 0.0).rgb; }
fn sroLuma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
// Jimenez's 13-tap downsample: four 2 × 2 boxes around the centre, one in the middle (0.5), the corners (0.125 each)
fn sroDown13(t: texture_2d<f32>, s: sampler, uv: vec2f, ts: vec2f, karis: bool) -> vec3f {
  let a = sroTap(t, s, uv + ts * vec2f(-2.0, -2.0)); let b = sroTap(t, s, uv + ts * vec2f(0.0, -2.0)); let c = sroTap(t, s, uv + ts * vec2f(2.0, -2.0));
  let d = sroTap(t, s, uv + ts * vec2f(-2.0, 0.0)); let e = sroTap(t, s, uv); let f = sroTap(t, s, uv + ts * vec2f(2.0, 0.0));
  let g = sroTap(t, s, uv + ts * vec2f(-2.0, 2.0)); let h = sroTap(t, s, uv + ts * vec2f(0.0, 2.0)); let i = sroTap(t, s, uv + ts * vec2f(2.0, 2.0));
  let j = sroTap(t, s, uv + ts * vec2f(-1.0, -1.0)); let k = sroTap(t, s, uv + ts * vec2f(1.0, -1.0));
  let l = sroTap(t, s, uv + ts * vec2f(-1.0, 1.0)); let m = sroTap(t, s, uv + ts * vec2f(1.0, 1.0));
  let g0 = (j + k + l + m) * 0.25; let g1 = (a + b + d + e) * 0.25; let g2 = (b + c + e + f) * 0.25;
  let g3 = (d + e + g + h) * 0.25; let g4 = (e + f + h + i) * 0.25;
  if (karis) {
    let w0 = 0.5 / (1.0 + sroLuma(g0)); let w1 = 0.125 / (1.0 + sroLuma(g1)); let w2 = 0.125 / (1.0 + sroLuma(g2));
    let w3 = 0.125 / (1.0 + sroLuma(g3)); let w4 = 0.125 / (1.0 + sroLuma(g4));
    return (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
  }
  return g0 * 0.5 + (g1 + g2 + g3 + g4) * 0.125;
}
fn sroTent(t: texture_2d<f32>, s: sampler, uv: vec2f, ts: vec2f) -> vec3f {
  var c = sroTap(t, s, uv) * 4.0;
  c += (sroTap(t, s, uv + vec2f(ts.x, 0.0)) + sroTap(t, s, uv - vec2f(ts.x, 0.0)) + sroTap(t, s, uv + vec2f(0.0, ts.y)) + sroTap(t, s, uv - vec2f(0.0, ts.y))) * 2.0;
  c += sroTap(t, s, uv + ts) + sroTap(t, s, uv - ts) + sroTap(t, s, uv + vec2f(ts.x, -ts.y)) + sroTap(t, s, uv + vec2f(-ts.x, ts.y));
  return c / 16.0;
}
`

const PREFILTER = /* wgsl */ `${COMMON}
uniform sroBloomT: vec4f;
#define CUSTOM_FRAGMENT_DEFINITIONS
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let ts = 1.0 / vec2f(textureDimensions(textureSampler, 0));
  var c = sroDown13(textureSampler, textureSamplerSampler, fragmentInputs.vUV, ts, true);
  c = min(c, vec3f(uniforms.sroBloomT.z));
  // soft knee: a quadratic ramp from threshold − knee to threshold + knee, linear above
  let br = max(c.r, max(c.g, c.b));
  let t = uniforms.sroBloomT.x;
  let kn = max(uniforms.sroBloomT.y, 1e-5);
  var rq = clamp(br - t + kn, 0.0, 2.0 * kn);
  rq = rq * rq / (4.0 * kn);
  c = c * (max(rq, br - t) / max(br, 1e-5));
  fragmentOutputs.color = vec4f(max(c, vec3f(0.0)), 1.0);
}
`

const DOWN = /* wgsl */ `${COMMON}
#define CUSTOM_FRAGMENT_DEFINITIONS
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let ts = 1.0 / vec2f(textureDimensions(textureSampler, 0));
  fragmentOutputs.color = vec4f(sroDown13(textureSampler, textureSamplerSampler, fragmentInputs.vUV, ts, false), 1.0);
}
`

const UP = /* wgsl */ `${COMMON}
var sroSkipSampler: sampler;
var sroSkip: texture_2d<f32>;
#define CUSTOM_FRAGMENT_DEFINITIONS
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let ts = 1.0 / vec2f(textureDimensions(textureSampler, 0));
  let c = sroTent(textureSampler, textureSamplerSampler, fragmentInputs.vUV, ts) + sroTap(sroSkip, sroSkipSampler, fragmentInputs.vUV);
  fragmentOutputs.color = vec4f(c, 1.0);
}
`

const COMPOSITE = /* wgsl */ `${COMMON}
var sroSceneSampler: sampler;
var sroScene: texture_2d<f32>;
uniform sroBloomW: vec4f;
#define CUSTOM_FRAGMENT_DEFINITIONS
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let ts = 1.0 / vec2f(textureDimensions(textureSampler, 0));
  let b = sroTent(textureSampler, textureSamplerSampler, fragmentInputs.vUV, ts);
  let s = textureSampleLevel(sroScene, sroSceneSampler, fragmentInputs.vUV, 0.0);
  fragmentOutputs.color = vec4f(s.rgb + b * uniforms.sroBloomW.x, s.a);
}
`

const SHADERS = { sroBloomPrefilter: PREFILTER, sroBloomDown: DOWN, sroBloomUp: UP, sroBloomComposite: COMPOSITE } as const

function register(): void {
  for (const [name, src] of Object.entries(SHADERS)) {
    const key = `${name}FragmentShader`
    if (ShaderStore.ShadersStoreWGSL[key] !== src) ShaderStore.ShadersStoreWGSL[key] = src
  }
}

/** Scene-linear numbers the prefilter needs for a tone-map-input threshold at this exposure. */
export function bloomPrefilter(threshold: number, exposure: number): [number, number, number] {
  const t = threshold / Math.max(1e-4, exposure)
  return [t, t * BLOOM_KNEE, t * BLOOM_CLAMP]
}

export class MipBloom {
  readonly postProcesses: PostProcess[] = []
  threshold = 4
  weight = 0.1
  exposure = 1

  constructor(scene: Scene, camera: Camera, o: { threshold: number; weight: number; samples?: number }) {
    register()
    const engine = scene.getEngine()
    this.threshold = o.threshold
    this.weight = o.weight
    const mk = (name: keyof typeof SHADERS, size: number, uniforms: string[], samplers: string[]) => {
      const pp = new PostProcess(name, name, {
        uniforms,
        samplers,
        size,
        camera,
        engine,
        samplingMode: Texture.BILINEAR_SAMPLINGMODE,
        textureType: Constants.TEXTURETYPE_HALF_FLOAT,
        shaderLanguage: ShaderLanguage.WGSL,
      })
      this.postProcesses.push(pp)
      return pp
    }
    // A Babylon post-process's size is the size of its INPUT (the target the pass before it, or the scene, draws
    // into), not of its output: each pass is sized like the level it reads. The prefilter reads the scene at full size
    // (at 0.5 the whole HDR image was drawn at half resolution and the composite showed that copy upscaled: the soft,
    // pixelated picture on Medium/High/Ultra since the AAA pass, worst on wide screens).
    const pre = mk('sroBloomPrefilter', 1, ['sroBloomT'], [])
    pre.samples = Math.max(1, o.samples ?? 1)
    pre.onApplyObservable.add((e: Effect) => {
      const [t, k, c] = bloomPrefilter(this.threshold, this.exposure)
      e.setFloat4('sroBloomT', t, k, c, 0)
    })
    const downs: PostProcess[] = [pre]
    // down i reads level i − 1 (½ / 2^(i − 1)) and writes level i (¼ … 1/32)
    for (let i = 1; i <= BLOOM_LEVELS_DOWN; i++) downs.push(mk('sroBloomDown', 0.5 / 2 ** (i - 1), [], []))
    for (let i = BLOOM_LEVELS_DOWN - 1; i >= 0; i--) {
      // up i reads level i + 1 and writes level i, plus the level-i copy (the output of the pass that wrote it)
      const skip = downs[i]!
      const up = mk('sroBloomUp', 0.5 / 2 ** (i + 1), [], ['sroSkip'])
      up.onApplyObservable.add((e: Effect) => e.setTextureFromPostProcessOutput('sroSkip', skip))
    }
    // the composite reads the ½ level and writes full size; the scene is the prefilter's (full-size) input
    const comp = mk('sroBloomComposite', 0.5, ['sroBloomW'], ['sroScene'])
    comp.onApplyObservable.add((e: Effect) => {
      e.setTextureFromPostProcess('sroScene', pre)
      // the progressive upsample sums the levels: ÷ their count keeps the weight comparable to Babylon's
      e.setFloat4('sroBloomW', this.weight / (BLOOM_LEVELS_DOWN + 1), 0, 0, 0)
    })
    this.camera = camera
  }

  private readonly camera: Camera

  isReady(): boolean {
    return this.postProcesses.every(p => p.isReady())
  }

  dispose(): void {
    for (const p of this.postProcesses.splice(0)) p.dispose(this.camera)
  }
}
