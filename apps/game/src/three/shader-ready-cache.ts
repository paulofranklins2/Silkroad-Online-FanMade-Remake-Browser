/**
 * ShaderMaterial readiness without the per-draw garbage (Overall Pass round 5, docs/PERF_OVERALL.md). Babylon 9.28's
 * `ShaderMaterial.isReady` rebuilds its define list and joins it into one string on every call, for every draw of every
 * ShaderMaterial (grass, sky, ocean, terrain, water, the town's crowd), every frame: ≈ 7 % of the route's garbage, only
 * to find the string unchanged. This wrapper remembers, per draw wrapper, everything that call reads from the mesh, the
 * scene and the material (a signature of plain values and object identities, compared without allocating) and answers
 * `true` at once while the signature is unchanged, the effect is ready and the last answer was `true`. Anything it
 * cannot follow cheaply (morph targets, vertex pulling, a custom shader name resolver, multiview) goes to Babylon.
 *
 * Installed once (engine.ts), switched by PERF.shaderReadyCache.
 */
import { ShaderMaterial, VertexBuffer, type AbstractMesh, type Scene } from '@babylonjs/core'
import { PERF } from '../world/perf.ts'

interface Sig {
  /** The effect the wrapper had when this signature was answered true (a shared wrapper's other mesh may change it). */
  effect: unknown
  mesh: AbstractMesh | undefined
  inst: boolean
  thin: boolean
  color: boolean
  skel: unknown
  nbi: number
  boneTex: boolean
  bones: number
  vat: boolean
  alpha: boolean
  fog: boolean
  logd: boolean
  cp: unknown[]
  defs: string[]
  attrs: number
}

interface DrawWrapperLike {
  effect?: { isReady(): boolean } | null
  _wasPreviouslyReady?: boolean
  _wasPreviouslyUsingInstances?: boolean | null
  /** Signatures per mesh (a material's own draw wrapper is shared by its meshes). */
  _sroSigs?: WeakMap<object, Sig>
}

interface ShaderMaterialInternals {
  isFrozen: boolean
  _storeEffectOnSubMeshes: boolean
  _drawWrapper: DrawWrapperLike
  _options: { defines: string[]; attributes: string[] }
  _useLogarithmicDepth: boolean
  _textures: Record<string, { isReady(): boolean }>
  _internalTextures: Record<string, { isReady: boolean }>
  customShaderNameResolve?: unknown
  useVertexPulling?: boolean
  needAlphaTestingForMesh(mesh: AbstractMesh): boolean
  getScene(): Scene
}

/** Calls of the cache (hits answered without Babylon, misses through it), for the bench. */
export const SHADER_READY_STATS = { hits: 0, misses: 0 }

const CLIP = ['clipPlane', 'clipPlane2', 'clipPlane3', 'clipPlane4', 'clipPlane5', 'clipPlane6'] as const

function fill(sig: Sig, m: ShaderMaterialInternals, scene: Scene, mesh: AbstractMesh | undefined, useInstances: boolean): void {
  sig.mesh = mesh
  sig.inst = useInstances
  sig.thin = !!mesh?.hasThinInstances
  sig.color = !!mesh?.isVerticesDataPresent(VertexBuffer.ColorKind)
  const skel = mesh && mesh.useBones && mesh.computeBonesUsingShaders ? mesh.skeleton : null
  sig.skel = skel
  sig.nbi = skel ? mesh!.numBoneInfluencers : 0
  sig.boneTex = !!skel?.isUsingTextureForMatrices
  sig.bones = skel ? skel.bones.length : 0
  sig.vat = !!mesh?.bakedVertexAnimationManager?.isEnabled
  sig.alpha = !!mesh && m.needAlphaTestingForMesh(mesh)
  sig.fog = !!(scene.fogEnabled && mesh?.applyFog && scene.fogMode !== 0)
  sig.logd = m._useLogarithmicDepth
  const s = scene as unknown as Record<string, unknown>
  for (let i = 0; i < CLIP.length; i++) sig.cp[i] = s[CLIP[i]!] ?? null
  const d = m._options.defines
  sig.defs.length = d.length
  for (let i = 0; i < d.length; i++) sig.defs[i] = d[i]!
  sig.attrs = m._options.attributes.length
}

