/**
 * The integrated-GPU notice (gpu-integrated.ts): integrated graphics are told apart from cards by the renderer string;
 * a desktop processor's minimal graphics (a card is likely there) comes once per session until dismissed, other
 * integrated graphics once ever (main.ts stores that), a card never.
 */
import { describe, expect, it } from 'vitest'
import { IGPU_DISMISSED_KEY, IGPU_SHOWN_KEY, igpuNotice } from '../src/gpu-integrated.ts'

const store = (o: Record<string, string> = {}) => ({ getItem: (k: string) => o[k] ?? null })

describe('integrated GPU notice', () => {
  it('shows for integrated graphics, not for cards, not after a dismissal or once this session', () => {
    const apu = 'ANGLE (AMD, AMD Radeon(TM) Graphics (0x000013C0) Direct3D11 vs_5_0 ps_5_0, D3D11)'
    expect(igpuNotice(apu, store(), store())).toEqual({ show: true, likelyDual: true })
    expect(igpuNotice('ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)', store(), store())).toEqual({ show: true, likelyDual: true })
    expect(igpuNotice('ANGLE (AMD, AMD Radeon 780M Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', store(), store())).toEqual({ show: true, likelyDual: false })
    expect(igpuNotice('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', store(), store()).show).toBe(true)
    expect(igpuNotice('ANGLE (AMD, AMD Radeon RX 9060 XT (0x00007590) Direct3D11 vs_5_0 ps_5_0, D3D11)', store(), store()).show).toBe(false)
    expect(igpuNotice('ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)', store(), store()).show).toBe(false)
    expect(igpuNotice('ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', store(), store()).show).toBe(false)
    expect(igpuNotice('', store(), store()).show).toBe(false)
    expect(igpuNotice(apu, store({ [IGPU_DISMISSED_KEY]: '1' }), store()).show).toBe(false)
    expect(igpuNotice(apu, store(), store({ [IGPU_SHOWN_KEY]: '1' })).show).toBe(false)
  })
})
