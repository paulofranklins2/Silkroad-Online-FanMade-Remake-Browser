/**
 * The "3D view is black" help (the 2026-10-05 incident, second part): after Chrome's GPU process crashed (low RAM with
 * other GPU-heavy programs open), Chrome runs its renderers with software compositing, and then both WebGPU and WebGL2
 * canvases can stay black on screen while the page sees nothing wrong (the real adapter, no errors, no lost device).
 * The game cannot repair the browser; this panel says what can: another browser (Edge), or ending Chrome's GPU process
 * in its task manager (Shift+Esc) and reloading, which keeps the other tabs open.
 *
 * Shown by gpu-loss.ts when the watchdog sees black output that switching cannot fix, and on request (Esc menu →
 * "Screen black?", the login screen's link). Non-blocking: a panel over the canvas, the HUD stays usable. One at a time.
 */
import type { WebGpuFailure } from './engine.ts'
import { t } from './i18n/index.ts'
import type { Art } from './ui/art.ts'
import { el } from './ui/dom.ts'
import { button } from './ui/kit/button.ts'

export interface GpuHelpOptions {
  /** The watchdog saw it (the text says so); false: the player opened the help. */
  detected: boolean
  /** Reloads the page (back into the world when there). */
  reload(): void
}

let open: HTMLElement | null = null

/** Shows the help (replacing an open one); returns its close function. */
export function showGpuHelp(art: Art, o: GpuHelpOptions): () => void {
  closeGpuHelp()
  const box = el('div', 'gpu-notice gpu-help')
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-label', t('gpu.help.title'))
  const close = () => {
    box.remove()
    if (open === box) open = null
  }
  const buttons = el('div', 'gpu-help-buttons')
  buttons.append(button(art, { label: t('gpu.reload'), primary: true }, () => o.reload()), button(art, { label: t('gpu.help.close') }, close))
  box.append(
    el('div', 'gpu-help-title', t('gpu.help.title')),
    el('p', '', t(o.detected ? 'gpu.help.detected' : 'gpu.help.intro')),
    el('p', '', t('gpu.help.fixBrowser')),
    el('p', '', t('gpu.help.fixGpuProcess')),
    buttons,
  )
  document.body.append(box)
  open = box
  return close
}

/** Closes the open help, if any. */
export function closeGpuHelp(): void {
  open?.remove()
  open = null
}

/**
 * The game needs WebGPU (Overall Pass item 0: no WebGL2 fallback): a full-screen page instead of the game when the
 * browser has no WebGPU, finds no adapter, or the device fails (engine.ts WebGpuUnavailableError). Plain DOM (the UI
 * art may not be loaded): what is wrong and how to fix it, a Reload button, and the technical detail.
 */
export function showWebGpuRequired(reason: WebGpuFailure, detail: string): HTMLElement {
  const box = el('div', 'gpu-notice gpu-help gpu-required')
  box.setAttribute('role', 'alert')
  // full screen over the (empty) canvas and the boot text: nothing else can run
  Object.assign(box.style, { inset: '0', top: '0', left: '0', transform: 'none', maxWidth: 'none', maxHeight: 'none', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', zIndex: '100', borderRadius: '0', background: 'rgb(14, 11, 7)' })
  const reload = el('button', '', t('gpu.reload'))
  reload.type = 'button'
  reload.addEventListener('click', () => location.reload())
  const buttons = el('div', 'gpu-help-buttons')
  buttons.append(reload)
  box.append(
    el('div', 'gpu-help-title', t('gpu.need.title')),
    el('p', '', t(reason === 'missing' ? 'gpu.need.missing' : reason === 'no-adapter' ? 'gpu.need.noAdapter' : 'gpu.need.failed')),
    el('p', '', t('gpu.need.fixBrowser')),
    el('p', '', t('gpu.need.fixDriver')),
    el('p', '', t('gpu.need.fixAcceleration')),
    buttons,
    el('p', 'gpu-required-detail', detail),
  )
  for (const c of box.children) Object.assign((c as HTMLElement).style, { maxWidth: '560px', width: '100%' })
  ;(box.lastElementChild as HTMLElement).style.opacity = '0.6'
  document.body.append(box)
  return box
}

/** A software WebGPU adapter (no real GPU): the game runs, very slowly; this says so and how to fix it. Closable. */
export function showSoftwareGpuWarning(art: Art): () => void {
  const box = el('div', 'gpu-notice gpu-help gpu-software')
  box.setAttribute('role', 'status')
  const close = () => box.remove()
  const buttons = el('div', 'gpu-help-buttons')
  buttons.append(button(art, { label: t('gpu.help.close'), primary: true }, close))
  box.append(el('div', 'gpu-help-title', t('gpu.software.title')), el('p', '', t('gpu.software.text')), el('p', '', t('gpu.need.fixDriver')), el('p', '', t('gpu.need.fixAcceleration')), buttons)
  document.body.append(box)
  return close
}

/**
 * The integrated-GPU notice (gpu-integrated.ts): the game runs on the processor's graphics; how to switch the browser to
 * the graphics card. `dontShow` remembers the choice for good; Close hides it for this session.
 */
export function showIntegratedGpuNotice(art: Art, gpuName: string, dontShow: () => void): () => void {
  const box = el('div', 'gpu-notice gpu-help gpu-integrated')
  box.setAttribute('role', 'status')
  const close = () => box.remove()
  const buttons = el('div', 'gpu-help-buttons')
  buttons.append(
    button(art, { label: t('gpu.igpu.dontShow') }, () => {
      dontShow()
      close()
    }),
    button(art, { label: t('gpu.help.close'), primary: true }, close),
  )
  box.append(el('div', 'gpu-help-title', t('gpu.igpu.title')), el('p', '', t('gpu.igpu.text', { gpu: gpuName })), el('p', '', t('gpu.igpu.fix')), el('p', '', t('gpu.igpu.restart')), buttons)
  document.body.append(box)
  return close
}
