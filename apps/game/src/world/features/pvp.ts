/**
 * Open-world PvP on the client (docs/PVP.md; the rules in packages/shared/src/pvp.ts, the server's in apps/server/src/pvp.ts).
 *
 * - **The PvP cape button** beside the minimap (retail's Free PvP cape icon): click to put it on or take it off
 *   (`pvpFlag {on}`); the server judges (on: in town or out of combat; off: in town, or 5 minutes after the last PvP).
 * - **The tag**: a caped player shows a "PvP" badge before the name and an orange name (EntityState.pvp,
 *   `entityUpdate.pvp`), for everyone; caped players in view are orange dots on the minimap while we wear the cape.
 * - **Fighting**: while caped, a click on another caped player selects and attacks (the server's rule decides: towns,
 *   party, guild, account and connection are never fair game). Attack skills take them too (hotbar-model `hostile`).
 */
import { PVP_CAPE_ICON, PVP_COLOR, pvpOffAt } from '@sro/shared'
import { t } from '../../i18n/index.ts'
import type { HudMarker, HudMinimap } from '../jangan/minimap.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'

const CSS = `
.pvp-cape {
  position: absolute; left: -26px; top: 200px; width: 22px; height: 22px; padding: 0; pointer-events: auto; cursor: pointer;
  background: rgba(0, 0, 0, 0.55) center / 18px 18px no-repeat; border: 1px solid rgba(156, 131, 80, 0.55); border-radius: 2px;
  filter: grayscale(0.9) brightness(0.75);
}
.pvp-cape.on { filter: none; border-color: ${PVP_COLOR}; box-shadow: 0 0 6px rgba(255, 106, 58, 0.75); }
.pvp-cape:hover { filter: none; }
.entity-label .badge-pvp { color: ${PVP_COLOR}; font-weight: bold; margin-right: 4px; text-shadow: 1px 0 1px #000, -1px 0 1px #000, 0 1px 1px #000, 0 -1px 1px #000; }
.entity-label .badge-pvp ~ .name { color: ${PVP_COLOR}; }
`
let styled = false
function ensureStyle(): void {
  if (styled || typeof document === 'undefined') return
  styled = true
  const s = document.createElement('style')
  s.dataset.owner = 'pvp'
  s.textContent = CSS
  document.head.append(s)
}

const fmt = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function pvpFeature(ctx: WorldFeatureContext): WorldFeature {
  if (!ctx.session || typeof document === 'undefined') return {}
  ensureStyle()
  ctx.hud.claimRequests(['pvpFlag'])
  let minimap: HudMinimap | null = null
  let offMarkers: (() => void) | null = null
  let inTown = false
  /** Client estimate of when the cape went on / the last PvP hit (server ms; the tooltip's countdown only). */
  let flaggedAt = 0
  let lastPvp: number | null = null

  const self = () => {
    const id = ctx.selfId()
    return id === null ? undefined : ctx.view(id)
  }
  const caped = () => self()?.state.pvp === true

  const button = document.createElement('button')
  button.className = 'pvp-cape'
  button.style.backgroundImage = `url("${PVP_CAPE_ICON}")`
  button.addEventListener('click', (e) => {
    e.stopPropagation()
    ctx.send({ t: 'pvpFlag', on: !caped() })
  })
  const refreshButton = () => {
    const on = caped()
    button.classList.toggle('on', on)
    let tip = t(on ? 'pvp.cape.on' : 'pvp.cape.off')
    const left = pvpOffAt(flaggedAt, lastPvp) - ctx.serverNow()
    if (on && !inTown && left > 0) tip += `\n${t('pvp.cape.lockedLeft', { time: fmt(left) })}`
    button.title = tip
  }

  const tag = (v: { kind: string; state: { pvp?: true }; setBadge(key: string, text: string | null): void }) => {
    if (v.kind === 'player') v.setBadge('pvp', v.state.pvp ? t('pvp.badge') : null)
  }
  const offAttach = ctx.addAttachment((v) => {
    if (v.kind !== 'player') return null
    const apply = () => tag(v)
    return { loaded: apply, update: apply, dispose() {} }
  })

  function* markers(): Iterable<HudMarker> {
    const me = self()
    if (!me || me.state.pvp !== true) return
    for (const v of ctx.views()) {
      if (v.kind !== 'player' || v === me || v.state.pvp !== true || v.dead) continue
      yield { x: v.pos.x, z: v.pos.z, color: PVP_COLOR, size: 3.5 }
    }
  }

  return {
    onMessage(msg) {
      switch (msg.t) {
        case 'entityUpdate': {
          if (msg.pvp === undefined) break
          const v = ctx.view(msg.id)
          if (!v) break
          if (msg.pvp) v.state.pvp = true
          else delete v.state.pvp
          tag(v)
          if (msg.id === ctx.selfId() && msg.pvp) flaggedAt = ctx.serverNow()
          refreshButton()
          break
        }
        case 'combat': {
          // a player-on-player hit given or taken: the cape's 5-minute lock restarts
          const me = ctx.selfId()
          const a = ctx.view(msg.attacker)
          const tg = ctx.view(msg.target)
          if (me !== null && a?.kind === 'player' && tg?.kind === 'player' && a !== tg && (a.id === me || tg.id === me)) lastPvp = ctx.serverNow()
          break
        }
        case 'worldLeft':
          lastPvp = null
          break
      }
    },

    onTownChange(town) {
      inTown = town
      refreshButton()
    },

    clickEntity(v) {
      if (v.kind !== 'player' || v.id === ctx.selfId() || v.state.pvp !== true || !caped() || inTown) return false
      ctx.setTarget(v)
      ctx.send({ t: 'attack', target: v.id })
      return true
    },

    onFrame() {
      const m = ctx.minimap()
      if (m && m !== minimap) {
        offMarkers?.()
        minimap = m
        offMarkers = m.addMarkerSource(markers)
        m.root.append(button)
        refreshButton()
      }
    },

    dispose() {
      offMarkers?.()
      offAttach()
      button.remove()
    },
  }
}
