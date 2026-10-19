/*
 * YT Boost — page-world engine (runs INSIDE the page's JS context).
 *
 * Why a page-world engine: YouTube exposes its player API (setPlaybackQualityRange,
 * getAvailableQualityLevels, getVideoData) as own properties on #movie_player in the
 * PAGE's JavaScript heap. An ordinary isolated content script sees
 * `typeof movie_player.setPlaybackQuality === 'undefined'` — this is the documented
 * reason most quality-forcing extensions fail silently. content.js injects this file
 * into the page as an inline <script> at document_start, before YouTube's player boots.
 *
 * Grounded in (research, Oct 2026):
 *  - iPhone WebKit: ManagedMediaSource (MMS) owns the buffer (~30s fill / ~10s resume);
 *    page code cannot change those thresholds — so we work AROUND them.
 *  - A15 (iPhone 13): no AV1 hardware decoder (first = A17 Pro) → block AV1 so YouTube
 *    never wastes a rung on it. VP9 software decode in WebKit is the >1080p path.
 *  - WebKit bug history: YouTube's VP9 isTypeSupported probe can race GPU-process
 *    init and cache a false "unsupported" → silent 1080p cap. We force VP9 supported.
 *  - "Stable Volume" is DRC (dynamic range compression) applied by default; audio
 *    community consensus is it degrades dynamic range → we turn it off at the source.
 *  - yt-player-quality localStorage format: {"data":"hd1440","expiration":ts,"creation":ts}
 */
