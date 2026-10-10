import { CODE_NAME, WEATHER_KINDS } from '@sro/shared'
import type { Connection } from '../connection.ts'
import type { GameContext } from '../game.ts'
import { COMMANDS, type GmResult } from '../gm.ts'
import { registerAdminRouteGroup, type AdminGroupRequest, type AdminGroupResponse } from './routes.ts'

/**
 * Live operations in the admin panel (docs/ADMIN.md §3.2): the route group `ops` (`/api/admin/ops/*`) gives the panel
 * the GM commands that run without a character in the world: the world clock, the weather and lightning, storms, the
 * snow season and its gameplay (Ice Yeti, snowballs, gifts), the Climb (and its death penalty), rare weapons and guilds.
 *
 * Nothing typed by the admin is ever a command line: every feature lists fixed actions, each a template of literal
 * words and typed parameters (`int`, `num` with bounds, `enum`, a character / guild `name`, a content `code`, an `hh:mm`
 * time). A parameter becomes exactly one argument (no spaces), and the GM code validates the arguments again. The
 * panel's router authenticates, rate limits and writes the admin_audit row; this handler re-checks the admin role and
 * writes a gm_audit row per action (the command's own name), so the in-game GM commands and the panel share one trail.
 *
 * GET ''               every feature with its status (the GM command's status reply) and its actions
 * GET <feature>        one feature's status
 * POST <feature>       {action, params?: {name: value}} → {ok, message, data?} (422 when the command refuses)
 */

export type OpsParamKind = 'int' | 'num' | 'enum' | 'name' | 'code' | 'time'

export interface OpsParam {
  name: string
  label: string
  kind: OpsParamKind
  min?: number
  max?: number
  options?: string[]
  optional?: boolean
  hint?: string
}

export interface OpsAction {
  id: string
  label: string
  /** Literal words, and `$param` for a parameter (an optional one only at the end). */
  args: string[]
  params?: OpsParam[]
  /** Changes the world for everyone (the panel confirms it). */
  danger?: boolean
}

export interface OpsFeature {
  id: string
  /** The GM command that runs it. */
  command: string
  name: string
  area: 'world' | 'winter' | 'progression' | 'social'
  about: string
  /** The args of the status reply. */
  /** The args of the status reply (null: no status without a player). */
  status: string[] | null
  /** A `world` command whose listed actions never use the GM's own character. */
  selfless?: boolean
  actions: OpsAction[]
}

export interface OpsFeatureView extends Omit<OpsFeature, 'command' | 'status'> {
  command: string
  state: GmResult
}

const p = (name: string, label: string, kind: OpsParamKind, extra: Partial<OpsParam> = {}): OpsParam => ({ name, label, kind, ...extra })
const PLAYER = (optional = false) => p('player', 'Character', 'name', optional ? { optional } : {})
const MINUTES = (label = 'Minutes', optional = true) => p('minutes', label, 'num', { min: 1, max: 1440, optional })

