# YT Boost for Orion

A quality-and-speed extension for **YouTube on Orion (iOS/iPadOS)**, tuned for the
iPhone 13 (2532×1170, 60 Hz, A15). It changes how YouTube web *behaves* — it removes
nothing (Shorts, feeds, and all features stay exactly as YouTube ships them).

## What it does

| Module | On by default | Effect |
|---|---|---|
| **Quality lock** | 1440p | Pins playback with `setPlaybackQualityRange(q, q)` so ABR stops oscillating. 1440p is the panel's sweet spot: it supersamples ~1.2× while 4K wastes ~2.8× the bits invisibly. |
| **Quick start** | ✔ | Seeds `yt-player-quality` before the player boots → video starts directly at your quality instead of the 480p-then-upgrade cycle (faster first frame, less wasted bandwidth). |
| **VP9 guarantee** | ✔ | Forces `isTypeSupported(vp9)` true — vaccination against the documented WebKit probe race that silently caps you at 1080p H.264. |
| **AV1 block** | ✔ | iPhone 13 has no AV1 hardware decoder (first was A17 Pro) — YouTube is told AV1 is unsupported so it never wastes a rung on it. |
| **Stable Volume OFF** | ✔ | Strips loudness normalization / DRC from player responses → full dynamic range, the audio community's #1 YouTube complaint. |
| **Prefer Opus** | ✔ | Steers audio to the Opus track (~160 kbps) over AAC (~128 kbps) when the browser supports Opus (checked live — safety valve). |
| **Stall recovery** | ✔ | Two stalls in 30 s above 1080p → drop two rungs; restore after 10 s of healthy buffer. Works *with* Apple's Managed Media Source buffer limits. |
| **Preconnect** | ✔ | Hints to googlevideo/ytimg CDN endpoints at document_start so the first segment fetch starts sooner. |
| **Stats badge** | off | Live overlay: applied rung, resolution, codec, buffer seconds, dropped frames, stalls. |
| **Feed data-saver** | off (opt-in) | Pauses autoplaying feed previews outside watch pages. Purely opt-in — off by default, removes nothing. |

## Why an engine in the page world

YouTube exposes `setPlaybackQualityRange` / `getAvailableQualityLevels` as **own
properties on `#movie_player` in the page's JS heap** — a normal isolated content
script sees `typeof player.setPlaybackQuality === 'undefined'`, which is why most
quality extensions fail silently. `content.js` therefore injects `engine.js` into the
page at `document_start` (before YouTube's player boots), and relays stats/controls
between the page world, the popup, and the badge via `postMessage`.

## Install (Orion, same flow as before)

1. Repo → download ZIP → unzip.
2. Orion → Settings → Extensions → Chrome **or** Firefox extensions enabled.
3. ••• → Extensions → **+** → file-based → pick this folder (manifest.json).
4. Open youtube.com and play something. Tap the YT Boost icon: choose quality, hit
   **Apply**. Settings persist (engine stores them in the page's localStorage).

## Honest limitations

- **MMS buffer ceiling (~30 s fill / ~10 s resume)** is Apple's; nobody at page level
  can raise it. Stall recovery works around it, not through it.
- **60 Hz panel**: >60 fps is undisplayable on iPhone 13 — nothing to gain there.
- **HDR**: YouTube gates HDR rungs away from Safari/WebKit clients and iOS WebKit's
  VP9-Profile-2 path is unverified; this extension cannot force HDR (by design — it
  would risk erroring the player).
- **Ad blocking** is Orion's built-in job (this extension deliberately does zero
  network blocking — the Jan 2026 Orion/YouTube breakage came from filter lists).
- **`getVideoData().videoCoding`** (codec display) is a YouTube internal — guarded,
  may show blank if YouTube renames it.
- If YouTube ever changes its player API names (`setPlaybackQualityRange` etc.),
  the quality lock stops applying — everything else keeps working; the stats badge
  will show the truth.

## Tests

```
npm install && npm test
```

Boots the real engine in jsdom and verifies: VP9 forcing (probe-race simulation),
AV1/AAC blocking with the Opus safety valve, decodingInfo patching, quick-start
seeding (exact `yt-player-quality` payload), quality pinning incl. next-best-rung
fallback, stall downgrade → recovery state machine, loudness stripping through the
fetch patch (with pass-through for non-player URLs), config bridge, stats fields,
content-script injection + preconnects, manifest lint.

## Credits

Mechanisms informed by the public userscript ecosystem (adisib's HD gist, the
"Default Resolution" / force-quality family, enhanced-h264ify's codec patching,
Force-YouTube-Resolution-Extension's isolated-world writeup) and the audio
community's Stable Volume findings (r/headphones, r/youtube, r/asmr). Original
code; do whatever you want with it.
