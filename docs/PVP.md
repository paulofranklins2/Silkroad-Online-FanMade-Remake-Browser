# Open-world PvP: the PvP cape

Opt-in PvP everywhere outside towns (retail's Free PvP cape, `ITEM_*_FRPVP_VOUCHER`; icon `frpvp_voucher_a.png`).

| Piece | Where |
| --- | --- |
| Pure rules (`capePvp`, `pvpOnRefusal`, `pvpOffRefusal`, `pvpOffAt`, the `pvpFlag` request) | `packages/shared/src/pvp.ts` |
| The rule itself (`PvpSide.pk`, `PvpSide.inTown`, `pvpAllowed`) | `packages/shared/src/siege-hunter.ts` |
| The cape state, the request, the death lines | `apps/server/src/pvp.ts` (`Gameplay.pvp`) |
| Refusal texts, the sides | `apps/server/src/siege/hunters.ts` (`side`, `refusal`) |
| Area skills on players | `apps/server/src/skills/engine.ts` (`candidates`, `strike`, the imbue bounce) |
| Client: cape button, PvP tag, minimap dots, click to fight | `apps/game/src/world/features/pvp.ts` |

## Rules

- Everyone starts without the cape. `pvpFlag {on: true}` is instant in a town's safe area, or anywhere out of combat
  (no hit given or taken for 10 s).
- `pvpFlag {on: false}`: instant in town; elsewhere 5 minutes after the cape went on and after the last PvP hit given or
  taken (`HunterService.lastPvpAt`).
- The cape lives in server memory per character until a restart: a logout keeps it (no escaping a fight); a restart
  clears everyone's (no DB column).
- Two caped players may fight outside towns. Never associates (party, guild, the same account, the same IP), never the
  jailed, never in the Garrison Stockade. Damage × `hunter.pvpMul` like every player-on-player hit.
- Bounty Hunters on duty and the Wanted, and the job war, keep their own rows of `pvpAllowed` (unchanged).
- Death: no EXP loss (`climb/penalty.ts` never takes EXP for a player killer), no item drop; a chat line to both.
- EntityState.pvp / `entityUpdate.pvp`: the orange name with a "PvP" tag; caped players on the minimap while caped.

## Area skills

Every area shape (`caster`, `target`, `pierce`, `projectile_pierce`, `chain`; `skills/targeting.ts`) picks from every
living monster the caster sees and every player `HunterService.allowed` lets the caster fight now, whatever the primary
is. Chains gather candidates within `distance × (maxTargets − 1)` so every hop is reachable. The client sends attack
skills at a selected player it thinks hostile (`hotbar-model.ts` `TargetRef.hostile`); the server judges.
