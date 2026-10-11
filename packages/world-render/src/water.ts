import {
  Color3,
  Constants,
  Material,
  Mesh,
  PBRMaterial,
  ShaderLanguage,
  ShaderMaterial,
  ShaderStore,
  StandardMaterial,
  Texture,
  Vector4,
  VertexBuffer,
  VertexData,
  type BaseTexture,
  type Scene,
} from '@babylonjs/core'
import { GRID } from '../../convert/src/world/format.ts'
import type { TerrainBlock } from '../../convert/src/world/manifest.ts'
import { mapLimit, type Assets } from './assets.ts'
import { WORLD_GROUND_LAYER } from './layers.ts'
import { DefineSet, SharedUniforms, bindAllShared, bindShared } from './shader-chunks.ts'
import { WATER_CHUNK_SAMPLERS, WATER_SAMPLERS, WATER_UNIFORMS, waterFragmentGLSL, waterFragmentWGSL, waterVertexGLSL, waterVertexWGSL } from './shaders.ts'
import { createTextureArray, solidTexture } from './textures.ts'
import type { RegionData, WorldRegions } from './regions.ts'
import {
  FLOW_SPEED_MS,
  WATER_FLOW_ATTRIBUTE,
  WATER_ROUGHNESS,
  WaterPbrState,
  createPbrIce,
  createPbrWater,
  createWaterNormalTexture,
  encodeWaterDepth,
  waterHue,
  waveAmplitude,
} from './pbr/water-plugin.ts'
import {
  SroWaterTownPlugin,
  WaterTownState,
  type RipplePoint,
  type WaterProfile,
  type WaterProfileId,
} from './pbr/water-town-plugin.ts'
import type { RenderPath, RenderQuality } from './render/quality.ts'
import type { RenderWeather } from './render/weather.ts'

const FRAME_SIZE = 64

export interface WaterParams {
  color: [number, number, number]
  fog: boolean
  fogStartM: number
  fogEndM: number
  fogColor: [number, number, number]
}

/**
 * What the PBR water follows (World wires its WorldRender and WorldWeather through `follow`; tests pass plain objects):
 * the material path and preset (`quality.water`, `waterDepthShore`), this frame's rain, and the weather's ripple
 * texture and clock (D21).
 */
export interface WaterRenderSource {
  readonly render: { readonly mode: RenderPath; readonly quality: Readonly<RenderQuality>; readonly weather: Readonly<RenderWeather> }
  readonly weather?: { readonly rippleTexture: BaseTexture | null; readonly u: { readonly wxA: { readonly w: number } } } | null
}

/**
 * Water per block (docs/TERRAIN.md 4): a flat 17 x 17 grid at the block's water height, per-vertex alpha
 * clamp(trunc((waterHeight - terrainHeight) * 0.5), 0, 15) / 15 in file units (full at 3 m depth), blocks whose alpha
 * is 0 everywhere skipped, 4 texture repeats per block, 30 animated frames. Ice: one opaque quad per block.
 * One mesh per region (all its wet blocks). The whole-world load builds every region (build); region streaming
 * calls init once, then addRegion / removeRegion.
 *
 * Wave 9 (RND-W, docs/WAVE_PLAN3.md §6.14): with a render source on the PBR path whose preset asks for PBR water
 * (`follow`, wired by World) a region's water is built on the PBR branch instead: the same grid with an up normal and
 * the depth and wave type in its vertex colour, drawn with one PBRMaterial + SroWaterPlugin (pbr/water-plugin.ts);
 * ice becomes a PBRMaterial. The Classic branch (ShaderMaterial, WX-R's chunk) is unchanged.
 *
 * Wave 11 (W11-S, docs/WAVE_PLAN7.md D5; TOWN_LIFE §5.3, §7.5), PBR branch only: `setRipplePoints` (TL-M's "local
 * rain": the fountain's fall, the fish, the ducks) and the per-region profile (`setProfileLookup` names a region's
 * profile, `setProfile` gives the 'town' profile's numbers: TL-B's pond data). Neither set: the material, its plugins and
 * the vertex colours are today's; the first one adds SroWaterTownPlugin (pbr/water-town-plugin.ts) to the material.
 */
