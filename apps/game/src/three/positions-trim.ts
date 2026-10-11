/**
 * No per-vertex Vector3 copies from bounding refreshes (Overall Pass round 7, docs/PERF_OVERALL.md memory pass).
 * Babylon 9.28's `AbstractMesh._getData` (behind every `refreshBoundingInfo`, including the skeleton's own bounding
 * updates) also rebuilds `_positions`, one Vector3 per vertex kept on the mesh for picking and collisions, unless the
 * caller passes `updatePositionsArray: false`: ≈ 137 MB of the JS heap on the route (terrain, objects, characters). The
 * game never reads it; a ray pick that needs points builds them from the geometry on demand (`_generatePointsArray`).
 * Installed once (engine.ts); `PERF.trimPositions` switches it.
 */
import { AbstractMesh } from '@babylonjs/core'
import { PERF } from '../world/perf.ts'

let installed = false

export function installPositionsTrim(): void {
  if (installed) return
  installed = true
  const proto = AbstractMesh.prototype as unknown as { _getData(options: { updatePositionsArray?: boolean }, data: unknown, kind?: string): unknown }
  const orig = proto._getData
  proto._getData = function (this: unknown, options: { updatePositionsArray?: boolean }, data: unknown, kind?: string) {
    if (PERF.trimPositions && options && options.updatePositionsArray === undefined) options = { ...options, updatePositionsArray: false }
    return orig.call(this, options, data, kind)
  }
}
