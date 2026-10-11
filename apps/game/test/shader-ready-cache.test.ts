/**
 * The ShaderMaterial readiness cache (three/shader-ready-cache.ts, docs/PERF_OVERALL.md round 5): a repeated check with
 * nothing changed is answered without Babylon's define string; a define change, another mesh state or fog goes back
 * to Babylon (and gets the right effect).
 */
import { MeshBuilder, NullEngine, Scene, ShaderMaterial } from '@babylonjs/core'
import { describe, expect, it } from 'vitest'
import { SHADER_READY_STATS, installShaderReadyCache } from '../src/three/shader-ready-cache.ts'

describe('ShaderMaterial readiness cache', () => {
  it('answers an unchanged check from the signature and follows define, fog and mesh changes', () => {
    installShaderReadyCache()
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const mat = new ShaderMaterial('m', scene, { vertexSource: 'void main(){}', fragmentSource: 'void main(){}' }, { attributes: ['position'], uniforms: ['worldViewProjection'], defines: ['A'] })
    const a = MeshBuilder.CreateBox('a', {}, scene)
    const b = MeshBuilder.CreateBox('b', {}, scene)
    a.material = mat
    b.material = mat
    expect(mat.isReady(a, false)).toBe(true)
    const h0 = SHADER_READY_STATS.hits
    expect(mat.isReady(a, false)).toBe(true)
    expect(SHADER_READY_STATS.hits).toBe(h0 + 1)
    // a define change: Babylon again, a new effect
    mat.options.defines.push('B')
    const m0 = SHADER_READY_STATS.misses
    expect(mat.isReady(a, false)).toBe(true)
    expect(SHADER_READY_STATS.misses).toBe(m0 + 1)
    expect((mat as unknown as { _drawWrapper: { defines: string } })._drawWrapper.defines).toContain('B')
    // fog on: Babylon again
    scene.fogMode = Scene.FOGMODE_LINEAR
    const m1 = SHADER_READY_STATS.misses
    mat.isReady(a, false)
    expect(SHADER_READY_STATS.misses).toBe(m1 + 1)
    // the other mesh has its own signature; instances are another state
    const m2 = SHADER_READY_STATS.misses
    mat.isReady(b, false)
    mat.isReady(a, true)
    expect(SHADER_READY_STATS.misses).toBe(m2 + 2)
    scene.dispose()
    engine.dispose()
  })
})