export class WaterRenderer {
  readonly meshes: Mesh[] = []
  material: ShaderMaterial | null = null
  blocks = 0
  skippedBlocks = 0
  private frames: BaseTexture | null = null
  private frameCount = 1
  private frameMs = 100
  private iceMat: StandardMaterial | null = null
  private assets: Assets | null = null
  private visible = true
  private readonly byRegion = new Map<number, Mesh[]>()
  private black: BaseTexture | null = null
  private readonly defines = new DefineSet()
  /** Animation rate (1 = retail); the frame clock stays continuous when it changes. */
  private rate = 1
  private rateOffsetMs = 0
  private lastTimeMs = 0
  /** Values the water material shares with the chunks, bound by reference (shader-chunks.ts). Wave 9 seam. */
  readonly sharedUniforms = new SharedUniforms()
  /** RND-W: the renderer the PBR branch follows (null: Classic only). */
  private source: WaterRenderSource | null = null
  /** RND-W: what the PBR water binds, and its material (built on the first PBR region). */
  readonly pbrState = new WaterPbrState()
  pbrMaterial: PBRMaterial | null = null
  private icePbr: PBRMaterial | null = null
  private iceTexture: Texture | null = null
  /** W11-S: the ripple points and the profile numbers the town plugin binds (pbr/water-town-plugin.ts). */
  readonly townState = new WaterTownState()
  private townPlugin: SroWaterTownPlugin | null = null
  /** W11-S: which profile a region's water takes (null: none). */
  private profileLookup: ((regionId: number) => WaterProfileId | null) | null = null

  constructor(readonly scene: Scene, readonly world: WorldRegions) {
    this.sharedUniforms.bindTo((name, value) => {
      if (this.material) bindShared(this.material, name, value, this.fallbackFor(name))
    })
  }

  /**
   * Speeds the frame animation up or down (WX-R: `1 + 0.8 × wxB.z` in wind; docs/WAVE_PLAN3.md D24). The animation
   * time is re-anchored so the current frame does not jump.
   */
  setAnimationRate(r: number): void {
    const rate = Number.isFinite(r) && r > 0 ? r : 1
    if (rate === this.rate) return
    const anim = this.lastTimeMs * this.rate + this.rateOffsetMs
    this.rate = rate
    this.rateOffsetMs = anim - this.lastTimeMs * rate
  }

  get animationRate(): number {
    return this.rate
  }

  /**
   * RND-W: the renderer and weather the PBR branch follows (World calls it once). Regions built while
   * `render.mode` is 'pbr' and the preset's `water` is 'pbr' take the PBR branch (World.setRenderMode rebuilds the
   * regions of a streamed world).
   */
  follow(source: WaterRenderSource | null): void {
    this.source = source
  }

  /** Whether new regions take the PBR branch. */
  get pbr(): boolean {
    const r = this.source?.render
    return !!r && r.mode === 'pbr' && r.quality.water === 'pbr'
  }

  // ---- wave 11 (W11-S, D5): ripple points and water profiles (the PBR branch) ------------------------------------

  /**
   * TL-M's "local rain" points of this frame (glTF metres; at most RIPPLE_POINTS_MAX are drawn): rings on the PBR water
   * with or without weather. Empty or null: none (with no profile either, the water is today's). The Classic water
   * never shows them (the Low guard).
   */
  setRipplePoints(points: readonly RipplePoint[] | null): void {
    this.townState.setPoints(points)
    this.syncTownPlugin()
  }

  /** The 'town' profile's numbers (TL-B's `pond` data); null: none. Regions take it through setProfileLookup. */
  setProfile(id: WaterProfileId, profile: WaterProfile | null): void {
    if (id !== 'town') return
    this.townState.setProfile(profile)
    this.syncTownPlugin()
  }

