import { App } from './app.ts'
import { GameAudio, setGameAudio } from './audio/index.ts'
import { installUiSounds } from './audio/ui-sounds.ts'
import { loadCatalog } from './content/catalog.ts'
import { createEngine, WebGpuUnavailableError, type EngineResult } from './engine.ts'
import { showIntegratedGpuNotice, showSoftwareGpuWarning, showWebGpuRequired } from './gpu-help.ts'
import { IGPU_DISMISSED_KEY, IGPU_SHOWN_KEY, browserGpuName, igpuNotice } from './gpu-integrated.ts'
import { installGpuLossGuard } from './gpu-loss.ts'
import { installBlackWatchdog } from './gpu-watchdog.ts'
import { resumeSession } from './net/resume.ts'
import { createTransport } from './net/transport.ts'
import { readParams } from './params.ts'
import { charCreateScreen } from './screens/charcreate.ts'
import { creatorScreen } from './screens/creator.ts'
import { charSelectScreen } from './screens/charselect.ts'
import { loginScreen } from './screens/login.ts'
import { serversScreen } from './screens/servers.ts'
import { splashScreen } from './screens/splash.ts'
import { worldScreen } from './screens/world.ts'
import { applyGraphics, settings } from './settings.ts'
import { TEXTURE_SHARE, registerTextureShare } from './three/gltf-texture-share.ts'
import { PERF } from './world/perf.ts'
import { loadGameText, t } from './i18n/index.ts'
import { Art } from './ui/art.ts'
import { el } from './ui/dom.ts'
import { loadFonts } from './ui/fonts.ts'

async function main(): Promise<void> {
  const params = readParams()
  const boot = el('div', 'boot', t('boot.loading'))
  document.body.append(boot)

  const canvas = document.getElementById('canvas') as HTMLCanvasElement
  // WebGPU only (Overall Pass item 0): without it the game shows what to fix instead of starting (gpu-help.ts).
  const [made, catalog, art] = await Promise.all([createEngine(canvas).catch((err: unknown) => ({ err })), loadCatalog(), Art.load(), loadGameText()])
  if ('err' in made) {
    const err = made.err
    boot.remove()
    console.error('[engine] WebGPU unavailable:', err)
    showWebGpuRequired(err instanceof WebGpuUnavailableError ? err.reason : 'failed', err instanceof Error ? err.message : String(err))
    return
  }
  const engineResult: EngineResult = made
  // Options → Graphics → Resolution (UX_GAPS R4), now and on every change.
  applyGraphics(engineResult.engine)
  // The licensed characters' textures: shared by content, 1024² on Medium and below (three/gltf-texture-share.ts).
  registerTextureShare()
  const textureSize = () => {
    TEXTURE_SHARE.enabled = PERF.licensedTextureShare
    const preset = settings.get().graphics.preset
    TEXTURE_SHARE.maxSize = preset === 'high' || preset === 'ultra' ? Infinity : 1024
  }
  textureSize()
  settings.onChange(textureSize)
  const fonts = await loadFonts(art.manifest)
  if (engineResult.software) {
    console.warn('[engine] WebGPU runs on a software adapter: no graphics card in use')
    showSoftwareGpuWarning(art)
  } else {
    // The processor's graphics while a graphics card may be there (gpu-integrated.ts): how to switch, once per session
    // on a likely dual-GPU PC until "Don't show again", once ever otherwise.
    const gpuName = browserGpuName()
    const store = (f: () => Storage) => {
      try {
        return f()
      } catch {
        return null
      }
    }
    const local = store(() => localStorage)
    const session = store(() => sessionStorage)
    const n = igpuNotice(gpuName, local, session)
    if (n.show) {
      console.info(`[engine] running on integrated graphics: ${gpuName}`)
      try {
        session?.setItem(IGPU_SHOWN_KEY, '1')
        if (!n.likelyDual) local?.setItem(IGPU_DISMISSED_KEY, '1')
      } catch {}
      showIntegratedGpuNotice(art, gpuName, () => {
        try {
          local?.setItem(IGPU_DISMISSED_KEY, '1')
        } catch {}
      })
    }
  }
  console.info(`[engine] ${engineResult.kind}; characters from ${catalog.source} (${catalog.characters.length}); ui art ${art.manifest ? 'loaded' : 'missing'}; fonts ${Object.entries(fonts).map(([k, ok]) => `${k}:${ok ? 'ok' : 'fallback'}`).join(' ')}`)

  // Sound (docs/SOUND.md §5): music, effects and their settings; `?mute=1` mutes this page only.
  const audio = GameAudio.create({ muted: params.mute, itemDef: code => catalog.item(code) })
  setGameAudio(audio)
  installUiSounds(cue => audio.ui(cue))
  const transport = createTransport(params.mock, params.gm)
  const app = new App(engineResult.engine, engineResult.kind, params, transport, catalog, art, audio.music!, audio)
  // A lost graphics device reloads straight back into the world instead of leaving it black (gpu-loss.ts).
  const gpuGuard = installGpuLossGuard(app, engineResult.kind)
  // A 3D view that renders nothing without a loss: the help (gpu-watchdog.ts).
  installBlackWatchdog(app.engine, detail => gpuGuard.blackOutput(detail))
  app.register('splash', splashScreen)
  app.register('login', loginScreen)
  app.register('servers', serversScreen)
  app.register('charselect', charSelectScreen)
  app.register('charcreate', charCreateScreen)
  app.register('creator', creatorScreen)
  app.register('world', worldScreen)

  // The corner: the master mute (localStorage['sro.muted']). The engine name is in the world's stats line and the log.
  const corner = el('div', 'corner')
  const mute = el('button', 'mute-button')
  mute.type = 'button'
  mute.title = t('corner.soundTitle')
  mute.dataset.sfx = 'none'
  const setMuteLabel = (m: boolean) => {
    mute.textContent = m ? t('corner.soundOff') : t('corner.soundOn')
    mute.classList.toggle('muted', m)
  }
  setMuteLabel(audio.settings.muted)
  audio.settings.onChange((_, m) => setMuteLabel(m))
  mute.addEventListener('click', () => audio.settings.toggleMuted())
  corner.append(mute)
  document.body.append(corner)

  // ?kit=1: the UI kit gallery (dev only, docs/UI.md §9.1 UI-K) instead of the game.
  if (params.kit) {
    boot.remove()
    const { showKitGallery } = await import('./ui/kit/gallery.ts')
    return showKitGallery(app)
  }

  if (params.fxlab) await import('./debug/fx-lab.ts').then(m => m.installFxLab(app), err => console.error('[fxlab] failed to load', err))
  if (params.charbench || params.bench) await import('./debug/charbench.ts').then(m => m.installCharBench(app), err => console.error('[charbench] failed to load', err))
  if (params.rarelab) await import('./debug/rarity-lab.ts').then(m => m.installRarityLab(app), err => console.error('[rarelab] failed to load', err))
  // A refresh keeps you logged in: the tab's saved token goes straight to character select (UX_GAPS L1).
  const resumed = await resumeSession(app).catch(err => {
    console.warn('[resume] failed', err)
    return false
  })
  boot.remove()
  if (resumed) return
  await app.go(params.skipSplash ? 'login' : 'splash')
}

main().catch(err => {
  console.error(err)
  document.body.append(el('pre', 'fatal', t('boot.failed', { error: err instanceof Error ? err.stack ?? err.message : String(err) })))
})
