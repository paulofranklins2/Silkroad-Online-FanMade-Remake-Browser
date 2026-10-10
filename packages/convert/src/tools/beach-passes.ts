#!/usr/bin/env node
/**
 * The beach passes (docs/COAST.md §9.5): cuts the valleys of content/coast/passes.json through retail's end-of-map
 * mountain ring into the World Editor's layers (content/world-edits/jangan-fields/), so the converter's world-edits
 * pass reshapes the terrain, the lightmaps, the minimap and the nav like any hand edit.
 *
 *   pnpm tsx packages/convert/src/tools/beach-passes.ts [--export work/out/world/jangan-fields] [--dry]
 *
 * Per pass: the polyline is sampled every 2 m on the export's ground; the floor profile is the largest function under
 * that ground whose grade stays within maxGrade (min over u of ground(u) + maxGrade |s - u|), lightly smoothed, so the
 * floor cuts through a ridge as a notch and follows the ground elsewhere. Vertices within halfWidthM of the line take the
 * floor; out to where they meet the ground the valley walls rise at wallSlope (cut only). The height delta is added to
 * the region's existing layer (the export already holds it), written to every region sharing a seam vertex, and the
 * tiles of the floor are forced open (walk = 1). Regions get an edits.json entry; their `base` comes from the next
 * convert's report (report.edits.bases) and is copied in with --bases <manifest.json>.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { decodeHeightLayer, decodeWalkLayer, emptyHeightLayer, emptyWalkLayer, encodeHeightLayer, encodeWalkLayer, snapHeightDelta,
  type HeightLayer, type WalkLayer, type WorldEditsIndex } from '../../../shared/src/world-edits/index.ts'
import { encodePng } from '../../../../apps/viewer/editor-api/png.ts'
import { REPO_ROOT } from '../node-io.ts'
import { decodeTerrainBin } from '../world/format.ts'

const C = 96
const G = 97
const ORIGIN = { x: 168, z: 97 }
/** The export's regions (the edits apply to these only). */
const EXPORT = { x0: 155, x1: 175, z0: 89, z1: 103 }

interface Pass { name: string; points: [number, number][]; halfWidthM?: number; maxGrade?: number; wallSlope?: number; smoothM?: number }
interface PassFile { defaults: Required<Omit<Pass, 'name' | 'points'>>; passes: Pass[] }

const rid = (x: number, z: number) => (z << 8) | x
const gxOf = (x: number) => x / 2 + ORIGIN.x * C
const gzOf = (z: number) => -z / 2 + ORIGIN.z * C

function holders(ggx: number, ggz: number): Array<{ rx: number; rz: number; i: number }> {
  const rx = Math.floor(ggx / C), rz = Math.floor(ggz / C)
  const gx = ggx - rx * C, gz = ggz - rz * C
  const out = [{ rx, rz, i: gz * G + gx }]
  if (gx === 0) out.push({ rx: rx - 1, rz, i: gz * G + C })
  if (gz === 0) out.push({ rx, rz: rz - 1, i: C * G + gx })
  if (gx === 0 && gz === 0) out.push({ rx: rx - 1, rz: rz - 1, i: C * G + C })
  return out
}

async function readLayer(file: string, kind: 'height' | 'walk'): Promise<ArrayLike<number>> {
  if (kind === 'height') {
    const { data } = await sharp(file).toColourspace('grey16').raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true })
    return new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2)
  }
  const { data } = await sharp(file).toColourspace('b-w').raw().toBuffer({ resolveWithObject: true })
  return data
}