  /**
   * Which profile each region's water takes (by region id, (z << 8) | x); null: none. Built PBR regions are coloured
   * again at once (the vertex colour's b: 1 = the profile, 0 = none, as today).
   */
  setProfileLookup(fn: ((regionId: number) => WaterProfileId | null) | null): void {
    this.profileLookup = fn
    for (const [id, list] of this.byRegion) {
      const mesh = list.find(m => m.material === this.pbrMaterial && m.material !== null)
      if (!mesh) continue
      const col = mesh.getVerticesData(VertexBuffer.ColorKind)
      if (!col) continue
      const b = this.profileWeight(id)
      const out = new Float32Array(col.length)
      out.set(col)
      for (let i = 2; i < out.length; i += 4) out[i] = b
      mesh.setVerticesData(VertexBuffer.ColorKind, out, false, 4)
    }
  }

  /** The profile a region's water takes (null: none). */
  profileOf(regionId: number): WaterProfileId | null {
    try {
      return this.profileLookup?.(regionId) ?? null
    } catch (err) {
      console.warn('[world] water profile lookup failed:', err)
      return null
    }
  }

  /** The vertex colour's b of a region: 1 where its profile is 'town', else 0 (today's). */
  private profileWeight(regionId: number): number {
    return this.profileOf(regionId) === 'town' ? 1 : 0
  }

  /** Adds the town plugin to the PBR water material once a point or a profile is wanted (never before: today's). */
  private syncTownPlugin(): void {
    const mat = this.pbrMaterial
    if (!mat || this.townPlugin || !this.townState.wanted) return
    try {
      this.townPlugin = new SroWaterTownPlugin(mat, this.townState)
    } catch (err) {
      console.warn('[world] water town plugin not attached:', err)
    }
  }

  /** Turns a shader define on or off on the water material (chunk `#ifdef`s), now and after init. */
  setDefine(name: string, on: boolean): void {
    if (!this.defines.set(name, on)) return
    this.material?.setDefine(name, on)
  }

  private fallbackFor(name: string): BaseTexture | null {
    if (!WATER_CHUNK_SAMPLERS.includes(name)) return null
    return (this.black ??= solidTexture(this.scene, [0, 0, 0, 255], 'waterChunkBlack'))
  }

  /** Loads the animation frames and creates the shared material (once). */
  async init(assets: Assets): Promise<void> {
    if (this.material) return
    this.assets = assets
    const scene = this.scene
    const w = this.world.manifest.water
    this.frameMs = w.frameMs || 100
    const frames = await mapLimit(w.frames, 8, async f => {
      try {
        return (await assets.image(f, FRAME_SIZE)).data
      } catch (err) {
        console.warn(`[world] water frame ${f}:`, err)
        return new Uint8Array(FRAME_SIZE * FRAME_SIZE * 4).fill(128)
      }
    })
    if (!frames.length) frames.push(new Uint8Array(FRAME_SIZE * FRAME_SIZE * 4).fill(128))
    this.frames = createTextureArray(scene, frames, FRAME_SIZE, 'waterFrames')
    this.frameCount = frames.length

    ShaderStore.ShadersStoreWGSL['sroWaterVertexShader'] = waterVertexWGSL
    ShaderStore.ShadersStoreWGSL['sroWaterFragmentShader'] = waterFragmentWGSL
    ShaderStore.ShadersStore['sroWaterVertexShader'] = waterVertexGLSL
    ShaderStore.ShadersStore['sroWaterFragmentShader'] = waterFragmentGLSL
    const mat = new ShaderMaterial('water', scene, 'sroWater', {
      attributes: ['position', 'uv', 'color'],
      uniforms: [...WATER_UNIFORMS],
      samplers: [...WATER_SAMPLERS],
      needAlphaBlending: true,
      shaderLanguage: scene.getEngine().isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
    })
    mat.setTexture('frames', this.frames)
    for (const name of WATER_CHUNK_SAMPLERS) mat.setTexture(name, this.fallbackFor(name)!)
    bindAllShared(mat, this.sharedUniforms)
    this.defines.apply(mat)
    mat.alphaMode = Constants.ALPHA_COMBINE
    mat.disableDepthWrite = true
    mat.backFaceCulling = false
    this.material = mat
  }