export const OPS_FEATURES: OpsFeature[] = [
  {
    id: 'time',
    command: 'time',
    name: 'World clock',
    area: 'world',
    about: 'The day and night cycle everyone sees: time of day, day number, day length, freeze, night speed-up and season.',
    status: [],
    actions: [
      { id: 'set', label: 'Set the time of day', args: ['$time'], params: [p('time', 'Time (hh:mm)', 'time')], danger: true },
      { id: 'day', label: 'Set the day', args: ['day', '$day'], params: [p('day', 'Day', 'int', { min: 0, max: 100_000 })], danger: true },
      { id: 'length', label: 'Day length', args: ['length', '$minutes'], params: [MINUTES('Minutes per day', false)], danger: true },
      { id: 'freeze', label: 'Freeze', args: ['freeze'], danger: true },
      { id: 'resume', label: 'Resume', args: ['resume'], danger: true },
      { id: 'night', label: 'Night speed-up', args: ['night', '$speedup'], params: [p('speedup', 'Speed-up (0-0.6)', 'num', { min: 0, max: 0.6 })], danger: true },
      { id: 'season', label: 'Season (sun angle)', args: ['season', '$deg'], params: [p('deg', 'Degrees', 'num', { min: -90, max: 90 })], danger: true },
      { id: 'reset', label: 'Reset', args: ['reset'], danger: true },
    ],
  },
  {
    id: 'weather',
    command: 'weather',
    name: 'Weather',
    area: 'world',
    about: 'Hold a weather state, go back to the schedule, set the wind and wet surfaces, or strike lightning (lightning hurts everyone near it).',
    status: [],
    actions: [
      {
        id: 'hold',
        label: 'Hold a state',
        args: ['$state', '$minutes'],
        params: [p('state', 'State', 'enum', { options: [...WEATHER_KINDS, 'rain:0.5', 'snow:0.5'] }), MINUTES()],
        danger: true,
      },
      { id: 'auto', label: 'Back to the schedule', args: ['auto'], danger: true },
      { id: 'wind', label: 'Wind', args: ['wind', '$ms', '$deg'], params: [p('ms', 'Speed (m/s)', 'num', { min: 0, max: 40 }), p('deg', 'Toward (degrees, 0 = east)', 'num', { min: 0, max: 359, optional: true })], danger: true },
      { id: 'wet', label: 'Wet surfaces', args: ['wet', '$wet', '$puddle'], params: [p('wet', 'Wetness (0-1)', 'num', { min: 0, max: 1 }), p('puddle', 'Puddles (0-1)', 'num', { min: 0, max: 1, optional: true })], danger: true },
      { id: 'strike-sky', label: 'Lightning in the sky', args: ['strike', 'sky'], danger: true },
      { id: 'strike-at', label: 'Lightning at a spot', args: ['strike', 'at', '$x', '$z'], params: [p('x', 'X', 'num', { min: -20_000, max: 20_000 }), p('z', 'Z', 'num', { min: -20_000, max: 20_000 })], danger: true },
      { id: 'strike-player', label: 'Lightning on a player', args: ['strike', '$player'], params: [PLAYER()], danger: true },
    ],
  },
  {
    id: 'storm',
    command: 'storm',
    name: 'Storms',
    area: 'world',
    about: 'Storms change everything while they last. Start one (with a forecast first), stop it, or call off a lightning tornado.',
    status: [],
    actions: [
      { id: 'start', label: 'Start a storm', args: ['start', '$minutes', '$forecast'], params: [MINUTES('Minutes'), p('forecast', 'Forecast minutes first', 'num', { min: 0, max: 120, optional: true })], danger: true },
      { id: 'forecast', label: 'Forecast only', args: ['forecast', '$minutes'], params: [MINUTES('Minutes until it hits')], danger: true },
      { id: 'stop', label: 'Stop the storm', args: ['stop'], danger: true },
      { id: 'tornado', label: 'Tornado on a player', args: ['tornado', '$player'], params: [PLAYER()], danger: true },
      { id: 'tornado-stop', label: 'Stop the tornado', args: ['tornado', 'stop'], danger: true },
    ],
  },
  {
    id: 'winter',
    command: 'winter',
    name: 'Snow season',
    area: 'winter',
    about: 'The snow season (Dec 1 to Jan 15): preview the full look for everyone, set the snow cover or the frost, or time-lapse the snow.',
    status: [],
    actions: [
      { id: 'preview-on', label: 'Preview on', args: ['preview', 'on'], danger: true },
      { id: 'preview-off', label: 'Preview off', args: ['preview', 'off'], danger: true },
      { id: 'cover', label: 'Snow cover', args: ['cover', '$v'], params: [p('v', 'Cover (0-1)', 'num', { min: 0, max: 1 })], danger: true },
      { id: 'frost', label: 'Frost', args: ['frost', '$v'], params: [p('v', 'Frost (0-1)', 'num', { min: 0, max: 1 })], danger: true },
      { id: 'speed', label: 'Time-lapse', args: ['speed', '$v'], params: [p('v', 'Speed (1-120)', 'int', { min: 1, max: 120 })], danger: true },
      { id: 'speed-off', label: 'Time-lapse off', args: ['speed', 'off'], danger: true },
    ],
  },
  {
    id: 'wintergame',
    command: 'wintergame',
    name: 'Winter gameplay',
    area: 'winter',
    about: 'Whether the winter layer is on: snowballs, snow spirits, the Ice Yeti, fires and the scoreboard season.',
    status: [],
    actions: [],
  },
  {
    id: 'yeti',
    command: 'yeti',
    name: 'Ice Yeti',
    area: 'winter',
    about: 'The winter world boss: spawn her at a lair (announced), kill or despawn her (silent), or set her timer.',
    status: [],
    actions: [
      { id: 'spawn', label: 'Spawn at a lair', args: ['spawn'], danger: true },
      { id: 'kill', label: 'Kill', args: ['kill'], danger: true },
      { id: 'despawn', label: 'Despawn', args: ['despawn'], danger: true },
      { id: 'timer', label: 'Set the timer', args: ['timer', '$minutes'], params: [MINUTES('Minutes until she spawns', false)] },
      { id: 'timer-now', label: 'Spawn timer: now', args: ['timer', 'now'], danger: true },
    ],
  },
  {
    id: 'snowball',
    command: 'snowball',
    name: 'Snowballs',
    area: 'winter',
    about: 'The snowball fight: a test window where everyone can throw, a player’s stats, or clear the scoreboard.',
    status: [],
    actions: [
      { id: 'test', label: 'Test window', args: ['test', '$seconds'], params: [p('seconds', 'Seconds', 'int', { min: 10, max: 7200, optional: true })], danger: true },
      { id: 'stats', label: 'A player’s stats', args: ['stats', '$player'], params: [PLAYER()] },
      { id: 'reset', label: 'Clear the scoreboard', args: ['reset'], danger: true },
    ],
  },
  {
    id: 'gift',
    command: 'gift',
    name: 'Holiday gifts',
    area: 'winter',
    about: 'Give Holiday Gift Boxes to an online player (right-click opens one).',
    status: null,
    actions: [{ id: 'give', label: 'Give gift boxes', args: ['$count', '$player'], params: [p('count', 'Boxes', 'int', { min: 1, max: 50 }), PLAYER()] }],
  },
  {
    id: 'climb',
    command: 'climb',
    name: 'The Climb',
    area: 'progression',
    about: 'The level cap, the EXP curve and the re-levelled monsters; look up a monster or the EXP of a kill.',
    status: [],
    actions: [
      { id: 'mob', label: 'A monster', args: ['mob', '$code'], params: [p('code', 'Monster code', 'code')] },
      { id: 'exp', label: 'EXP of a kill', args: ['exp', '$player', '$mob'], params: [p('player', 'Player level', 'int', { min: 1, max: 200 }), p('mob', 'Monster level', 'int', { min: 1, max: 200 })] },
      { id: 'gear', label: 'Gear by level', args: ['gear', '$code'], params: [p('code', 'Item code', 'code', { optional: true })] },
    ],
  },
  {
    id: 'penalty',
    command: 'penalty',
    name: 'Death penalty',
    area: 'progression',
    about: 'The Climb death penalty of a player: the grace and the last loss; set or clear the grace.',
    status: null,
    selfless: true,
    actions: [
      { id: 'show', label: 'A player', args: ['$player'], params: [PLAYER()] },
      { id: 'grace', label: 'Set the grace', args: ['grace', '$minutes', '$player'], params: [MINUTES('Minutes', false), PLAYER()] },
      { id: 'clear', label: 'Clear the grace', args: ['clear', '$player'], params: [PLAYER()] },
    ],
  },
  {
    id: 'rarity',
    command: 'rarity',
    name: 'Rare weapons',
    area: 'progression',
    about: 'The drop rates of the Seal of Star, Moon and Sun weapons.',
    status: ['rates'],
    selfless: true,
    actions: [],
  },
  {
    id: 'guilds',
    command: 'guilds',
    name: 'Guilds',
    area: 'social',
    about: 'Every guild: look one up, rename it, disband it, or expel a member.',
    status: ['list'],
    actions: [
      { id: 'info', label: 'Guild info', args: ['info', '$guild'], params: [p('guild', 'Guild', 'name')] },
      { id: 'rename', label: 'Rename', args: ['rename', '$guild', '$to'], params: [p('guild', 'Guild', 'name'), p('to', 'New name', 'name')], danger: true },
      { id: 'disband', label: 'Disband', args: ['disband', '$guild'], params: [p('guild', 'Guild', 'name')], danger: true },
      { id: 'kick', label: 'Expel a member', args: ['kick', '$guild', '$player'], params: [p('guild', 'Guild', 'name'), PLAYER()], danger: true },
    ],
  },
]

