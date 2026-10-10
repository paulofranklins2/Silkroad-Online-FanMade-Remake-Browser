import { pvpOffAt, pvpOffRefusal, pvpOnRefusal, type GameplayRequest } from '@sro/shared'
import type { Gameplay } from './gameplay.ts'
import { fail, type Fail } from './inventory.ts'
import type { Answer, GameplayMessage, GameplayModule } from './modules.ts'
import type { Mob, Player } from './world.ts'

/**
 * Open-world PvP, opt-in (docs/PVP.md; the shared rules in packages/shared/src/pvp.ts): the PvP cape.
 *
 * - `pvpFlag {on}`: on at once in a town or out of combat; off in a town, or 5 minutes after it went on and after the last
 *   PvP hit (HunterService.lastPvpAt). EntityState.pvp / `entityUpdate.pvp` for everyone in view (the name colour, the
 *   minimap dot).
 * - The PvP rule itself is the shared `pvpAllowed` (HunterService.side fills `pk` and `inTown`): two caped players outside
 *   towns, never associates. The Hunter / Wanted fight and the job war are unchanged.
 * - The cape is kept in memory per character until the server restarts (a logout does not take it off, so logging out
 *   is no escape from a fight); everyone starts without it.
 * - Deaths: no EXP lost (climb/penalty.ts never takes EXP for a player killer), nothing dropped; both sides get a line.
 */
export class PvpService implements GameplayModule {
  readonly name = 'pvp'
  readonly handles: readonly GameplayRequest[] = ['pvpFlag']
  /** characterId -> when the cape went on (ms). */
  private readonly flagged = new Map<number, number>()

  constructor(private readonly g: Gameplay) {
    g.world.decorators.push((e, s) => {
      if (e.kind === 'player' && this.flagged.has(e.characterId)) s.pvp = true
    })
  }

  /** Whether the character wears the PvP cape. */
  isOn(characterId: number): boolean {
    return this.flagged.has(characterId)
  }

  private inTown(p: Player, now: number): boolean {
    const [x, , z] = this.g.world.positionAt(p, now)
    return this.g.data.inSafeArea(this.g.config.world, x, z)
  }

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    if (msg.t !== 'pvpFlag') return answer(fail('not_found'))
    answer(this.set(p, msg.on, now))
  }

  /** The cape on or off (the request; GM tools and tests). */
  set(p: Player, on: boolean, now: number): true | Fail {
    const at = this.flagged.get(p.characterId)
    if (on === (at !== undefined)) return true
    const town = this.inTown(p, now)
    if (on) {
      if (pvpOnRefusal(town, p.lastCombatAt, now)) return fail('in_combat', 'Not in the middle of a fight (or go to town).')
      this.flagged.set(p.characterId, now)
      p.send({ t: 'chat', channel: 'system', text: 'PvP cape on: other players wearing the cape can attack you outside town, and you them.' })
    } else {
      const last = this.g.hunters.lastPvpAt(p.characterId)
      if (pvpOffRefusal(town, at!, last, now)) {
        const s = Math.ceil((pvpOffAt(at!, last) - now) / 1000)
        return fail('in_combat', `The PvP cape comes off in town, or after 5 minutes without PvP (${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left).`)
      }
      this.flagged.delete(p.characterId)
      p.send({ t: 'chat', channel: 'system', text: 'PvP cape off.' })
    }
    this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, pvp: on })
    this.g.config.log(`pvp: ${p.name} cape ${on ? 'on' : 'off'}`)
    return true
  }

  playerDied(p: Player, _now: number, killer?: Player | Mob): void {
    if (killer?.kind !== 'player' || killer === p || !this.isOn(p.characterId) || !this.isOn(killer.characterId)) return
    p.send({ t: 'chat', channel: 'system', text: `${killer.name} defeated you in PvP. Nothing is lost.` })
    killer.send({ t: 'chat', channel: 'system', text: `You defeated ${p.name} in PvP.` })
  }
}