  /** Whole-world load: every loaded region. */
  async build(assets: Assets): Promise<void> {
    await this.init(assets)
    for (const data of this.world.regions) this.addRegion(data)
  }

  /** Builds one region's water and ice meshes (after init; synchronous: one streaming job). Returns them. */
  addRegion(data: RegionData): Mesh[] {
    const classic = this.material
    if (!classic) return []
    const pbr = this.pbr
    const mat = pbr ? this.ensurePbr() : classic
    this.removeRegion(data.region.id)
    const scene = this.scene
    const w = this.world.manifest.water
    const { region } = data
    const out: Mesh[] = []
    const pos: number[] = []
    const uv: number[] = []
    const col: number[] = []
    // W11-S: the region's water profile in the PBR vertex colour's b (0 without one: today's).
    const profile = pbr ? this.profileWeight(region.id) : 0
    const idx: number[] = []
    const icePos: number[] = []
    const iceUv: number[] = []
    const iceIdx: number[] = []
    // AAA water: the river's flow per grid vertex (PBR only; none in a profiled (town) region).
    const flowGrid = pbr && !profile ? riverFlow(region.blocks, data.terrain.heights, region.origin, this.world.manifest.coast?.seaLevelM ?? null) : null
    const flow: number[] = []
    for (const block of region.blocks) {
      const water = block.water
      if (!water) continue
      if (water.kind === 'ice') {
        const base = icePos.length / 3
        for (const [i, j] of [[0, 0], [16, 0], [16, 16], [0, 16]] as const) {
          const gx = block.bx * 16 + i
          const gz = block.bz * 16 + j
          icePos.push(2 * gx, water.heightM, -2 * gz)
          iceUv.push((20 * gx) / 320, (20 * gz) / 320)
        }
        // Counter-clockwise from +Y in glTF space (x east, -z north).
        iceIdx.push(base, base + 1, base + 2, base, base + 2, base + 3)
        this.blocks++
        continue
      }
      const base = pos.length / 3
      let any = false
      for (let j = 0; j <= 16; j++) {
        for (let i = 0; i <= 16; i++) {
          const gx = block.bx * 16 + i
          const gz = block.bz * 16 + j
          const terrainH = data.terrain.heights[gz * GRID + gx]!
          // (waterHeight - terrainHeight) in file units (x10) * 0.5, truncated, 0..15.
          const a = Math.min(15, Math.max(0, Math.trunc((water.heightM - terrainH) * 10 * 0.5))) / 15
          if (a > 0) any = true
          pos.push(2 * gx, water.heightM, -2 * gz)
          uv.push((20 * gx) / 80, (20 * gz) / 80)
          // PBR: the depth and the wave type ride in the colour (pbr/water-plugin.ts); Classic: white.
          if (pbr) col.push(encodeWaterDepth(water.heightM - terrainH), waveAmplitude(water.wave) / 2, profile, a)
          else col.push(1, 1, 1, a)
          if (pbr) {
            const o = (gz * GRID + gx) * 4
            if (flowGrid) flow.push(flowGrid[o]!, flowGrid[o + 1]!, flowGrid[o + 2]!, flowGrid[o + 3]!)
            else flow.push(0, 0, 0, 0)
          }
        }
      }
      if (!any) {
        pos.length = base * 3
        uv.length = base * 2
        col.length = base * 4
        if (pbr) flow.length = base * 4
        this.skippedBlocks++
        continue
      }
      for (let j = 0; j < 16; j++) {
        for (let i = 0; i < 16; i++) {
          const v00 = base + j * 17 + i
          const v10 = v00 + 1
          const v01 = v00 + 17
          const v11 = v01 + 1
          idx.push(v00, v10, v11, v00, v11, v01)
        }
      }
      this.blocks++
    }
    if (idx.length) {
      const vd = new VertexData()
      vd.positions = pos
      vd.uvs = uv
      vd.colors = col
      vd.indices = idx
      if (pbr) vd.normals = upNormals(pos.length / 3)
      const mesh = new Mesh(`water_${region.x}_${region.z}`, scene)
      mesh.layerMask |= WORLD_GROUND_LAYER
      vd.applyToMesh(mesh, false)
      if (pbr) mesh.setVerticesData(WATER_FLOW_ATTRIBUTE, flow, false, 4)
      mesh.position.set(region.origin[0], region.origin[1], region.origin[2])
      mesh.sideOrientation = Material.CounterClockWiseSideOrientation
      mesh.hasVertexAlpha = true
      mesh.applyFog = false // fog is computed in the water shader
      mesh.isPickable = false
      mesh.freezeWorldMatrix()
      mesh.material = mat
      out.push(mesh)
    }
    if (iceIdx.length && w.ice && this.assets) {
      if (!pbr && !this.iceMat) {
        this.iceMat = new StandardMaterial('ice', scene)
        const tex = new Texture(this.assets.url(w.ice), scene, { invertY: false })
        this.iceMat.diffuseTexture = tex
        this.iceMat.specularColor = Color3.Black()
      }
      if (pbr && !this.icePbr) {
        this.iceTexture = new Texture(this.assets.url(w.ice), scene, { invertY: false })
        this.icePbr = createPbrIce(scene, this.iceTexture)
      }
      const vd = new VertexData()
      vd.positions = icePos
      vd.uvs = iceUv
      vd.indices = iceIdx
      VertexData.ComputeNormals(icePos, iceIdx, (vd.normals = []))
      const mesh = new Mesh(`ice_${region.x}_${region.z}`, scene)
      mesh.layerMask |= WORLD_GROUND_LAYER
      vd.applyToMesh(mesh, false)
      mesh.position.set(region.origin[0], region.origin[1], region.origin[2])
      mesh.sideOrientation = Material.CounterClockWiseSideOrientation
      mesh.isPickable = false
      mesh.material = pbr ? this.icePbr : this.iceMat
      out.push(mesh)
    }
    for (const m of out) {
      if (!this.visible) m.setEnabled(false)
      this.meshes.push(m)
    }
    if (out.length) this.byRegion.set(region.id, out)
    return out
  }

