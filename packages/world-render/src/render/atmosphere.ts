/**
 * Daytime atmosphere (docs/LIGHTING.md §3, lighting pass 2): how much denser and nearer the height fog is than the
 * retail fog range at each time of day, so the air reads all day: aerial haze on the mid-distance hills by day, a
 * morning mist that pools in hollows and fields (a short height falloff), a golden haze in the evening, a light night
 * haze. The sun shafts take part of the fog's density as their in-scatter (volumetrics/shafts.ts fogShare), so the
 * beams strengthen with it. Pure: RenderPost applies it to the HeightFog every frame (PBR presets only; the Low guard
 * never builds it). Weather fog (mist, rain) still comes from the scene fog range on top.
 */

export interface AtmosphereLook {
  /** × the retail fog density. */
  density: number
  /** × the retail fog start distance (smaller: haze nearer). */
  start: number
  /** The height falloff (m): short in the morning mist, so it pools low. */
  falloffM: number
}

export interface AtmosphereTuning {
  day: AtmosphereLook
  morning: AtmosphereLook
  evening: AtmosphereLook
  night: AtmosphereLook
}

// Item 16: the golden hour read hazy and yellow (evening 1.7 × at 0.4 of the start); the low mist now comes from the
// ground mist layer (mistLevel), so the air above it is clearer and the distance crisp.
export const ATMOSPHERE: Readonly<AtmosphereTuning> = {
  day: { density: 1.15, start: 0.65, falloffM: 80 },
  morning: { density: 1.2, start: 0.55, falloffM: 50 },
  evening: { density: 1.15, start: 0.65, falloffM: 70 },
  night: { density: 1.15, start: 0.8, falloffM: 80 },
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/** The weights of the four looks (sum 1): night below −6°, morning / evening mist with a low sun, day above ~25°. */
export function atmosphereWeights(sunElevationDeg: number, t: number): [number, number, number, number] {
  const night = smoothstep(0, -8, sunElevationDeg)
  const low = (1 - night) * (1 - smoothstep(8, 25, sunElevationDeg))
  const morning = (t - Math.floor(t)) < 0.5
  return [Math.max(0, 1 - night - low), morning ? low : 0, morning ? 0 : low, night]
}

/** The blended look for a sun elevation, a solar time (0 = midnight) and a strength (0 = the retail fog, 1 = full). */
export function atmosphereLook(sunElevationDeg: number, t: number, strength = 1, a: Readonly<AtmosphereTuning> = ATMOSPHERE): AtmosphereLook {
  const [wd, wm, we, wn] = atmosphereWeights(sunElevationDeg, t)
  const mix = (k: keyof AtmosphereLook) => wd * a.day[k] + wm * a.morning[k] + we * a.evening[k] + wn * a.night[k]
  const s = clamp01(strength)
  return {
    density: 1 + (mix('density') - 1) * s,
    start: 1 + (mix('start') - 1) * s,
    falloffM: 80 + (mix('falloffM') - 80) * s,
  }
}

/**
 * Item 16: the ground mist's level (0..1, × pbr/fog-plugin.ts MIST_MAX): a low layer anchored at the ground under the
 * camera that pools in the valleys. Thickest at dawn (sun −4°…12° before noon), lighter at dusk, a thin night haze,
 * none in the clear midday air; after rain the wet ground breathes it out (wetness, once the rain has eased), and in a
 * downpour the rain's own haze takes over (the weather fog).
 */
export const MIST = { dawn: 1, dusk: 0.55, night: 0.25, afterRain: 0.8 } as const

export function mistLevel(sunElevationDeg: number, t: number, w: { rain: number; wetness: number }): number {
  const [, wm, we, wn] = atmosphereWeights(sunElevationDeg, t)
  const low = 1 - smoothstep(6, 16, sunElevationDeg)
  const time = wm * MIST.dawn * Math.max(low, 0.35) + we * MIST.dusk * low + wn * MIST.night
  const after = MIST.afterRain * clamp01(w.wetness) * (1 - 0.85 * clamp01(w.rain)) * (0.5 + 0.5 * low)
  return clamp01(Math.max(time, after))
}

/**
 * Item 16 (the AAA pass): how far the clouds open toward a low sun in rain (0..1): the sun breaking through under a
 * storm deck at golden hour. Only with a raining or heavy sky and a sun between −2° and ~25°; a black storm opens less.
 * The dome thins its clouds and rain shafts in that bearing near the horizon (sky-shaders skyMoonV.w), and the key
 * light keeps most of its strength.
 */
export function sunBreak(sunElRad: number, precipitation: number, cloudCover: number, darkness: number): number {
  const deg = (sunElRad * 180) / Math.PI
  const low = smoothstep(-2, 3, deg) * (1 - smoothstep(14, 26, deg))
  const wet = Math.max(0, Math.min(1, Math.max(precipitation, (cloudCover - 0.6) / 0.4)))
  return 0.85 * low * wet * (1 - 0.35 * Math.max(0, Math.min(1, darkness)))
}