(() => {
  'use strict';

  if (globalThis.YQE) return; // double-injection guard
  const VERSION = '1.0.0';
  const CFG_KEY = 'yqe-config';
  const QUALITY_KEY = 'yt-player-quality';

  /* quality ladder, high → low (YouTube's own ordering) */
  const ORDER = ['highres', 'hd2880', 'hd2160', 'hd1440', 'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'];

  const DEFAULTS = {
    targetQuality: 'hd1440', // 'auto' = don't lock
    forceVP9: true,          // VP9 vaccine (WebKit probe-race bug)
    blockAV1: true,          // no AV1 hardware on A15
    preferOpus: true,        // prefer Opus audio track (~160k) over AAC (~128k)
    stableVolumeOff: true,   // disable loudness normalization / DRC in player responses
    quickStart: true,        // seed yt-player-quality before the player boots
    stallRecovery: true,     // drop a rung on repeated stalls, restore when healthy
    statsOverlay: false,     // on-screen stats badge (via content script)
    feedDataSaver: false     // pause autoplaying feed previews (opt-in; off by default)
  };

  const config = loadConfig();

  function loadConfig() {
    const cfg = Object.assign({}, DEFAULTS);
    try {
      const saved = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
      for (const k of Object.keys(DEFAULTS)) {
        if (typeof saved[k] === typeof DEFAULTS[k]) cfg[k] = saved[k];
      }
    } catch (e) { /* fresh */ }
    return cfg;
  }

  function saveConfig() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(config)); } catch (e) {}
  }

  /* ------------------------------------------------------------------ */
  /* 1. Codec steering                                                   */
  /* ------------------------------------------------------------------ */
  const origSupported = (checker, type) => {
    try { return checker(type); } catch (e) { return ''; }
  };

  function decide(type, original) {
    if (typeof type !== 'string' || !type) return original;
    const t = type.toLowerCase();
    if (config.blockAV1 && t.includes('av01')) {
      return typeof original === 'string' ? '' : false;
    }
    if (config.forceVP9 && (t.includes('vp9') || t.includes('vp09'))) {
      return typeof original === 'string' ? (original || 'probably') : true;
    }
    if (config.preferOpus && t.includes('mp4a')) {
      // only block AAC when the browser genuinely supports Opus (safety valve)
      const opusOK = origSupported(isTypeSupportedRaw, 'audio/webm; codecs="opus"');
      if (opusOK) return typeof original === 'string' ? '' : false;
    }
    return original;
  }

  let isTypeSupportedRaw = () => true;

  function patchCodecs() {
    const MS = window.ManagedMediaSource || window.MediaSource;
    if (MS && typeof MS.isTypeSupported === 'function') {
      const orig = MS.isTypeSupported.bind(MS);
      isTypeSupportedRaw = orig;
      // patch the shared static so BOTH ManagedMediaSource and MediaSource see it
      const patched = function (type) { return decide(type, orig(type)); };
      try { MS.isTypeSupported = patched; } catch (e) {}
      if (window.ManagedMediaSource && window.MediaSource &&
          window.ManagedMediaSource !== window.MediaSource) {
        try { window.MediaSource.isTypeSupported = patched; } catch (e) {}
      }
    }
    try {
      const proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
      if (proto && proto.canPlayType) {
        const orig = proto.canPlayType;
        proto.canPlayType = function (type) { return decide(type, orig.call(this, type)); };
      }
    } catch (e) {}
    try {
      const mc = navigator.mediaCapabilities;
      if (mc && typeof mc.decodingInfo === 'function') {
        const orig = mc.decodingInfo.bind(mc);
        mc.decodingInfo = function (cfg) {
          try {
            const ct = cfg && cfg.video && cfg.video.contentType;
            const verdict = ct !== undefined ? decide(ct, true) : null;
            if (verdict === '' || verdict === false) {
              return Promise.resolve({ supported: false, smooth: false, powerEfficient: false });
            }
            if (ct && config.forceVP9 && /vp9|vp09/i.test(ct)) {
              return orig(cfg).then((r) => Object.assign({}, r, { supported: true, smooth: r.smooth !== false }));
            }
          } catch (e) {}
          return orig(cfg);
        };
      }
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ */
  /* 2. Audio: strip Stable Volume / loudness normalization              */
  /* ------------------------------------------------------------------ */
  const PLAYER_URL_RE = /\/youtubei\/v1\/player|\/player\?|\/player$/;

  function stripLoudness(obj) {
    let touched = false;
    try {
      const ac = obj && obj.playerConfig && obj.playerConfig.audioConfig;
      if (ac) {
        if ('loudnessNormalization' in ac && ac.loudnessNormalization !== false) {
          ac.loudnessNormalization = false; touched = true;
        }
        if ('stableVolume' in ac && ac.stableVolume !== false) {
          ac.stableVolume = false; touched = true;
        }
        if ('stableVolumeEnabled' in ac && ac.stableVolumeEnabled !== false) {
          ac.stableVolumeEnabled = false; touched = true;
        }
      }
    } catch (e) {}
    return touched;
  }

  function makeResponse(res, json) {
    if (typeof Response !== 'undefined') {
      try {
        return new Response(JSON.stringify(json), {
          status: res.status || 200,
          statusText: res.statusText || '',
          headers: { 'content-type': 'application/json' }
        });
      } catch (e) { /* fall through */ }
    }
    return {
      ok: res.ok, status: res.status, url: res.url,
      json: () => Promise.resolve(json),
      text: () => Promise.resolve(JSON.stringify(json)),
      clone: () => makeResponse(res, JSON.parse(JSON.stringify(json)))
    };
  }

  function patchFetch() {
    if (typeof window.fetch !== 'function') return;
    const orig = window.fetch;
    window.fetch = function () {
      const args = arguments;
      const input = args[0];
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const p = orig.apply(this, args);
      if (!config.stableVolumeOff || !PLAYER_URL_RE.test(url)) return p;
      return p.then(async (res) => {
        try {
          if (!res || !res.ok || typeof res.json !== 'function') return res;
          const json = await res.json();
          if (json && typeof json === 'object' && stripLoudness(json)) {
            return makeResponse(res, json);
          }
          return makeResponse(res, json); // still rebuild: json() was consumed
        } catch (e) {
          return res;
        }
      });
    };
  }

  /* ------------------------------------------------------------------ */
  /* 3. Quality lock + quick start                                       */
  /* ------------------------------------------------------------------ */
  const stats = {
    version: VERSION, target: config.targetQuality, applied: '', codec: '',
    res: '', dropped: 0, total: 0, bufferSec: 0, stalls: 0, downgraded: false,
    ready: false
  };

  function seedQuality() {
    if (!config.quickStart || config.targetQuality === 'auto') return;
    try {
      const now = Date.now();
      localStorage.setItem(QUALITY_KEY, JSON.stringify({
        data: config.targetQuality,
        creation: now,
        expiration: now + 2592000000
      }));
    } catch (e) {}
  }

  function findPlayer() {
    return document.getElementById('movie_player') ||
      document.getElementsByClassName('html5-video-player')[0] || null;
  }

  function findVideo() {
    return document.querySelector('video.html5-main-video') ||
      document.querySelector('video');
  }

  function pickLevel(levels, target) {
    const tIdx = ORDER.indexOf(target);
    for (const l of levels) {
      const idx = ORDER.indexOf(l);
      if (idx >= tIdx) return l; // at target, or first rung below it
    }
    return levels[levels.length - 1] || target;
  }

  let appliedThisVideo = '';
  let videoId = '';

  function applyQuality(reason) {
    stats.target = config.targetQuality;
    stats.downgraded = recovery.downgraded;
    if (config.targetQuality === 'auto') return false;
    const player = findPlayer();
    if (!player) { computeStats(); return false; }
    let target = config.targetQuality;
    if (recovery.downgraded) {
      const tIdx = ORDER.indexOf(config.targetQuality);
      target = ORDER[Math.min(tIdx + 2, ORDER.length - 1)]; // two rungs down while recovering
    }
    try {
      const levels = typeof player.getAvailableQualityLevels === 'function'
        ? player.getAvailableQualityLevels() : null;
      if (Array.isArray(levels) && levels.length) target = pickLevel(levels, target);
      if (typeof player.setPlaybackQualityRange === 'function') {
        player.setPlaybackQualityRange(target, target); // pin: stops ABR drift
      }
      if (typeof player.setPlaybackQuality === 'function') {
        player.setPlaybackQuality(target);
      }
      appliedThisVideo = target;
      videoId = currentVideoId(player);
      stats.applied = target;
      try {
        const vd = typeof player.getVideoData === 'function' ? player.getVideoData() : null;
        stats.codec = (vd && (vd.videoCoding || vd.codec || '')) || '';
      } catch (e) {}
      computeStats();
      return true;
    } catch (e) {
      computeStats();
      return false;
    }
  }

  function currentVideoId(player) {
    try {
      const d = typeof player.getVideoData === 'function' ? player.getVideoData() : null;
      if (d && d.video_id) return d.video_id;
    } catch (e) {}
    try {
      const v = findVideo();
      if (v && v.dataset && v.dataset.videoId) return v.dataset.videoId;
    } catch (e) {}
    return location.pathname + location.search;
  }

  /* retry loop: player API appears late; also re-applies per navigation */
  let tries = 0;
  const applyTimer = setInterval(() => {
    const player = findPlayer();
    const id = player ? currentVideoId(player) : '';
    if (player && (id !== videoId || appliedThisVideo === '')) {
      applyQuality('interval');
      tries = 0;
    } else if (tries < 45) {
      tries++;
    } else {
      clearInterval(applyTimer);
    }
  }, 700);

  /* ------------------------------------------------------------------ */
  /* 4. Stall recovery (works WITH the MMS ~30s/~10s buffer, not against it) */
  /* ------------------------------------------------------------------ */
  const recovery = { stalls: [], downgraded: false, healthyTicks: 0, attached: null };

  function noteStall() {
    stats.stalls++;
    if (!config.stallRecovery || config.targetQuality === 'auto') return;
    const now = Date.now();
    recovery.stalls = recovery.stalls.filter((t) => now - t < 30000);
    recovery.stalls.push(now);
    if (recovery.stalls.length >= 2 && !recovery.downgraded) {
      const tIdx = ORDER.indexOf(config.targetQuality);
      if (tIdx < ORDER.indexOf('hd1080')) { // only if we're above 1080p
        recovery.downgraded = true;
        recovery.healthyTicks = 0;
        applyQuality('stall-downgrade');
      }
    }
  }

  function forwardBufferSec(v) {
    try {
      const b = v.buffered;
      if (!b || !b.length) return 0;
      return Math.max(0, b.end(b.length - 1) - v.currentTime);
    } catch (e) { return 0; }
  }

  /* returns action for testability; called every second when downgraded */
  function evalRecovery(fbSec) {
    if (!recovery.downgraded) return 'none';
    if (fbSec > 20) {
      recovery.healthyTicks++;
      if (recovery.healthyTicks >= 10) {
        recovery.downgraded = false;
        recovery.healthyTicks = 0;
        recovery.stalls = [];
        applyQuality('stall-restore');
        return 'restore';
      }
      return 'wait';
    }
    recovery.healthyTicks = 0;
    return 'wait';
  }

  function attachVideo() {
    const v = findVideo();
    if (!v || recovery.attached === v) return;
    recovery.attached = v;
    try {
      v.addEventListener('waiting', noteStall, true);
      v.addEventListener('stalled', noteStall, true);
      v.addEventListener('play', () => {
        const player = findPlayer();
        if (player && currentVideoId(player) !== videoId) applyQuality('play');
      }, true);
    } catch (e) {}
  }

  setInterval(() => {
    attachVideo();
    const v = recovery.attached;
    if (recovery.downgraded && v) evalRecovery(forwardBufferSec(v));
  }, 1000);

  /* ------------------------------------------------------------------ */
  /* 5. Optional feed data-saver (OFF by default; pauses preview players */
  /*    on non-watch pages — never removes any UI or content)            */
  /* ------------------------------------------------------------------ */
  function setupFeedDataSaver() {
    if (!config.feedDataSaver) return;
    document.addEventListener('play', (e) => {
      const v = e.target;
      if (!v || v.tagName !== 'VIDEO') return;
      if (!location.pathname.startsWith('/watch')) {
        if (!v.closest || !v.closest('.html5-video-player, #movie_player, #shorts-player')) {
          try { v.pause(); } catch (e2) {}
        }
      }
    }, true);
  }

  /* ------------------------------------------------------------------ */
  /* 6. Stats + bridge to content script (isolated world)                */
  /* ------------------------------------------------------------------ */
  function computeStats() {
    stats.target = config.targetQuality;
    stats.downgraded = recovery.downgraded;
    const v = recovery.attached || findVideo();
    if (v) {
      stats.res = v.videoWidth + 'x' + v.videoHeight;
      try {
        const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
        stats.dropped = q ? q.droppedVideoFrames : (v.webkitDroppedFrameCount || 0);
        stats.total = q ? q.totalVideoFrames : 0;
      } catch (e) {}
      stats.bufferSec = Math.round(forwardBufferSec(v));
    }
    stats.ready = true;
    return stats;
  }

  setInterval(() => {
    try {
      window.postMessage({ __YQE: 'stats', stats: computeStats(), config }, '*');
    } catch (e) {}
  }, 1000);

  window.addEventListener('message', (e) => {
    if (e.source && e.source !== window) return;
    const d = e.data;
    if (!d || d.__YQE !== 'config' || !d.cfg) return;
    setConfig(d.cfg);
  });

  function setConfig(partial) {
    for (const k of Object.keys(DEFAULTS)) {
      if (partial && typeof partial[k] === typeof DEFAULTS[k]) config[k] = partial[k];
    }
    saveConfig();
    seedQuality();
    applyQuality('config');
    try { window.postMessage({ __YQE: 'stats', stats: computeStats(), config }, '*'); } catch (e) {}
  }

  /* navigation events (YouTube is a SPA) */
  const onNav = () => {
    appliedThisVideo = '';
    seedQuality();
    setTimeout(() => applyQuality('navigate'), 50);
    setTimeout(() => applyQuality('navigate-late'), 800);
  };
  document.addEventListener('yt-navigate-finish', onNav, true);
  window.addEventListener('yt-navigate-finish', onNav, true);

  /* ------------------------------------------------------------------ */
  /* boot                                                                */
  /* ------------------------------------------------------------------ */
  patchCodecs();
  patchFetch();
  seedQuality();
  setupFeedDataSaver();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { attachVideo(); applyQuality('dom'); }, { once: true });
  } else {
    attachVideo();
    applyQuality('boot');
  }

  /* public + test API */
  globalThis.YQE = {
    version: VERSION,
    config,
    stats,
    setConfig,
    applyQuality,
    _internal: {
      decide, pickLevel, stripLoudness, makeResponse, noteStall, evalRecovery,
      recovery, attachVideo, findPlayer, findVideo, ORDER
    }
  };
})();