  /**
   * W12-SB (WORLD_EDITOR §4.8; WAVE_PLAN8 §4.3): a region's live water edit. `blocks` sets those 32 m blocks' water
   * planes in the region's manifest entry (`water` null: dry; same shape as a retail block's `{ kind, type, wave,
   * heightM }`), then the region's one water mesh (and its ice) is built again from the entry and the current terrain
   * heights. Without `blocks` it only rebuilds (after a height stroke: the depth colour and the per-vertex alpha follow
   * the ground). Returns the region's meshes; null when the region is not loaded. A region nobody edits is untouched.
   */
  updateRegion(id: number, blocks?: ReadonlyArray<{ bx: number; bz: number; water: TerrainBlock['water'] }> | null): Mesh[] | null {
    const data = this.world.get(id)
    if (!data) return null
    for (const b of blocks ?? []) {
      if (!(b.bx >= 0 && b.bx < 6 && b.bz >= 0 && b.bz < 6)) throw new Error(`water block (${b.bx}, ${b.bz}) of region ${id}: outside 0..5`)
      const list = data.region.blocks
      let block: TerrainBlock | undefined = list[b.bz * 6 + b.bx]
      // the manifest lists the 36 blocks as bz * 6 + bx; a short list is searched
      if (!block || block.bx !== b.bx || block.bz !== b.bz) block = list.find(k => k.bx === b.bx && k.bz === b.bz)
      if (!block) throw new Error(`water block (${b.bx}, ${b.bz}) of region ${id}: not in the manifest entry`)
      block.water = b.water ? { ...b.water } : null
    }
    return this.addRegion(data)
  }

