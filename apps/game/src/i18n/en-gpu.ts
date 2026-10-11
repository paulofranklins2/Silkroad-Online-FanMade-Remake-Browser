/**
 * English strings of the graphics recovery: device loss (gpu-loss.ts), black output (gpu-watchdog.ts), the "3D view is
 * black" help (gpu-help.ts), and the WebGPU-required page and software-adapter warning (gpu-help.ts). Spread into en.ts.
 */
export const enGpu = {
  'gpu.reloading': 'The graphics device stopped responding (a driver reset or out of video memory). Reloading the game; you will be back where you were in a few seconds.',
  'gpu.stopped': 'The graphics device keeps failing. Close other tabs that use the GPU or update the graphics driver, then reload.',
  'gpu.reload': 'Reload',
  'gpu.restored': 'The graphics device was reset, so the game reloaded. You are back where you were.',
  'gpu.reloaded': 'The game reloaded. You are back where you were.',
  // The "3D view is black" help (gpu-help.ts).
  'gpu.help.title': 'The 3D view is black',
  'gpu.help.intro': 'If the 3D view stays black while windows and text still show, the browser has stopped showing 3D content. This happens after its graphics process crashed, for example when the computer ran low on memory with other graphics-heavy programs open. The game itself is fine.',
  'gpu.help.detected': 'The browser has stopped showing the game\'s 3D picture. This happens after its graphics process crashed, for example when the computer ran low on memory with other graphics-heavy programs open. The game itself is fine.',
  'gpu.help.fixBrowser': 'Fix 1: open the game in another browser, such as Microsoft Edge.',
  'gpu.help.fixGpuProcess': 'Fix 2 (Chrome): press Shift+Esc to open Chrome\'s Task Manager, select "GPU Process", click "End process", then reload this page. Your other tabs stay open.',
  'gpu.help.close': 'Close',
  'gpu.help.link': 'Screen black?',
  'menu.blackScreen': 'Screen black?',
  // The game needs WebGPU (gpu-help.ts showWebGpuRequired; engine.ts WebGpuUnavailableError).
  'gpu.need.title': 'This game needs WebGPU',
  'gpu.need.missing': 'Your browser does not offer WebGPU, the graphics technology the game draws its 3D world with.',
  'gpu.need.noAdapter': 'Your browser supports WebGPU but could not use your graphics card (it may be blocked by the browser, or hardware acceleration is turned off).',
  'gpu.need.failed': 'Your browser could not start WebGPU on your graphics card.',
  'gpu.need.fixBrowser': 'Fix 1: use an up-to-date Chrome or Microsoft Edge (version 113 or newer) or Firefox (version 141 or newer on Windows). Update the browser and restart it.',
  'gpu.need.fixDriver': 'Fix 2: update your graphics driver from your graphics card maker (NVIDIA, AMD or Intel), then restart the computer.',
  'gpu.need.fixAcceleration': 'Fix 3: turn hardware acceleration on in the browser settings (Chrome and Edge: Settings → System → "Use graphics acceleration when available"), then restart the browser.',
  // A software WebGPU adapter (gpu-help.ts showSoftwareGpuWarning).
  'gpu.software.title': 'No graphics card in use',
  'gpu.software.text': 'The browser is drawing the game without your graphics card (software rendering), so it will run very slowly.',
  // Running on the processor's graphics (gpu-help.ts showIntegratedGpuNotice; gpu-integrated.ts).
  'gpu.igpu.title': 'The game is using your processor\'s graphics',
  'gpu.igpu.text': 'Your browser draws the game with {gpu}, the graphics built into the processor. If this PC also has a graphics card, the game runs much faster on it.',
  'gpu.igpu.fix': 'To switch: open Windows Settings → System → Display → Graphics, find your browser (Chrome or Edge; add it with "Browse" if it is not listed), choose Options → High performance, and save.',
  'gpu.igpu.restart': 'Then close every browser window and open the game again.',
  'gpu.igpu.dontShow': 'Don\'t show again',
} satisfies Record<string, string>
