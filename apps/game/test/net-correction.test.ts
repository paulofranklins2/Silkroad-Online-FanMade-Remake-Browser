// docs/NETWORK_AUDIT.md C1: server corrections glide out (no snap) unless they are teleport-sized.
import { describe, expect, it } from 'vitest'
import { CORRECTION_SNAP_M, CORRECTION_TAU_S, CorrectionOffset } from '../src/net/clock.ts'

describe('CorrectionOffset', () => {
  it('a small correction becomes an offset that decays to zero', () => {
    const c = new CorrectionOffset()
    // drawn at x=10.3, the server stopped the entity at x=10
    c.set(10.3, 5, [10, 0, 5])
    expect(c.x).toBeCloseTo(0.3, 6)
    expect(c.z).toBe(0)
    c.decay(CORRECTION_TAU_S)
    expect(c.x).toBeCloseTo(0.3 / Math.E, 6)
    for (let i = 0; i < 60; i++) c.decay(1 / 60)
    expect(c.x).toBe(0)
  })

  it('a second correction while one glides keeps the drawn position continuous', () => {
    const c = new CorrectionOffset()
    c.set(1, 0, [0, 0, 0]) // drawn at 1 (= logical 0 + offset 1)
    c.set(0, 0, [-0.5, 0, 0]) // logical 0 -> -0.5 while drawn at 1
    expect(0 + 1).toBeCloseTo(-0.5 + c.x, 9)
  })

  it('a teleport-sized gap snaps', () => {
    const c = new CorrectionOffset()
    c.set(0, 0, [CORRECTION_SNAP_M + 1, 0, 0])
    expect([c.x, c.z]).toEqual([0, 0])
  })
})
