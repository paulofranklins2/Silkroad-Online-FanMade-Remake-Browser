// Overall Pass (AAA water): the river flow, the sky cube's lookup, the sea floor's tint.
import { describe, expect, it } from 'vitest'
import { GRID } from '../../convert/src/world/format.ts'
import type { TerrainBlock } from '../../convert/src/world/manifest.ts'
import { riverFlow, RIVER_HALF_WIDTH_M } from '../src/water.ts'
import { FLOW_SPEED_MS, waterFragmentCode } from '../src/pbr/water-plugin.ts'
import { CUBE_LOOKUP, cubeLookupCode, dirToCube } from '../src/ocean/sky-reflection.ts'
import { oceanCode, waterColour } from '../src/ocean/ocean-plugin.ts'

function blocks(heightM: number): TerrainBlock[] {
  const out: TerrainBlock[] = []
  for (let bz = 0; bz < 6; bz++) for (let bx = 0; bx < 6; bx++) out.push({ bx, bz, flag: 0, environmentId: 0, water: { kind: 'water', type: 0, wave: 0, heightM } } as unknown as TerrainBlock)
  return out
}

describe('riverFlow', () => {
  it('a narrow channel flows along its banks at the river speed; the banks and the dry ground do not', () => {
    const h = new Float32Array(GRID * GRID).fill(2)
    // a 10 m wide channel along grid x (glTF x), rows 44..48, 1 m deep
    for (let z = 44; z <= 48; z++) for (let x = 0; x < GRID; x++) h[z * GRID + x] = -1
    const f = riverFlow(blocks(0), h, [0, 0, 0], 5)
    expect(f).not.toBeNull()
    const k = (46 * GRID + 48) * 4
    const fx = f![k]!, fz = f![k + 1]!
    expect(Math.hypot(fx, fz)).toBeCloseTo(FLOW_SPEED_MS, 1)
    expect(Math.abs(fx)).toBeGreaterThan(5 * Math.abs(fz))
    // away from the island's middle (100, −100): the channel at z ≈ −92 runs toward −x from x = 96
    expect(f![(46 * GRID + 20) * 4]!).toBeLessThan(0)
    // dry ground: nothing
    expect(f![(10 * GRID + 48) * 4 + 3]).toBe(0)
  })

  it('a lake (wider than the river half-width) and the sea-level bays stay still', () => {
    const lake = new Float32Array(GRID * GRID).fill(-3)
    expect(riverFlow(blocks(0), lake, [0, 0, 0], null)).toBeNull()
    expect(RIVER_HALF_WIDTH_M[1]).toBeGreaterThan(RIVER_HALF_WIDTH_M[0])
    const h = new Float32Array(GRID * GRID).fill(2)
    for (let z = 44; z <= 48; z++) for (let x = 0; x < GRID; x++) h[z * GRID + x] = -1
    // the same channel at the sea level joins the ocean: still
    expect(riverFlow(blocks(5), h, [0, 0, 0], 5)).toBeNull()
  })
})

describe('the sky cube lookup', () => {
  it('is its own inverse and the shaders use the same signs', () => {
    expect(dirToCube(...dirToCube(0.3, 0.5, -0.8))).toEqual([0.3, 0.5, -0.8].map(v => v + 0))
    const code = cubeLookupCode('wgsl', 'r')
    expect(code).toBe(`vec3f(${CUBE_LOOKUP[0] < 0 ? '-' : ''}r.x, ${CUBE_LOOKUP[1] < 0 ? '-' : ''}max(r.y, 0.0), ${CUBE_LOOKUP[2] < 0 ? '-' : ''}r.z)`)
    expect(oceanCode('fragment', 'wgsl').CUSTOM_FRAGMENT_MAIN_BEGIN).toContain(code.replace(/\br\./g, 'sroRv.').replace('max(r.y', 'max(sroRv.y'))
    expect(waterFragmentCode('glsl').CUSTOM_FRAGMENT_MAIN_BEGIN).toContain(cubeLookupCode('glsl', 'sroWR'))
  })
})

describe('the sea floor through the water', () => {
  it('shallow water over sand reads turquoise (green and blue over red), deep water blue-green', () => {
    const s = waterColour(1.5).albedo
    expect(s[1]).toBeGreaterThan(s[0])
    expect(s[2]).toBeGreaterThan(s[0])
    const d = waterColour(50)
    expect(d.alpha).toBeGreaterThan(0.99)
    expect(d.albedo[2]).toBeGreaterThan(d.albedo[0])
  })
})
