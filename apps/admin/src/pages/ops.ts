import { get, post } from '../api.ts'
import { svgIcon, type IconName } from '../icons.ts'
import { badge, button, clear, confirmDialog, emptyState, errorText, formDialog, h, pageHeader, toast, type Field } from '../ui.ts'

/**
 * Live operations (docs/ADMIN.md §3.2): the server's `ops` route group lists GM features that run without a character
 * (world clock, weather, storms, the snow season, the Ice Yeti, snowballs, gifts, the Climb, the death penalty, rare
 * weapons, guilds), each with its status and fixed actions with typed parameters. This page renders any subset of them
 * as cards: the status (the command's reply) and one button per action (a form when it takes parameters).
 */

interface OpsParam {
  name: string
  label: string
  kind: 'int' | 'num' | 'enum' | 'name' | 'code' | 'time'
  min?: number
  max?: number
  options?: string[]
  optional?: boolean
  hint?: string
}
interface OpsAction {
  id: string
  label: string
  args: string[]
  params?: OpsParam[]
  danger?: boolean
}
interface OpsFeature {
  id: string
  command: string
  name: string
  area: string
  about: string
  actions: OpsAction[]
  state: { ok: boolean; message: string }
}

function field(p: OpsParam): Field {
  const f: Field = { name: p.name, label: p.optional ? `${p.label} (optional)` : p.label, required: !p.optional, hint: p.hint }
  if (p.kind === 'enum') return { ...f, type: 'select', options: (p.options ?? []).map((o) => ({ value: o, label: o })) }
  if (p.kind === 'int' || p.kind === 'num') return { ...f, type: 'number', min: p.min, max: p.max, step: p.kind === 'int' ? 1 : 'any' }
  if (p.kind === 'time') return { ...f, placeholder: '06:30', maxlength: 5 }
  return { ...f, maxlength: p.kind === 'code' ? 128 : 32, placeholder: p.kind === 'code' ? 'MOB_CH_...' : '' }
}

function featureCard(f: OpsFeature, reload: () => void): HTMLElement {
  const run = async (a: OpsAction, params: Record<string, string | number | boolean>) => {
    const clean: Record<string, string | number> = {}
    for (const [k, v] of Object.entries(params)) if (v !== '' && typeof v !== 'boolean' && !(typeof v === 'number' && Number.isNaN(v))) clean[k] = v
    const r = await post<{ ok: boolean; message: string }>(`ops/${f.id}`, { action: a.id, params: clean })
    toast(r.message.split('\n')[0] || 'Done.', 'ok')
    reload()
  }
  const act = async (a: OpsAction) => {
    try {
      if (a.params?.length) {
        await formDialog({ title: `${f.name}: ${a.label}`, fields: a.params.map(field), submit: a.label, danger: a.danger, onSubmit: (v) => run(a, v) })
      } else if (!a.danger || (await confirmDialog({ title: `${f.name}: ${a.label}`, message: `${a.label} now? Players see it at once.`, confirm: a.label, danger: true }))) {
        await run(a, {})
      }
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }
  const actions = f.actions.map((a) => {
    const b = button(a.label, () => void act(a), a.danger ? 'plain' : 'small')
    b.classList.add('btn-small')
    return b
  })
  return h(
    'section',
    { class: 'card ops-card', id: `ops-${f.id}` },
    h('div', { class: 'card-head' }, h('h3', { class: 'card-title' }, f.name), h('div', { class: 'card-aside' }, badge(f.state.ok ? 'ready' : 'unavailable', f.state.ok ? 'ok' : 'bad'), h('code', { class: 'ops-cmd' }, `/${f.command}`))),
    h('p', { class: 'muted ops-about' }, f.about),
    h('pre', { class: 'ops-status' }, f.state.message),
    actions.length ? h('div', { class: 'actions ops-actions' }, actions) : null,
  )
}

/** A page with the cards of `ids` (in that order). */
export function opsPage(title: string, sub: string, icon: IconName, ids: string[]) {
  return (root: HTMLElement): (() => void) => {
    const body = h('div', { class: 'ops-grid' })
    const refresh = button('Refresh', () => void load(), 'small')
    root.append(pageHeader({ text: title, icon: svgIcon(icon) }, sub, refresh), body)
    let alive = true
    const load = async () => {
      try {
        const { features } = await get<{ features: OpsFeature[] }>('ops')
        if (!alive) return
        const mine = ids.map((id) => features.find((f) => f.id === id)).filter((f): f is OpsFeature => !!f)
        clear(body, mine.length ? mine.map((f) => featureCard(f, () => void load())) : emptyState('This server has none of these features yet.'))
      } catch (e) {
        if (alive) clear(body, emptyState(`${errorText(e)}\n(An older server without the live operations API?)`, 'alert', true))
      }
    }
    void load()
    const timer = setInterval(() => void load(), 15_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }
}