async function main(argv: string[]): Promise<void> {
  const at = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }
  const exportDir = resolve(at('--export') ?? join(REPO_ROOT, 'work/out/world/jangan-fields'))
  const dry = argv.includes('--dry')
  const editsDir = join(REPO_ROOT, 'content/world-edits/jangan-fields')
  const indexFile = join(editsDir, 'edits.json')
  const index = JSON.parse(readFileSync(indexFile, 'utf8')) as WorldEditsIndex

  const basesFrom = at('--bases')
  if (basesFrom) {
    const bases = (JSON.parse(readFileSync(resolve(basesFrom), 'utf8')).report?.edits?.bases ?? {}) as Record<string, string>
    let n = 0
    for (const r of index.regions) {
      const b = bases[`${r.x}_${r.z}`]
      if (b && b !== r.base) { r.base = b; n++ }
    }
    writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n')
    console.log(`beach passes: ${n} base hash(es) updated from ${basesFrom}`)
    return
  }

  const spec = JSON.parse(readFileSync(join(REPO_ROOT, 'content/coast/passes.json'), 'utf8')) as PassFile
  const terrain = new Map<number, Float32Array>()
  const groundAt = (ggx: number, ggz: number): number => {
    const h = holders(ggx, ggz)[0]!
    const id = rid(h.rx, h.rz)
    if (!terrain.has(id)) {
      const f = join(exportDir, 'terrain', `${h.rx}_${h.rz}.bin`)
      terrain.set(id, existsSync(f) ? Float32Array.from(decodeTerrainBin(new Uint8Array(readFileSync(f))).heights) : new Float32Array(0))
    }
    const t = terrain.get(id)!
    return t.length ? t[h.i]! : NaN
  }
  const groundBilinear = (x: number, z: number): number => {
    const fx = gxOf(x), fz = gzOf(z)
    const x0 = Math.floor(fx), z0 = Math.floor(fz), tx = fx - x0, tz = fz - z0
    return (groundAt(x0, z0) * (1 - tx) + groundAt(x0 + 1, z0) * tx) * (1 - tz) + (groundAt(x0, z0 + 1) * (1 - tx) + groundAt(x0 + 1, z0 + 1) * tx) * tz
  }

  /** New absolute height per global vertex (key ggz * 65536 + ggx), and the floor's vertices. */
  const target = new Map<number, number>()
  const floor = new Set<number>()
  for (const p of spec.passes) {
    const o = { ...spec.defaults, ...p }
    // sample the line every 2 m
    const S: Array<{ x: number; z: number; s: number }> = []
    let acc = 0
    for (let k = 0; k + 1 < p.points.length; k++) {
      const [ax, az] = p.points[k]!, [bx, bz] = p.points[k + 1]!
      const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(L / 2))
      for (let j = k === 0 ? 0 : 1; j <= n; j++) S.push({ x: ax + ((bx - ax) * j) / n, z: az + ((bz - az) * j) / n, s: acc + (L * j) / n })
      acc += L
    }
    const hb = S.map(q => groundBilinear(q.x, q.z))
    if (hb.some(Number.isNaN)) throw new Error(`pass ${p.name}: leaves the export's terrain`)
    let t = S.map((q, i) => Math.min(...S.map((u, j) => hb[j]! + o.maxGrade * Math.abs(q.s - u.s))) + 0 * i)
    const w = Math.max(1, Math.round(o.smoothM / 4))
    t = t.map((_, i) => { let a = 0, n = 0; for (let j = Math.max(0, i - w); j <= Math.min(t.length - 1, i + w); j++) { a += t[j]!; n++ } return a / n })
    const cut = Math.max(...hb.map((h, i) => h - t[i]!))
    const grade = Math.max(...t.slice(1).map((v, i) => Math.abs(v - t[i]!) / (S[i + 1]!.s - S[i]!.s)))
    console.log(`pass ${p.name}: ${acc.toFixed(0)} m, ground ${Math.min(...hb).toFixed(1)}..${Math.max(...hb).toFixed(1)} m, deepest cut ${cut.toFixed(1)} m, steepest floor ${grade.toFixed(2)}`)
    // vertices near the line
    const reach = o.halfWidthM + cut / o.wallSlope + 4
    const xs = S.map(q => q.x), zs = S.map(q => q.z)
    for (let ggz = Math.floor(gzOf(Math.max(...zs) + reach)); ggz <= Math.ceil(gzOf(Math.min(...zs) - reach)); ggz++) {
      for (let ggx = Math.floor(gxOf(Math.min(...xs) - reach)); ggx <= Math.ceil(gxOf(Math.max(...xs) + reach)); ggx++) {
        const x = (ggx - ORIGIN.x * C) * 2, z = -(ggz - ORIGIN.z * C) * 2
        let best = Infinity, bi = 0
        for (let i = 0; i < S.length; i++) {
          const d = (S[i]!.x - x) ** 2 + (S[i]!.z - z) ** 2
          if (d < best) { best = d; bi = i }
        }
        const d = Math.sqrt(best)
        if (d > reach) continue
        const cur = groundAt(ggx, ggz)
        if (Number.isNaN(cur)) continue
        const key = ggz * 65536 + ggx
        const want = d <= o.halfWidthM ? t[bi]! : Math.min(cur, t[bi]! + (d - o.halfWidthM) * o.wallSlope)
        if (d <= o.halfWidthM - 1) floor.add(key)
        target.set(key, Math.min(target.get(key) ?? Infinity, want))
      }
    }
  }

  // merge into the layers
  const heightLayers = new Map<number, HeightLayer>()
  const walkLayers = new Map<number, WalkLayer>()
  const inExport = (x: number, z: number) => x >= EXPORT.x0 && x <= EXPORT.x1 && z >= EXPORT.z0 && z <= EXPORT.z1
  const layerOf = async (x: number, z: number): Promise<HeightLayer> => {
    const id = rid(x, z)
    if (!heightLayers.has(id)) {
      const f = join(editsDir, 'height', `${x}_${z}.png`)
      heightLayers.set(id, existsSync(f) ? decodeHeightLayer(await readLayer(f, 'height')) : emptyHeightLayer())
    }
    return heightLayers.get(id)!
  }
  const walkOf = async (x: number, z: number): Promise<WalkLayer> => {
    const id = rid(x, z)
    if (!walkLayers.has(id)) {
      const f = join(editsDir, 'walk', `${x}_${z}.png`)
      walkLayers.set(id, existsSync(f) ? decodeWalkLayer(await readLayer(f, 'walk')) : emptyWalkLayer())
    }
    return walkLayers.get(id)!
  }
  let vertices = 0
  for (const [key, want] of target) {
    const ggx = key % 65536, ggz = Math.floor(key / 65536)
    const dh = want - groundAt(ggx, ggz)
    if (Math.abs(dh) < 0.01) continue
    vertices++
    for (const h of holders(ggx, ggz)) {
      if (!inExport(h.rx, h.rz)) continue
      const l = await layerOf(h.rx, h.rz)
      l.delta[h.i] = snapHeightDelta((l.mask[h.i] ? l.delta[h.i]! : 0) + dh)
      l.mask[h.i] = 1
    }
  }
  let tiles = 0
  for (const key of floor) {
    const ggx = key % 65536, ggz = Math.floor(key / 65536)
    if (![1, 65536, 65537].every(o => floor.has(key + o))) continue
    const rx = Math.floor(ggx / C), rz = Math.floor(ggz / C)
    if (!inExport(rx, rz)) continue
    const wl = await walkOf(rx, rz)
    const ti = (ggz - rz * C) * C + (ggx - rx * C)
    if (wl.codes[ti] !== 1) { wl.codes[ti] = 1; tiles++ }
  }
  // retail plants on ground the passes moved go (a tree left hanging over the cut would also keep its trunk's nav
  // footprint across the floor); anything else on moved ground is listed
  const placementsFile = join(editsDir, 'placements.json')
  const pe = JSON.parse(readFileSync(placementsFile, 'utf8')) as {
    move: Array<{ region: number; uid: number }>; drop: Array<{ region: number; uid: number; source: string; from: { position: number[]; yaw: number } }>
  }
  const manifest = JSON.parse(readFileSync(join(exportDir, 'manifest.json'), 'utf8')) as {
    placements: Array<{ region: number; uid: number; source: string; position: [number, number, number]; yaw: number }>
  }
  const edited = new Set([...pe.move, ...pe.drop].map(r => `${r.region}:${r.uid}`))
  let dropped = 0
  for (const p of manifest.placements) {
    if (p.uid >= 0xe000 || p.uid > 0xffff || edited.has(`${p.region}:${p.uid}`)) continue
    const rx = p.region & 0xff, rz = p.region >> 8
    if (!inExport(rx, rz)) continue
    const key = Math.round(gzOf(p.position[2])) * 65536 + Math.round(gxOf(p.position[0]))
    const want = target.get(key)
    if (want === undefined || Math.abs(want - groundAt(key % 65536, Math.floor(key / 65536))) < 0.5) continue
    if (!/\\nature\\/i.test(p.source)) {
      console.log(`  on moved ground (kept): ${p.source} region ${rx}_${rz} uid ${p.uid}`)
      continue
    }
    pe.drop.push({ region: p.region, uid: p.uid, source: p.source, from: { position: p.position, yaw: p.yaw } })
    dropped++
  }
  console.log(`beach passes: ${vertices} vertices moved in ${heightLayers.size} region(s), ${tiles} floor tile(s) forced open in ${walkLayers.size} ` +
    `region(s), ${dropped} plant(s) on moved ground dropped`)
  if (dry) return
  writeFileSync(placementsFile, JSON.stringify(pe, null, 2) + '\n')

  mkdirSync(join(editsDir, 'height'), { recursive: true })
  mkdirSync(join(editsDir, 'walk'), { recursive: true })
  const touch = (id: number, kind: 'height' | 'walk') => {
    const x = id & 0xff, z = id >> 8
    let r = index.regions.find(q => q.x === x && q.z === z)
    if (!r) index.regions.push(r = { x, z, base: '0'.repeat(64), layers: [] })
    if (!r.layers.includes(kind)) r.layers = [...r.layers, kind].sort() as typeof r.layers
  }
  for (const [id, l] of heightLayers) {
    writeFileSync(join(editsDir, 'height', `${id & 0xff}_${id >> 8}.png`), encodePng({ width: G, height: G, channels: 2, depth: 16, data: encodeHeightLayer(l) }))
    touch(id, 'height')
  }
  for (const [id, l] of walkLayers) {
    writeFileSync(join(editsDir, 'walk', `${id & 0xff}_${id >> 8}.png`), encodePng({ width: C, height: C, channels: 1, depth: 8, data: encodeWalkLayer(l) }))
    touch(id, 'walk')
  }
  index.regions.sort((a, b) => a.z - b.z || a.x - b.x)
  const count = (k: string) => index.regions.filter(r => (r.layers as string[]).includes(k)).length
  index.counts = { ...index.counts, height: count('height'), walk: count('walk'), drop: pe.drop.length }
  writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n')
  console.log(`beach passes: wrote ${heightLayers.size} height and ${walkLayers.size} walk layer(s); run a convert, then --bases <manifest.json>`)
}

main(process.argv.slice(2)).catch((e: Error) => {
  console.error(e.message)
  process.exitCode = 1
})