  /** Disposes one region's water meshes (the shared materials stay). */
  removeRegion(id: number): void {
    const list = this.byRegion.get(id)
    if (!list) return
    this.byRegion.delete(id)
    for (const m of list) {
      const i = this.meshes.indexOf(m)
      if (i >= 0) this.meshes.splice(i, 1)
      m.dispose(false, false)
    }
  }

  private readonly v = { color: new Vector4(), params: new Vector4(), fog: new Vector4(), fogColor: new Vector4() }

  update(timeMs: number, p: WaterParams): void {
    const m = this.material
    if (!m) return
    this.lastTimeMs = timeMs
    const t = this.rate === 1 && this.rateOffsetMs === 0 ? timeMs : timeMs * this.rate + this.rateOffsetMs
    const frame = Math.floor(Math.max(0, t) / this.frameMs) % this.frameCount
    const v = this.v
    m.setVector4('waterColor', v.color.set(p.color[0], p.color[1], p.color[2], 1))
    m.setVector4('waterParams', v.params.set(frame, p.fog ? 1 : 0, 0, 0))
    m.setVector4('fogParams', v.fog.set(p.fogStartM, p.fogEndM, p.fog ? 1 : 0, 0))
    m.setVector4('fogColor', v.fogColor.set(p.fogColor[0], p.fogColor[1], p.fogColor[2], 1))
    if (this.pbrMaterial) this.updatePbr(frame, t / 1000, p)
  }

  /** The PBR water material (built once, on the first PBR region). */
  private ensurePbr(): PBRMaterial {
    if (this.pbrMaterial) return this.pbrMaterial
    this.pbrMaterial = createPbrWater(this.scene, this.ensurePbrState()).material
    this.syncTownPlugin()
    return this.pbrMaterial
  }

  /**
   * W10-S (COAST F5, WAVE_PLAN6 D12): the PBR water's shared state (the retail frame array, the normal texture), filled
   * now if no PBR water region has done it yet, for the coast's ocean to join the retail water. Makes no material.
   */
  ensurePbrState(): WaterPbrState {
    const s = this.pbrState
    s.frames = this.frames
    s.normal ??= createWaterNormalTexture(this.scene)
    return s
  }

  /**
   * AAA water (the ocean part calls it when its sky cube appears or goes, ocean/sky-reflection.ts): the cube the PBR
   * water mirrors and its top mip level (null: Babylon's environment radiance, as before).
   */
  setSkyReflection(cube: BaseTexture | null, levels: number): void {
    this.pbrState.d.x = levels
    this.pbrState.setLook({ sky: cube })
  }

  /** W10-S (COAST F5): the Classic water's animation frames (Low's ocean joins them): the array, its count, ms each. */
  get classicFrames(): { texture: BaseTexture | null; count: number; frameMs: number } {
    return { texture: this.frames, count: this.frameCount, frameMs: this.frameMs }
  }

  /** Per frame on the PBR branch: frame, time, rain, colour, roughness; the define switches follow the preset. */
  private updatePbr(frame: number, animS: number, p: WaterParams): void {
    const s = this.pbrState
    const src = this.source
    const rain = Math.min(1, Math.max(0, src?.render.weather.rain ?? 0))
    s.setSwitches(!!src?.render.quality.waterDepthShore, src?.weather?.rippleTexture ?? null)
    // AAA water: the river flow and the glitter on the PBR presets (the glitter follows the ocean row's switch).
    s.setLook({ flow: true, glint: !!src?.render.quality.ocean?.glint })
    s.a.set(frame, animS % 3600, rain, src?.weather?.u.wxA.w ?? animS % 3600)
    const c = waterHue(p.color)
    s.b.set(c[0], c[1], c[2], WATER_ROUGHNESS[0] + (WATER_ROUGHNESS[1] - WATER_ROUGHNESS[0]) * rain)
    // W11-S: the ripple points' clock.
    if (this.townPlugin) this.townState.q.x = animS % 3600
  }

  setVisible(on: boolean): void {
    this.visible = on
    for (const m of this.meshes) m.setEnabled(on)
  }

