/**
 * The "running on the integrated GPU" notice (Overall Pass round 6, docs/PERF_OVERALL.md): Chrome and Edge on Windows
 * ignore WebGPU's high-performance request and use the GPU Windows assigns them, so a PC with a graphics card can run
 * the game on the processor's graphics at a fraction of the speed (the bench itself did, after a reboot).
 *
 * The browser does not say whether a second GPU exists, so the notice follows how likely one is:
 * - a desktop processor's minimal graphics ("AMD Radeon(TM) Graphics", Intel UHD): such PCs almost always have a card,
 *   so the notice comes once per session until the player chooses "Don't show again";
 * - other integrated graphics (laptop APUs, Iris Xe, Vega): often the only GPU, so it comes once ever.
 * The adapter's name comes from WebGL2's renderer string (Chrome's WebGPU adapter leaves the description empty; both
 * use the same GPU).
 */
import { isIntegratedGpu } from './settings.ts'

/** localStorage: the player chose "Don't show again" (or a likely single-GPU PC saw it once). */
export const IGPU_DISMISSED_KEY = 'sro.igpu.dismissed'
/** sessionStorage: shown in this tab session already. */
export const IGPU_SHOWN_KEY = 'sro.igpu.shown'

/** A desktop processor's minimal graphics: a graphics card is likely present. */
const LIKELY_DUAL = /radeon\(tm\)\s+graphics|intel.*\buhd\b/i

/** The renderer string of the GPU the browser uses (WebGL2's unmasked renderer), '' when unavailable. */
export function browserGpuName(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    const name = gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : ''
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
    return name
  } catch {
    return ''
  }
}

export interface IgpuDecision {
  show: boolean
  /** A likely dual-GPU PC (the notice may come again next session). */
  likelyDual: boolean
}

/** Whether to show the notice for this GPU name, given what the storages remember. */
export function igpuNotice(name: string, local: Pick<Storage, 'getItem'> | null, session: Pick<Storage, 'getItem'> | null): IgpuDecision {
  const lower = name.toLowerCase()
  const integrated = !!lower && (isIntegratedGpu({ vendor: '', architecture: '', description: lower }) || (lower.includes('intel') && !/\barc\b/.test(lower)))
  const likelyDual = LIKELY_DUAL.test(name)
  let dismissed = false
  let shown = false
  try {
    dismissed = local?.getItem(IGPU_DISMISSED_KEY) === '1'
    shown = session?.getItem(IGPU_SHOWN_KEY) === '1'
  } catch {
    // storage blocked: show it (once per load)
  }
  return { show: integrated && !dismissed && !shown, likelyDual }
}
