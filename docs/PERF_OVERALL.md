# Overall Pass: the walking / camera-turn stutter (2026-10-10)

The report: "the game stutters when walking and turning the camera, even on WebGPU, at any graphics setting incl.
Ultra." Stutter is spikes, not the average, so this pass measures every frame of a fixed route and asks what ran in
the slow ones. (Item 0 of the pass, same day: the game is WebGPU only; engine.ts, gpu-loss.ts, gpu-help.ts.)

**Answer: the spikes are the GPU process compiling render pipelines, not our JavaScript.** Walking and turning bring
meshes with materials not drawn before (streamed regions, characters, plants) into view; Babylon 9.28 makes each new
WebGPU render pipeline at its first draw with the synchronous `createRenderPipeline`, Chrome compiles it (WGSL → HLSL
→ DXIL → driver PSO) on the GPU process's main thread, and the frame waits 100–470 ms. On the route, 29 of the 39
frames over 33 ms came in the 3 frames after (or with) a new pipeline, with only 15–40 ms of JS in them. Fixed: in play
those pipelines are made in the background and the draw waits a frame or two (`PERF.pipelinesInPlay`).

## Method

`pnpm charbench --route [--alloc] --bots 8 --configs webgpu-medium` (apps/server/src/cli/charbench.ts; the page is
`?bench=1`, apps/game/src/debug/route-bench.ts + frame-probe.ts; zero cost when off: the probe wraps methods in place
only on a bench page). The route: noon, clear weather held, the bench character at the Jangan plaza; 6 s standing
with the camera orbiting 90°/s; the walk out of Jangan to the Grassland place (≈ 330 m as 30 m waypoints, the server's
path; a blocked waypoint is reached by a GM hop and counted) with the camera orbiting 30°/s; 6 s orbiting in the
grass; then the grass drawn / hidden, interleaved (uncapped frames). Headless Chrome on the real GPU (RX 9060 XT),
1920 × 1080, DPR 1, production build without minification, the display's own frame pacing (headless paces at ≈ 30 Hz,
so the frame p50 of ≈ 31 ms is the pacing; the CPU part and the spikes are the measure).

Per frame the probe records: Babylon's phases (`bjs.animations`, `bjs.activeMeshes`, `bjs.renderTargets(shadows)`,
`bjs.mainDraw`, `bjs.post`, `bjs.endFrame(submit)`), the world screen's frame (`game.frame` ⊃ `entities.*`, `effects`,
`world.update` ⊃ `world.<part>`, `stream.*`, `grass.*`; `minimap`, `feature.<name>`, `graphics.frame`, `crowd.*`), every
other scene observer by its first source line, the network handler per message type (`net.<t>`, between frames:
`outside.*`), new WebGPU pipelines and bind groups, the JS heap; the browser's long animation frames (LoAF, with script
attribution and style/layout) and long tasks; `--alloc` adds V8's sampling heap profile of the run (top allocators).

The PC was shared with four other helpers' benches and builds: two runs died of a lost device (D3D12 out of memory,
1 GB free RAM) and one ran at 99 % machine CPU (all costs ≈ 2×). The numbers below are from runs at ≈ 20 % machine
CPU; each run's JSON has its machine CPU and free RAM (`work/tmp/routebench/<run>/`).

## Where the time goes (before the fix; WebGPU Medium, 8 bots, 2082 frames)

Ranked by time in the frames over 33 ms (the stutter), then the mean (ms per frame):