const BY_ID = new Map(OPS_FEATURES.map((f) => [f.id, f]))
const NAME = /^[\p{L}\p{N}_-]{1,32}$/u
const TIME = /^([01]?\d|2[0-3]):[0-5]\d$/
const PREFIX = '/api/admin/ops'

function err(status: number, message: string): AdminGroupResponse {
  const code = status === 404 ? 'not_found' : status === 403 ? 'forbidden' : status === 422 ? 'refused' : 'bad_request'
  return { status, body: { error: code, message } }
}

/** One parameter as exactly one argument, or an error message. */
export function opsArg(param: OpsParam, raw: unknown): string | { error: string } {
  const bad = (why: string) => ({ error: `${param.label}: ${why}` })
  if (param.kind === 'int' || param.kind === 'num') {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
    if (!Number.isFinite(n)) return bad('a number is needed')
    if (param.kind === 'int' && !Number.isInteger(n)) return bad('a whole number is needed')
    if ((param.min !== undefined && n < param.min) || (param.max !== undefined && n > param.max)) return bad(`from ${param.min} to ${param.max}`)
    return String(n)
  }
  if (typeof raw !== 'string') return bad('text is needed')
  const s = raw.trim()
  if (param.kind === 'enum') return param.options?.includes(s) ? s : bad(`one of ${param.options?.join(', ')}`)
  if (param.kind === 'name') return NAME.test(s) ? s : bad('letters, digits, _ and - only (at most 32)')
  if (param.kind === 'code') return CODE_NAME.test(s.toUpperCase()) ? s.toUpperCase() : bad('not a content code')
  return TIME.test(s) ? s : bad('hh:mm')
}

