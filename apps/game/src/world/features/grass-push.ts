/**
 * Overall Pass (grass): monsters, other players, NPCs and transports push the grass aside like the own character does.
 * Every frame the nearest GRASS_PUSHERS bodies within GRASS_PUSH_REACH_M of the camera's target go to the grass field
 * (GrassField.setPushers: one small uniform array, a few ALU per blade vertex). Ground items and the own character
 * (the field pushes around the camera's target already) are left out. No allocation per frame.
 */
import { GRASS_PUSHERS, GRASS_PUSH_REACH_M, grassFieldOf } from '@sro/world-render'
import type { WorldFeatureFactory } from '../features.ts'

/** A body's push radius (m): monsters and transports a little wider than people. */
const RADIUS = { player: 0.8, npc: 0.8, mob: 1.1, cos: 1.3 } as const

export const grassPushFeature: WorldFeatureFactory = ctx => {
  const out = new Float32Array(GRASS_PUSHERS * 4)
  const d2 = new Float32Array(GRASS_PUSHERS)
  const reach2 = GRASS_PUSH_REACH_M * GRASS_PUSH_REACH_M
  return {
    onFrame() {
      const scatter = ctx.world()?.world?.scatter
      const field = scatter ? grassFieldOf(scatter) : null
      if (!field?.setPushers) return
      const c = ctx.camera.target
      const self = ctx.controlledId?.() ?? ctx.selfId()
      let n = 0
      for (const v of ctx.views()) {
        const kind = v.state.kind
        if (kind === 'item' || v.state.id === self) continue
        const p = v.root.position
        const dx = p.x - c.x, dz = p.z - c.z
        const d = dx * dx + dz * dz
        if (d > reach2) continue
        // insertion into the nearest-N list
        let i = n < GRASS_PUSHERS ? n++ : GRASS_PUSHERS
        if (i === GRASS_PUSHERS) {
          if (d >= d2[GRASS_PUSHERS - 1]!) continue
          i = GRASS_PUSHERS - 1
        }
        while (i > 0 && d2[i - 1]! > d) {
          d2[i] = d2[i - 1]!
          out.copyWithin(i * 4, (i - 1) * 4, i * 4)
          i--
        }
        d2[i] = d
        out[i * 4] = p.x
        out[i * 4 + 1] = p.y
        out[i * 4 + 2] = p.z
        out[i * 4 + 3] = RADIUS[kind]
      }
      field.setPushers(out, n)
    },
  }
}