function same(sig: Sig, m: ShaderMaterialInternals, scene: Scene, mesh: AbstractMesh | undefined, useInstances: boolean): boolean {
  if (sig.mesh !== mesh || sig.inst !== useInstances || sig.thin !== !!mesh?.hasThinInstances) return false
  if (sig.color !== !!mesh?.isVerticesDataPresent(VertexBuffer.ColorKind)) return false
  const skel = mesh && mesh.useBones && mesh.computeBonesUsingShaders ? mesh.skeleton : null
  if (sig.skel !== skel) return false
  if (skel && (sig.nbi !== mesh!.numBoneInfluencers || sig.boneTex !== skel.isUsingTextureForMatrices || sig.bones !== skel.bones.length)) return false
  if (sig.vat !== !!mesh?.bakedVertexAnimationManager?.isEnabled) return false
  if (sig.alpha !== (!!mesh && m.needAlphaTestingForMesh(mesh))) return false
  if (sig.fog !== !!(scene.fogEnabled && mesh?.applyFog && scene.fogMode !== 0)) return false
  if (sig.logd !== m._useLogarithmicDepth) return false
  const s = scene as unknown as Record<string, unknown>
  for (let i = 0; i < CLIP.length; i++) if (sig.cp[i] !== (s[CLIP[i]!] ?? null)) return false
  const d = m._options.defines
  if (sig.defs.length !== d.length || sig.attrs !== m._options.attributes.length) return false
  for (let i = 0; i < d.length; i++) if (sig.defs[i] !== d[i]) return false
  return true
}

let installed = false

/** Wraps ShaderMaterial.isReady (once; see the header). */
export function installShaderReadyCache(): void {
  if (installed) return
  installed = true
  const proto = ShaderMaterial.prototype as unknown as { isReady(mesh?: AbstractMesh, useInstances?: boolean, subMesh?: { _getDrawWrapper(p?: unknown, c?: boolean): DrawWrapperLike }): boolean }
  const orig = proto.isReady
  proto.isReady = function (this: ShaderMaterialInternals, mesh?: AbstractMesh, useInstances?: boolean, subMesh?: { _getDrawWrapper(p?: unknown, c?: boolean): DrawWrapperLike }) {
    if (!PERF.shaderReadyCache || this.isFrozen || this.customShaderNameResolve || this.useVertexPulling || mesh?.morphTargetManager) return orig.call(this, mesh, useInstances, subMesh as never)
    const scene = this.getScene()
    if (scene.getEngine().getCaps().multiview && scene.activeCamera?.outputRenderTarget) return orig.call(this, mesh, useInstances, subMesh as never)
    const dw = subMesh && this._storeEffectOnSubMeshes ? subMesh._getDrawWrapper(undefined, true) : this._drawWrapper
    const inst = !!useInstances
    const key: object = mesh ?? this
    const sig = dw?._sroSigs?.get(key)
    if (sig && dw.effect && sig.effect === dw.effect && dw._wasPreviouslyReady && dw._wasPreviouslyUsingInstances === inst && same(sig, this, scene, mesh, inst)) {
      let texturesReady = true
      for (const k in this._textures) if (!this._textures[k]!.isReady()) {
        texturesReady = false
        break
      }
      if (texturesReady) for (const k in this._internalTextures) if (!this._internalTextures[k]!.isReady) {
        texturesReady = false
        break
      }
      if (texturesReady && dw.effect.isReady()) {
        SHADER_READY_STATS.hits++
        return true
      }
    }
    SHADER_READY_STATS.misses++
    const ok = orig.call(this, mesh, useInstances, subMesh as never)
    if (ok && dw) {
      const sigs = (dw._sroSigs ??= new WeakMap())
      let s = sigs.get(key)
      if (!s) sigs.set(key, (s = { effect: null, mesh: undefined, inst: false, thin: false, color: false, skel: null, nbi: 0, boneTex: false, bones: 0, vat: false, alpha: false, fog: false, logd: false, cp: [], defs: [], attrs: 0 }))
      fill(s, this, scene, mesh, inst)
      s.effect = dw.effect
    } else dw?._sroSigs?.delete(key)
    return ok
  }
}
