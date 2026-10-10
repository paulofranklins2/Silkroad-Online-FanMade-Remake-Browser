/**
 * Open-world PvP, opt-in (docs/PVP.md): the PvP cape (retail's Free PvP cape, ITEM_*_FRPVP_VOUCHER). Pure rules shared by
 * the server (apps/server/src/pvp.ts) and the client (world/features/pvp.ts).
 *
 * - Everyone starts with the cape off. On is instant: in a town, or anywhere out of combat.
 * - Off: in a town at once; elsewhere only after `PVP_OFF_AFTER_MS` without a PvP hit (given or taken) and since the cape
 *   went on.
 * - Two caped players may fight anywhere but a town's safe area (and the Garrison Stockade); never associates (party,
 *   guild, account, connection), never the jailed. The Hunter / Wanted fight and the job war keep their own rules
 *   (siege-hunter.ts `pvpAllowed`).
 * - Deaths: no EXP lost and no item dropped (climb/penalty.ts: a player killer never takes EXP).
 */

/** The cape's icon (retail's Free PvP cape). */
export const PVP_CAPE_ICON = '/out/icons/item/china/man_item/frpvp_voucher_a.png'
/** The cape comes off outside a town only this long after the last PvP hit (and after it went on). */
export const PVP_OFF_AFTER_MS = 5 * 60_000
/** "In combat" for putting the cape on outside a town: a hit given or taken this recently (ms). */
export const PVP_COMBAT_MS = 10_000
/** The caped players' name colour and minimap dot. */
export const PVP_COLOR = '#ff6a3a'

export type PvpFlagRefusal = 'in_combat' | 'locked'

/** Whether the cape may go on now (null: yes). */
export function pvpOnRefusal(inTown: boolean, lastCombatAt: number, now: number): PvpFlagRefusal | null {
  if (inTown) return null
  return now - lastCombatAt < PVP_COMBAT_MS ? 'in_combat' : null
}

/** When the cape may come off outside a town (ms epoch): 5 minutes after it went on or the last PvP hit. */
export function pvpOffAt(flaggedAt: number, lastPvpAt: number | null): number {
  return Math.max(flaggedAt, lastPvpAt ?? 0) + PVP_OFF_AFTER_MS
}

/** Whether the cape may come off now (null: yes). */
export function pvpOffRefusal(inTown: boolean, flaggedAt: number, lastPvpAt: number | null, now: number): PvpFlagRefusal | null {
  if (inTown) return null
  return now < pvpOffAt(flaggedAt, lastPvpAt) ? 'locked' : null
}

/** The free-PvP row of the rule: both caped, neither in a town. */
export function capePvp(a: { pk?: boolean; inTown?: boolean }, b: { pk?: boolean; inTown?: boolean }): boolean {
  return !!a.pk && !!b.pk && !a.inTown && !b.inTown
}

export type PvpClientMessage =
  /** The PvP cape on or off. */
  { t: 'pvpFlag'; on: boolean }
export type PvpRequest = PvpClientMessage['t']
export const PVP_REQUESTS: readonly PvpRequest[] = ['pvpFlag']
export const PVP_RATE_LIMITS: Readonly<Record<PvpRequest, { perSecond: number; burst: number }>> = {
  pvpFlag: { perSecond: 1, burst: 3 },
}