  dispose(): void {
    for (const m of this.meshes) m.dispose(false, false)
    this.meshes.length = 0
    this.byRegion.clear()
    this.iceMat?.dispose(true, true)
    this.iceMat = null
    this.icePbr?.dispose(false, false)
    this.icePbr = null
    this.iceTexture?.dispose()
    this.iceTexture = null
    this.pbrMaterial?.dispose(false, false)
    this.pbrMaterial = null
    this.townPlugin = null
    this.pbrState.normal?.dispose()
    this.pbrState.normal = null
    this.pbrState.frames = null
    this.material?.dispose(true, false)
    this.material = null
    this.frames?.dispose()
    this.frames = null
    this.black?.dispose()
    this.black = null
  }
}

/** Rivers: the half-width (m) below which water flows at full speed, and above which (lakes, the sea) it is still. */
export const RIVER_HALF_WIDTH_M: readonly [number, number] = [8, 20]
/** Water within this of the sea level is the sea's own bays (it joins the ocean): still. */
const SEA_JOIN_M = 0.4
/** The flow runs from the island's middle (Jangan) out to the sea. */
const ISLAND_CENTRE: readonly [number, number] = [100, -100]

/**
 * AAA water, flowing rivers (pbr/water-plugin.ts SRO_WATER_FLOW): per region grid vertex (GRID², glTF axes) the
 * attribute (flow x, flow z in m/s, rapids 0..1, strength 0..1). The retail water planes are flat and carry no
 * direction, so the channel gives it: a chamfer distance (m) from the dry ground over the region's water, its gradient
 * across the channel turned a quarter (along the banks), signed to point away from the island's middle (rivers run
 * out to the sea), blurred; the strength is 1 where the channel's half-width (the largest bank distance within 16 m)
 * is under RIVER_HALF_WIDTH_M[0] and 0 over [1] (lakes, ponds and the sea's bays stay still), the rapids where the
 * flowing water runs shallow. Null when no vertex flows.
 */