| # | System | mean | p95 | max | in spike frames | Notes |
|---|---|---|---|---|---|---|
| 1 | **GPU-process pipeline compiles** (not JS) | – | – | 469 | 29 of 39 spikes | 55 new pipelines on the route; spike frames hold 15–40 ms of JS |
| 2 | `bjs.mainDraw` (draw submission) | 4.18 | 8.9 | 94 | 366 | Babylon's per-draw CPU, ≈ 300 draws |
| 3 | `net.despawn` (between frames) | – | 21.8 | 94–131 | 160 | one despawn now and then; not Babylon's disposal (mesh/node disposes ≤ 1.8 ms) |
| 4 | `bjs.activeMeshes` | 2.26 | 3.7 | 8.8 | 155 | |
| 5 | `game.frame` | 1.5 | 3.0 | 8.4 | 123 | world.update 0.65, entities 0.22, skills 0.14, crowd 0.11 |
| 6 | `bjs.animations` | 0.87 | 1.6 | 5.7 | 68 | |
| 7 | `bjs.renderTargets(shadows)` | 0.59 | 0.9 | 2.8 | 35 | one 91 ms frame in a 20-bot run (a shadow effect compiling) |
| 8 | grass (`world.scatter` ⊃ `grass.*`) | 0.31 | 1.6 | 3.8 | 15 | see below |
| 9 | stream (`stream.*`) | 0.05 | 0.1 | 5.4 | 11 | one job can overrun the 4 ms budget (11.6 ms seen) |
| 10 | crowd plan / outfit merge | 0.1 | 2.6 | 5.5 | 18 | 20 bots: `crowd.plan` 28 ms, `actor.setOutfitMerge` 19 ms max |

GPU frame time p50 2.2 / p95 3.1 ms: the GPU itself is never the limit. Style and layout in long frames < 1.3 ms; long
tasks 9 (max 101 ms).

**Garbage**: ≈ 3.3 GB freed in 68 s (≈ 49 MB/s; 102 heap drops), heap ≈ 2 GB. Sampled allocations: the licensed
body's clip retarget ≈ 30 % (three/retarget.ts `qmul`, `pose`, `worldOf`; 13 % of everything was the iterators of
`qmul`'s array destructuring), Babylon's shader preprocessing ≈ 25 % (effects compiled while walking: `ProcessIncludes`,
the PBR material's defines), the grass bake ≈ 4 %.

**Grass** (asked precisely; no redesign here): CPU per frame mean 0.31 ms, p95 1.6, max 3.8 (`grass.update` 0.30,
`grass.bakeSlice` 0.19 mean / 3.4 max, ring update / upload ≤ 1 ms); under the 20-bot run on a loaded machine one
`grass.bakeSlice` took 37 ms. GPU: drawn 2.00 ms vs hidden 1.95 ms a frame in the fields view (≈ 0.05 ms, Medium, noon);
the CPU frame with / without the grass meshes is within noise (5.3–5.9 vs 5.6–5.7 ms). Grass is not the stutter.

## Fixed

| Fix | Files | Switch |
|---|---|---|
| In play, a mesh draw whose WebGPU pipeline is missing has it made with `createRenderPipelineAsync` (Dawn's worker threads) and is skipped until it is: the mesh appears a frame or two later instead of the frame waiting for the GPU process. Mesh draws only (main pass, shadow maps, prepasses); full-screen passes draw as before. The warm-up's session machinery (P-STALL), now on for play too. | apps/game/src/screens/pipelines.ts | `PERF.pipelinesInPlay` |
| Quaternion multiply without array destructuring (the retarget's iterator garbage, 13 % of all allocations) | three/retarget.ts, three/retarget-clips.ts | – |

## Before / after

AFTER_TABLE

## Plan (not done here)

1. **Despawn hitch (94–131 ms)**: the handler's time is not Babylon's disposal; next step is the probe on
   `features.onEntityRemoved` per feature and `EntityView.die` / `beginFade` to find it, then defer the work.
2. **Effects compiled in play** (25 % of the garbage, 5–40 ms each on the main thread): extend the warm-up's shader
   stage to the materials streamed regions bring (a per-region `isReady(true)` pass in the streamer's idle budget).
3. **Retarget on the main thread** (30 % of the garbage): run `retargetClip` in a worker, or cache the rebuilt clips
   per body file in IndexedDB.
4. **Stream jobs over budget** (one job up to 11.6 ms against 4 ms): split the largest commit steps.
5. **Crowd plan / outfit merge bursts** (28 / 19 ms with 20 bots): spread a plan's merges over frames.
6. **Draw submission** (`bjs.mainDraw` 4–9 ms, Babylon's WebGPU per-draw cost): fewer draws (batching, docs/BATCHING.md)
   or render bundles (Babylon's snapshot rendering) for the static world.
