/* YT Boost — popup UI */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  let tabId = null;

  const TOGGLES = {
    audio: [
      { key: 'stableVolumeOff', name: 'Stable Volume OFF', desc: 'Removes YouTube\u2019s dynamic-range compression \u2014 full audio dynamics as uploaded' },
      { key: 'preferOpus', name: 'Prefer Opus audio', desc: 'Opus track (~160 kbps) over AAC (~128 kbps) when available' }
    ],
    speed: [
      { key: 'forceVP9', name: 'Guarantee VP9', desc: 'Fixes the WebKit probe race that silently caps you at 1080p H.264' },
      { key: 'blockAV1', name: 'Block AV1', desc: 'iPhone 13 has no AV1 hardware decoder \u2014 never waste a rung on it' },
      { key: 'quickStart', name: 'Quick start', desc: 'Video starts directly at your chosen quality (no 480p \u2192 upgrade cycle)' },
      { key: 'stallRecovery', name: 'Stall recovery', desc: 'Drops a rung after repeated stalls, restores when the buffer is healthy' },
      { key: 'feedDataSaver', name: 'Pause feed previews', desc: 'Opt-in data saver: pauses autoplay previews outside watch pages (nothing is removed)' }
    ],
    diag: [
      { key: 'statsOverlay', name: 'On-screen stats badge', desc: 'Live quality / dropped frames / buffer / stalls overlay on the video page' }
    ]
  };

  function warn(msg) {
    const w = $('#warn');
    w.hidden = false;
    w.textContent = msg;
  }

  function send(msg) {
    return new Promise((resolve) => {
      if (tabId === null) return resolve(null);
      try {
        chrome.tabs.sendMessage(tabId, msg, (r) => {
          void chrome.runtime.lastError; // swallow "no receiver"
          resolve(r && r.ok ? r : null);
        });
      } catch (e) { resolve(null); }
    });
  }

  async function activeTab() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs && tabs[0] ? tabs[0] : null;
    } catch (e) { return null; }
  }

  function collectConfig() {
    const cfg = { targetQuality: $('#quality').value };
    for (const group of Object.values(TOGGLES)) {
      for (const t of group) cfg[t.key] = !!document.getElementById('tg-' + t.key).checked;
    }
    return cfg;
  }

  function renderToggles(containerId, group, current) {
    const wrap = $(containerId);
    wrap.textContent = '';
    for (const t of group) {
      const row = document.createElement('label');
      row.className = 'row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = 'tg-' + t.key;
      cb.checked = current ? !!current[t.key] : true;
      const tt = document.createElement('div');
      tt.className = 't';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = t.name;
      const desc = document.createElement('div');
      desc.className = 'desc';
      desc.textContent = t.desc;
      tt.appendChild(name); tt.appendChild(desc);
      row.appendChild(cb); row.appendChild(tt);
      wrap.appendChild(row);
    }
  }

  function render(snap) {
    const cfg = snap.config || {
      targetQuality: 'hd1440', stableVolumeOff: true, preferOpus: true,
      forceVP9: true, blockAV1: true, quickStart: true, stallRecovery: true,
      feedDataSaver: false, statsOverlay: false
    };
    $('#ver').textContent = 'v1.0.0 \u00b7 tuned for Orion on iPhone 13';
    $('#quality').value = cfg.targetQuality || 'hd1440';
    renderToggles('#audio-toggles', TOGGLES.audio, cfg);
    renderToggles('#speed-toggles', TOGGLES.speed, cfg);
    renderToggles('#diag-toggles', TOGGLES.diag, cfg);
    const s = snap.stats;
    if (s && s.ready) {
      $('#stats').textContent =
        'target: ' + (s.target || 'auto') + (s.downgraded ? '  (recovering)' : '') + '\n' +
        'applied: ' + (s.applied || '\u2013') + '\n' +
        'resolution: ' + (s.res || '\u2013') + '\n' +
        'codec: ' + (s.codec || '\u2013') + '\n' +
        'buffer: ' + (s.bufferSec || 0) + 's   dropped: ' + (s.dropped || 0) + '/' + (s.total || 0) + '\n' +
        'stalls: ' + (s.stalls || 0);
    }
  }

  async function refresh() {
    const snap = await send({ type: 'YQE_GET' });
    if (!snap) {
      warn('No YouTube tab reachable. Open youtube.com, then reopen this popup.');
      return;
    }
    render(snap);
  }

  $('#apply').addEventListener('click', async () => {
    const cfg = collectConfig();
    const snap = await send({ type: 'YQE_SET', cfg });
    if (snap) render(snap);
    else warn('Sent, but no live page confirmed. Reload the YouTube tab if stats look stale.');
    setTimeout(refresh, 400);
  });

  (async function init() {
    const tab = await activeTab();
    if (!tab || !tab.id) {
      warn('Cannot reach tabs in this browser.');
      return;
    }
    tabId = tab.id;
    if (tab.url && !/youtube\.com/.test(tab.url)) {
      warn('Active tab is not on youtube.com \u2014 settings apply when you open one.');
    }
    refresh();
    setInterval(refresh, 1500);
  })();
})();