export function riverFlow(blocks: readonly TerrainBlock[], heights: Float32Array | ArrayLike<number>, origin: readonly number[], seaLevelM: number | null): Float32Array | null {
  const N = GRID
  const level = new Float32Array(N * N).fill(NaN)
  let any = false
  for (const b of blocks) {
    const w = b.water
    if (!w || w.kind !== 'water') continue
    const h = (origin[1] ?? 0) + w.heightM
    if (seaLevelM !== null && Math.abs(h - seaLevelM) < SEA_JOIN_M) continue
    for (let j = 0; j <= 16; j++) for (let i = 0; i <= 16; i++) level[(b.bz * 16 + j) * N + b.bx * 16 + i] = w.heightM
    any = true
  }
  if (!any) return null
  // the chamfer distance (m) from dry cells (2 m grid: 2 straight, 2.83 diagonal); the region's edge is not a bank
  const BIG = 1e6
  const d = new Float32Array(N * N)
  for (let k = 0; k < N * N; k++) {
    const lv = level[k]!
    d[k] = Number.isNaN(lv) || lv - (heights[k] ?? 0) <= 0.05 ? 0 : BIG
  }
  const S = 2, D = 2.83
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const k = z * N + x
      let v = d[k]!
      if (v === 0) continue
      if (x > 0) v = Math.min(v, d[k - 1]! + S)
      if (z > 0) {
        v = Math.min(v, d[k - N]! + S)
        if (x > 0) v = Math.min(v, d[k - N - 1]! + D)
        if (x < N - 1) v = Math.min(v, d[k - N + 1]! + D)
      }
      d[k] = v
    }
  }
  for (let z = N - 1; z >= 0; z--) {
    for (let x = N - 1; x >= 0; x--) {
      const k = z * N + x
      let v = d[k]!
      if (v === 0) continue
      if (x < N - 1) v = Math.min(v, d[k + 1]! + S)
      if (z < N - 1) {
        v = Math.min(v, d[k + N]! + S)
        if (x < N - 1) v = Math.min(v, d[k + N + 1]! + D)
        if (x > 0) v = Math.min(v, d[k + N - 1]! + D)
      }
      d[k] = v
    }
  }
  for (let k = 0; k < N * N; k++) if (d[k]! >= BIG) d[k] = 64 // a region of water with no bank at all: wide
  // the channel's half-width: the largest bank distance within 8 cells (separable max)
  const R = 8
  const tmp = new Float32Array(N * N)
  const wide = new Float32Array(N * N)
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    let m = 0
    for (let i = Math.max(0, x - R); i <= Math.min(N - 1, x + R); i++) m = Math.max(m, d[z * N + i]!)
    tmp[z * N + x] = m
  }
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    let m = 0
    for (let j = Math.max(0, z - R); j <= Math.min(N - 1, z + R); j++) m = Math.max(m, tmp[j * N + x]!)
    wide[z * N + x] = m
  }
  // along the banks, away from the island's middle (glTF: grid x → +x, grid z → −z)
  const tx = new Float32Array(N * N), tz = new Float32Array(N * N)
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    const k = z * N + x
    if (d[k] === 0) continue
    const gx = d[z * N + Math.min(N - 1, x + 1)]! - d[z * N + Math.max(0, x - 1)]!
    const gzGrid = d[Math.min(N - 1, z + 1) * N + x]! - d[Math.max(0, z - 1) * N + x]!
    // the world gradient (gx, −gzGrid) turned a quarter: (gzGrid, gx)
    let ax = gzGrid, az = gx
    const l = Math.hypot(ax, az)
    if (l < 1e-4) continue
    ax /= l
    az /= l
    const wx = (origin[0] ?? 0) + 2 * x - ISLAND_CENTRE[0], wz = (origin[2] ?? 0) - 2 * z - ISLAND_CENTRE[1]
    if (ax * wx + az * wz < 0) {
      ax = -ax
      az = -az
    }
    tx[k] = ax
    tz[k] = az
  }
  // blur the direction (radius 3 cells) so the channel's middle, where the gradient vanishes, takes its banks' way
  const B = 3
  const bx = new Float32Array(N * N), bz = new Float32Array(N * N)
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    let sx = 0, sz = 0
    for (let i = Math.max(0, x - B); i <= Math.min(N - 1, x + B); i++) {
      sx += tx[z * N + i]!
      sz += tz[z * N + i]!
    }
    bx[z * N + x] = sx
    bz[z * N + x] = sz
  }
  const out = new Float32Array(N * N * 4)
  let flows = false
  const smooth = (a: number, b: number, v: number) => {
    const t = Math.min(1, Math.max(0, (v - a) / (b - a)))
    return t * t * (3 - 2 * t)
  }
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    const k = z * N + x
    if (Number.isNaN(level[k]!)) continue
    let sx = 0, sz = 0
    for (let j = Math.max(0, z - B); j <= Math.min(N - 1, z + B); j++) {
      sx += bx[j * N + x]!
      sz += bz[j * N + x]!
    }
    const l = Math.hypot(sx, sz)
    if (l < 1e-3) continue
    const strength = 1 - smooth(RIVER_HALF_WIDTH_M[0], RIVER_HALF_WIDTH_M[1], wide[k]!)
    if (strength <= 0) continue
    const depth = level[k]! - (heights[k] ?? 0)
    const speed = FLOW_SPEED_MS * strength
    out[k * 4] = (sx / l) * speed
    out[k * 4 + 1] = (sz / l) * speed
    out[k * 4 + 2] = strength * (1 - smooth(0.25, 1.1, depth)) * 0.9
    out[k * 4 + 3] = strength
    flows = true
  }
  return flows ? out : null
}

/** Up normals for n vertices (the flat PBR water). */
function upNormals(n: number): number[] {
  const out = new Array<number>(n * 3)
  for (let i = 0; i < n; i++) {
    out[i * 3] = 0
    out[i * 3 + 1] = 1
    out[i * 3 + 2] = 0
  }
  return out
}
