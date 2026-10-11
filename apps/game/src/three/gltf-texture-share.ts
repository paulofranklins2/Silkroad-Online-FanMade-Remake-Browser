/**
 * Shared, sized textures for the licensed character glbs (Overall Pass round 7, docs/PERF_OVERALL.md memory pass).
 * Each licensed body / outfit variant (`char/licensed/<name>/<name>_<sex>_<nn>.glb`, base, parts) embeds its own copy of
 * the same 2048² body, face and hair images, and Babylon keys an embedded image by its file, so 8 players in 4 outfits
 * held 73 uncompressed 2048² textures: 1.56 GB of GPU memory (system RAM on an integrated GPU).
 *
 * This glTF loader extension (for those glbs only) keys each texture by its image bytes (length + a sampled hash) and
 * hands out the texture already made for those bytes; a new one is made at half size when the preset draws characters
 * at Medium or below (`TEXTURE_SHARE.maxSize`, set by main.ts from the preset: 2048² → 1024², a quarter of the
 * memory). Shared textures belong to no asset container: they live for the session (the glbs are cached for the session
 * too). `PERF.licensedTextureShare` switches it (the bench's A/B).
 */
import { Texture, type BaseTexture, type Scene } from '@babylonjs/core'
import { registerGLTFExtension } from '@babylonjs/loaders/glTF/2.0/glTFLoaderExtensionRegistry.js'
import type { GLTFLoader } from '@babylonjs/loaders/glTF/2.0/glTFLoader.js'
import { PERF } from '../world/perf.ts'

/** The glbs this applies to. */
export const LICENSED_GLB = /\/char\/licensed\//

/** The largest side a licensed texture is made with (Infinity: as stored). Set from the graphics preset (models.ts). */
export const TEXTURE_SHARE = { maxSize: Infinity as number, enabled: true, made: 0, shared: 0, savedMB: 0 }

interface GltfImage { index: number; uri?: string; mimeType?: string; bufferView?: number; name?: string }
interface GltfSampler { index: number }
interface GltfTexture { sampler?: number; source?: number; _textureInfo?: { nonColorData?: boolean } }
interface LoaderInternals {
  gltf: { images?: GltfImage[]; samplers?: GltfSampler[] }
  babylonScene: Scene
  parent: { useSRGBBuffers: boolean }
  _fileName?: string
  _rootUrl?: string
  loadImageAsync(context: string, image: GltfImage): Promise<ArrayBufferView>
  _loadSampler(context: string, sampler: GltfSampler): { noMipMaps: boolean; samplingMode: number; wrapU: number; wrapV: number }
}

const DEFAULT_SAMPLER = { index: -1 } as GltfSampler
const shared = new WeakMap<Scene, Map<string, Promise<BaseTexture>>>()

/** Length + 1 KB of samples spread over the bytes (FNV-1a): equal images have equal keys; a collision needs the same length. */
function keyOf(bytes: ArrayBufferView, srgb: boolean, sampler: string): string {
  const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let h = 0x811c9dc5
  const step = Math.max(1, Math.floor(u8.length / 1024))
  for (let i = 0; i < u8.length; i += step) h = Math.imul(h ^ u8[i]!, 0x01000193)
  h = Math.imul(h ^ u8[u8.length - 1]!, 0x01000193)
  return `${u8.length}:${(h >>> 0).toString(36)}:${srgb ? 's' : 'l'}:${sampler}`
}

async function makeTexture(loader: LoaderInternals, key: string, bytes: ArrayBufferView, image: GltfImage, sampler: GltfSampler, srgb: boolean): Promise<BaseTexture> {
  const scene = loader.babylonScene
  const s = loader._loadSampler(`/samplers/${sampler.index}`, sampler)
  let source: ArrayBufferView | ImageBitmap = bytes
  if (Number.isFinite(TEXTURE_SHARE.maxSize) && typeof createImageBitmap === 'function') {
    try {
      const full = await createImageBitmap(new Blob([bytes as unknown as BlobPart], { type: image.mimeType ?? 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' })
      const side = Math.max(full.width, full.height)
      if (side > TEXTURE_SHARE.maxSize) {
        const k = TEXTURE_SHARE.maxSize / side
        source = await createImageBitmap(full, { resizeWidth: Math.max(1, Math.round(full.width * k)), resizeHeight: Math.max(1, Math.round(full.height * k)), resizeQuality: 'high', premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' })
        TEXTURE_SHARE.savedMB += (full.width * full.height * 4 * 4) / 3 / 1048576 - (source.width * source.height * 4 * 4) / 3 / 1048576
        full.close()
      } else full.close()
    } catch {
      source = bytes // decode failed here: Babylon decodes the bytes itself
    }
  }
  return await new Promise<BaseTexture>((resolve, reject) => {
    const tex = new Texture(null, scene, {
      noMipmap: s.noMipMaps,
      invertY: false,
      samplingMode: s.samplingMode,
      mimeType: image.mimeType,
      useSRGBBuffer: srgb && loader.parent.useSRGBBuffers,
      onLoad: () => {
        // the bytes / bitmap stay only for a context restore, which WebGPU never does here (three/cpu-copies.ts)
        const it = tex.getInternalTexture() as { _buffer?: unknown } | null
        if (it) it._buffer = null
        if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) source.close()
        resolve(tex)
      },
      onError: (message?: string) => reject(new Error(`shared texture ${key}: ${message ?? 'failed'}`)),
    })
    tex.wrapU = s.wrapU
    tex.wrapV = s.wrapV
    tex.name = image.name ?? key
    tex.updateURL(`data:sro-licensed-tex#${key}`, source as never)
    TEXTURE_SHARE.made++
  })
}

let registered = false

/** Registers the extension once (models.ts). */
export function registerTextureShare(): void {
  if (registered) return
  registered = true
  registerGLTFExtension('sro_licensed_texture_share', false, (gltfLoader: GLTFLoader) => {
    const loader = gltfLoader as unknown as LoaderInternals
    return {
      name: 'sro_licensed_texture_share',
      enabled: true,
      dispose() {},
      _loadTextureAsync(context: string, texture: GltfTexture, assign: (t: BaseTexture) => void) {
        const file = `${loader._rootUrl ?? ''}${loader._fileName ?? ''}`
        if (!PERF.licensedTextureShare || !TEXTURE_SHARE.enabled || !LICENSED_GLB.test(file) || texture.source === undefined) return null
        const image = loader.gltf.images?.[texture.source]
        if (!image || image.uri) return null
        const sampler = texture.sampler === undefined ? DEFAULT_SAMPLER : loader.gltf.samplers?.[texture.sampler] ?? DEFAULT_SAMPLER
        const srgb = !texture._textureInfo?.nonColorData
        return loader.loadImageAsync(`/images/${image.index}`, image).then(bytes => {
          const scene = loader.babylonScene
          let map = shared.get(scene)
          if (!map) shared.set(scene, (map = new Map()))
          const key = keyOf(bytes, srgb, `${sampler.index}`)
          let p = map.get(key)
          if (p) TEXTURE_SHARE.shared++
          else {
            p = makeTexture(loader, key, bytes, image, sampler, srgb)
            map.set(key, p)
            p.catch(() => map!.delete(key))
          }
          return p.then(t => {
            assign(t)
            return t
          })
        })
      },
    } as never
  })
}
