/*
 * YT Boost — content script (isolated world).
 * 1. Injects engine.js into the PAGE world at document_start (inline script tag,
 *    fetched from the extension package; falls back to a src= tag if fetch is blocked).
 * 2. Adds preconnect hints so the first video segment fetch starts sooner.
 * 3. Bridges page-world stats <-> popup via window.postMessage + chrome.runtime.
 * 4. Draws the optional on-screen stats badge.
 */
(() => {
  'use strict';

  if (globalThis.__YT_BOOST_CS) return;
  globalThis.__YT_BOOST_CS = true;

  /* ---------- 1. preconnect hints (sync, immediate) ---------- */
  try {
    const hosts = ['https://redirector.googlevideo.com', 'https://i.ytimg.com'];
    for (const h of hosts) {
      const l = document.createElement('link');
      l.rel = 'preconnect';
      l.href = h;
      l.crossOrigin = '';
      (document.head || document.documentElement).appendChild(l);
    }
  } catch (e) {}

  /* ---------- 2. inject engine into the page world ---------- */
  let latest = { stats: null, config: null };

  function bootEngine(src) {
    const s = document.createElement('script');
    s.textContent = src;
    s.setAttribute('data-ytboost', '1');
    (document.head || document.documentElement).appendChild(s);
  }

  (async () => {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) return;
      const url = chrome.runtime.getURL('engine.js');
      try {
        const res = await fetch(url);
        const src = await res.text();
        if (src && src.indexOf('YQE') !== -1) { bootEngine(src); return; }
      } catch (e) { /* fetch path failed */ }
      // fallback: external script tag (subject to page CSP, but worth trying)
      const s = document.createElement('script');
      s.src = url;
      s.setAttribute('data-ytboost', '1');
      (document.head || document.documentElement).appendChild(s);
    } catch (e) { /* engine absent: page still works normally */ }
  })();

  /* ---------- 3. page -> content bridge ---------- */
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__YQE !== 'stats' || !d.stats) return;
    latest = { stats: d.stats, config: d.config || null };
    renderBadge();
    // persist a light snapshot for the popup to read when no tab message works
    try {
      if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ lastStats: latest });
      }
    } catch (e2) {}
  });

  /* ---------- 4. popup -> page bridge ---------- */
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
        const m = msg || {};
        try {
          if (m.type === 'YQE_GET') {
            respond({ ok: true, stats: latest.stats, config: latest.config });
          } else if (m.type === 'YQE_SET') {
            window.postMessage({ __YQE: 'config', cfg: m.cfg || {} }, '*');
            setTimeout(() => respond({ ok: true, stats: latest.stats, config: latest.config }), 250);
            return true; // async respond
          } else {
            respond({ ok: false, error: 'unknown type' });
          }
        } catch (e) {
          try { respond({ ok: false, error: String(e) }); } catch (e2) {}
        }
      });
    }
  } catch (e) {}

  /* ---------- 5. stats badge ---------- */
  let badge = null;

  function renderBadge() {
    const cfg = latest.config;
    const on = !!(cfg && cfg.statsOverlay);
    if (!on) {
      if (badge) { badge.remove(); badge = null; }
      return;
    }
    const s = latest.stats;
    if (!s) return;
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'ytboost-badge';
      badge.style.cssText =
        'position:fixed;top:4px;right:4px;z-index:2147483647;pointer-events:none;' +
        'font:10px/1.35 ui-monospace,Menlo,monospace;color:#fff;background:rgba(0,0,0,.65);' +
        'padding:3px 6px;border-radius:6px;white-space:pre;';
      (document.body || document.documentElement).appendChild(badge);
    }
    badge.textContent =
      'YT⇧ ' + (s.applied || s.target || 'auto') + (s.downgraded ? ' ⏳' : '') +
      '\n' + (s.res || '–') + '  ' + (s.codec || '') +
      '\nbuf ' + (s.bufferSec || 0) + 's  drop ' + (s.dropped || 0) + '/' + (s.total || 0) +
      '  stalls ' + (s.stalls || 0);
  }
})();