/** The arguments of an action from the admin's params (an optional parameter left empty drops the rest). */
export function opsArgs(action: OpsAction, params: Record<string, unknown>): string[] | { error: string } {
  const out: string[] = []
  const known = new Set((action.params ?? []).map((x) => x.name))
  for (const k of Object.keys(params)) if (!known.has(k)) return { error: `unknown parameter ${k}` }
  for (const a of action.args) {
    if (!a.startsWith('$')) {
      out.push(a)
      continue
    }
    const param = action.params!.find((x) => x.name === a.slice(1))!
    const raw = params[param.name]
    if (raw === undefined || raw === null || raw === '') {
      if (param.optional) break
      return { error: `${param.label} is needed` }
    }
    const v = opsArg(param, raw)
    if (typeof v !== 'string') return v
    out.push(v)
  }
  return out
}

/** Runs a GM command for the panel (no character, no connection: only commands that need neither are listed). */
function run(ctx: GameContext, feature: OpsFeature, args: string[]): GmResult {
  const cmd = COMMANDS[feature.command]
  if (!cmd || (cmd.world && !feature.selfless)) return { ok: false, message: `${feature.command} is not available here.` }
  try {
    return cmd.run({ ctx, conn: null as unknown as Connection, role: 'admin', args, self: null })
  } catch (e) {
    ctx.config.log(`admin ops ${feature.command} failed: ${(e as Error).stack ?? e}`)
    return { ok: false, message: 'internal error' }
  }
}

function view(ctx: GameContext, f: OpsFeature): OpsFeatureView {
  const { status, ...rest } = f
  const r = status ? run(ctx, f, status) : { ok: true, message: 'Pick a character with the actions below.' }
  return { ...rest, state: { ok: r.ok, message: r.message } }
}

/** The handler of `/api/admin/ops/*`. */
export function routeAdminOps(ctx: GameContext, req: AdminGroupRequest): AdminGroupResponse {
  if (req.actor.role !== 'admin') return err(403, 'admin accounts only')
  const sub = req.path.slice(PREFIX.length).replace(/^\//, '')
  if (req.method === 'GET' && sub === '') return { status: 200, body: { features: OPS_FEATURES.map((f) => view(ctx, f)) } }
  const f = BY_ID.get(sub)
  if (!f) return err(404, 'no such feature')
  if (req.method === 'GET') return { status: 200, body: view(ctx, f) }
  if (req.method !== 'POST') return err(404, 'no such route')
  const b = req.body
  if (!b || typeof b !== 'object' || Array.isArray(b)) return err(400, 'a JSON object is needed')
  const { action: actionId, params = {}, ...rest } = b as Record<string, unknown>
  if (Object.keys(rest).length) return err(400, `unknown field ${Object.keys(rest)[0]}`)
  const action = f.actions.find((a) => a.id === actionId)
  if (!action) return err(400, `unknown action for ${f.id}`)
  if (!params || typeof params !== 'object' || Array.isArray(params)) return err(400, 'params must be an object')
  const args = opsArgs(action, params as Record<string, unknown>)
  if (!Array.isArray(args)) return err(400, args.error)
  const r = run(ctx, f, args)
  ctx.store.audit({ accountId: req.actor.accountId, characterId: null, command: f.command, args, result: `admin: ${r.message}`.slice(0, 2000), ok: r.ok })
  if (r.ok) ctx.config.log(`admin ${req.actor.username}: ${f.command} ${args.join(' ')} -> ${r.message.split('\n')[0]}`)
  return { status: r.ok ? 200 : 422, body: r.ok ? r : { error: 'refused', message: r.message } }
}

let registered = false
export function registerOpsAdmin(): void {
  if (registered) return
  registered = true
  registerAdminRouteGroup({ prefix: 'ops', handle: routeAdminOps })
}
