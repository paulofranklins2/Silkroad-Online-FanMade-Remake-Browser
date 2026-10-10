import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { REPO_ROOT } from '../config.ts'
import { MeshNav, type NavPoint } from '../nav.ts'

/**
 * The beaches' path test (docs/COAST.md §9.5): a breadth-first search over the real server walker (MeshNav.walk, the
 * world bounds' clamp) from the town spawn on a 2 m grid, then:
 * - every trade post of content/jobs/jobs.json is reached (within 30 m) and lies in the town's walkable component;
 * - every beach area of data/zones.json has reached dry ground within 6 m above the sea level;
 * - every beach pass of content/coast/passes.json walks straight from end to end (a click-to-move player can use it).
 *   pnpm --filter @sro/server exec tsx src/cli/beach-reach.ts     (env OUT_DIR, WORLD_EXPORT, GRID)
 * Exit code 1 when anything fails.
 */
const outDir = resolve(process.env.OUT_DIR || join(REPO_ROOT, 'work/out'))
const folder = process.env.WORLD_EXPORT || 'jangan-fields'
const G = Number(process.env.GRID ?? 2)
const { nav, problem } = MeshNav.load([outDir], folder)
if (!nav) throw new Error(`no navmesh: ${problem}`)
const man = JSON.parse(readFileSync(join(outDir, 'world', folder, 'manifest.json'), 'utf8'))
const B = man.bounds as { minX: number; maxX: number; minZ: number; maxZ: number }
const inB = (x: number, z: number) => x >= B.minX && x <= B.maxX && z >= B.minZ && z <= B.maxZ
const x0 = B.minX, z0 = B.minZ
const W = Math.ceil((B.maxX - B.minX) / G) + 1, H = Math.ceil((B.maxZ - B.minZ) / G) + 1
const seen = new Uint8Array(W * H)
const s = man.spawn as { x: number; y: number; z: number }
const start = nav.locate(s.x, s.z, s.y)
if (!start) throw new Error('the spawn has no surface')
const cell = (x: number, z: number) => [Math.round((x - x0) / G), Math.round((z - z0) / G)] as const
const q: Array<[number, number, NavPoint]> = []
{
  const [i, j] = cell(start.x, start.z)
  seen[j * W + i] = 1
  q.push([i, j, start])
}
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
for (let n = 0; n < q.length; n++) {
  const [i, j, p] = q[n]!
  for (const [di, dj] of DIRS) {
    const a = i + di!, b = j + dj!
    if (a < 0 || b < 0 || a >= W || b >= H || seen[b * W + a]) continue
    const tx = x0 + a * G, tz = z0 + b * G
    if (!inB(tx, tz)) continue
    const w = nav.walk(p, tx, tz)
    if (!w?.end || w.blocked || Math.hypot(w.end.x - tx, w.end.z - tz) > 0.5) continue
    seen[b * W + a] = 1
    q.push([a, b, w.end])
  }
}
const reached = (x: number, z: number, r: number) => {
  const [i, j] = cell(x, z)
  const k = Math.ceil(r / G)
  for (let dj = -k; dj <= k; dj++) for (let di = -k; di <= k; di++) {
    const a = i + di, b = j + dj
    if (a >= 0 && b >= 0 && a < W && b < H && seen[b * W + a]) return true
  }
  return false
}
console.log(`${folder}: ${q.length} grid points reached on foot from the spawn (${G} m grid)`)
let fail = 0
const line = (ok: boolean, text: string) => {
  if (!ok) fail++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`)
}

const jobs = JSON.parse(readFileSync(join(REPO_ROOT, 'content/jobs/jobs.json'), 'utf8')) as { posts: Array<{ id: string; x: number; z: number }> }
for (const p of jobs.posts) {
  const at = nav.locate(p.x, p.z, 1000)
  line(reached(p.x, p.z, 30) && !!at && nav.inHome(at), `trade post ${p.id} (${p.x}, ${p.z})`)
}

const sea = man.coast?.seaLevelM ?? 5
const zones = JSON.parse(readFileSync(join(outDir, 'data/zones.json'), 'utf8')).entries as Array<{ rx: number; rz: number; name: string | null }>
const beaches = new Map<string, Array<[number, number]>>()
for (const e of zones) if (e.name && /Beach|Cape|Strait|Mouth|Shore/.test(e.name)) beaches.set(e.name, [...(beaches.get(e.name) ?? []), [e.rx, e.rz]])
const o = man.space.originRegion as { x: number; z: number }
for (const [name, regions] of beaches) {
  let total = 0, got = 0
  for (const [rx, rz] of regions) {
    const gx0 = 192 * (rx - o.x), gz1 = -192 * (rz - o.z)
    for (let z = gz1 - 192 + 1; z < gz1; z += 4) for (let x = gx0 + 1; x < gx0 + 192; x += 4) {
      const h = nav.terrainHeight(x, z)
      if (!(h > sea && h < sea + 6) || !nav.terrainOpen(x, z)) continue
      total++
      if (reached(x, z, G)) got++
    }
  }
  line(got > 0, `beach ${name}: ${got} of ${total} open shore points (up to ${sea + 6} m) reached`)
}

const passes = JSON.parse(readFileSync(join(REPO_ROOT, 'content/coast/passes.json'), 'utf8')).passes as Array<{ name: string; points: [number, number][] }>
for (const p of passes) {
  let at = nav.place(p.points[0]![0], p.points[0]![1], 1000, 8)
  let ok = !!at
  for (const [x, z] of p.points.slice(1)) {
    if (!at) break
    const w = nav.walk(at, x, z)
    if (!w?.end || w.blocked) {
      ok = false
      break
    }
    at = w.end
  }
  line(ok, `pass ${p.name}: walks straight end to end`)
}
console.log(fail ? `${fail} failed` : 'all reachable')
process.exitCode = fail ? 1 : 0
