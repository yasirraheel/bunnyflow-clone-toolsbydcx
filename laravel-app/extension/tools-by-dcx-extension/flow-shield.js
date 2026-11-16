// Veoxflow / Tools By DCX — Google Flow Shield + Per-User Project History + Live Server Update Engine (v2.6.0)
// 1. Hides "You're running low on Google Flow credits" banner
// 2. Locks top-right Google Account / ULTRA profile button (non-clickable)
// 3. Hides "Sign out", "Add another account", "Manage your Google Account" everywhere (including ogs.google.com iframe)
// 4. Hides global shared projects on flow.google.com home screen & displays ONLY the current user's saved Project History
//    with Real Image, Date/Time, and "Open This Project" button
// 5. Applies live server-driven CSS/UI updates automatically without needing extension updates
(() => {
  'use strict';
  if (globalThis.__veoxflowShieldActive) return;
  globalThis.__veoxflowShieldActive = true;

  const host = location.hostname.toLowerCase();
  const isFlowHost = host === 'flow.google.com' || host.endsWith('.flow.google.com') || host === 'labs.google' || host.endsWith('.labs.google');

  let extRemoved = false;
  let userProjects = [];
  let userProjectMap = new Map();
  let lastSavedProjectSig = '';
  let lastRenderedHistorySig = '';
  let lastActiveProjectId = '';
  let remoteHidePhrases = [
    'out of google flow credits',
    'running low on google flow credits',
    'wait until they refresh or top up',
    'top up to get more google flow credits',
    'credits will reset monthly',
    'top up to get more now',
    'describe how to edit this video',
    'describe how to edit',
    'what would you like to create?',
    'teach me about what you can do',
    'how do i get started?',
    'build a visual moodboard'
  ];

  function extractProjectId(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return null;
    const m = urlStr.match(/\/project\/([0-9a-fA-F-]{8,64})(?:\/|\?|$)/i);
    return m ? m[1] : null;
  }

  function revokeFlowTabAccess() {
    if (!isFlowHost) return;
    try { sessionStorage.clear(); localStorage.clear(); } catch (_) {}
    if (!/^\/about(?:\/|$)/i.test(location.pathname)) {
      location.replace('https://flow.google.com/about');
    } else {
      location.reload();
    }
  }

  function applyLiveRemoteConfig(cfg) {
    if (!cfg || !isFlowHost) return;
    if (Array.isArray(cfg.hidePhrases) && cfg.hidePhrases.length) {
      remoteHidePhrases = cfg.hidePhrases.map(x => String(x || '').toLowerCase().trim()).filter(Boolean);
    }
    if (cfg.customFlowCss) {
      let liveStyle = document.getElementById('bunny-live-remote-css');
      if (!liveStyle) {
        liveStyle = document.createElement('style');
        liveStyle.id = 'bunny-live-remote-css';
        (document.head || document.documentElement).appendChild(liveStyle);
      }
      if (liveStyle.textContent !== cfg.customFlowCss) {
        liveStyle.textContent = cfg.customFlowCss;
      }
    }
    if (Array.isArray(cfg.customDomRules)) {
      for (const rule of cfg.customDomRules) {
        if (!rule || !rule.selector) continue;
        try {
          const els = document.querySelectorAll(rule.selector);
          els.forEach(el => {
            if (rule.attrs && typeof rule.attrs === 'object') {
              for (const [k, v] of Object.entries(rule.attrs)) {
                if (el.getAttribute(k) !== String(v)) el.setAttribute(k, String(v));
              }
            }
          });
        } catch (_) {}
      }
    }
    if (cfg.customFlowHtml && document.body) {
      let liveBox = document.getElementById('bunny-live-remote-html');
      if (!liveBox) {
        liveBox = document.createElement('div');
        liveBox.id = 'bunny-live-remote-html';
        document.body.appendChild(liveBox);
      }
      if (liveBox.innerHTML !== cfg.customFlowHtml) {
        liveBox.innerHTML = cfg.customFlowHtml;
      }
    }
  }

  function handleFlowAccessResponse(res) {
    if (!res) return;
    if (res.allowed === false) {
      isFlowAuthenticated = false;
      revokeFlowTabAccess();
      return;
    }
    isFlowAuthenticated = true;
    if (res.liveConfig) {
      applyLiveRemoteConfig(res.liveConfig);
    }
    const epoch = res.creditResetEpoch || res.liveConfig?.creditResetEpoch || null;
    if (epoch || res.spentByTier) {
      syncCreditsFromExtensionState(epoch, res.spentByTier || null);
    }
    if (res.flowMode) {
      updateCurrentFlowMode(res.flowMode);
    }
    if (res.userPlan) {
      updateCurrentUserPlan(res.userPlan);
    }
    if (res.userEmail) {
      currentUserEmail = String(res.userEmail).trim();
    }
    if (res.userName) {
      currentUserName = String(res.userName).trim();
    }
  }

  try {
    if (isFlowHost && window === window.top) {
      chrome.runtime.sendMessage({ type: 'GET_LIVE_EXT_CONFIG' }, (res) => {
        if (res?.config) applyLiveRemoteConfig(res.config);
      });
      if (!/^\/about(?:\/|$)/i.test(location.pathname)) {
        chrome.runtime.sendMessage({ type: 'CHECK_FLOW_ACCESS' }, (res) => {
          if (!chrome.runtime.lastError) handleFlowAccessResponse(res);
        });
      }
      if (chrome?.storage?.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== 'local') return;
          if (changes.isLoggedIn && changes.isLoggedIn.newValue !== 'true') {
            isFlowAuthenticated = false;
            revokeFlowTabAccess();
            return;
          }
          if (changes.flowMode && changes.flowMode.newValue) {
            updateCurrentFlowMode(changes.flowMode.newValue);
          }
          if (changes.userPlan && changes.userPlan.newValue) {
            updateCurrentUserPlan(changes.userPlan.newValue);
          }
          if (changes.creditResetEpoch || changes.bunnySpentByTier) {
            syncCreditsFromExtensionState(
              changes.creditResetEpoch?.newValue || null,
              changes.bunnySpentByTier?.newValue || null
            );
          }
        });
      }
    }
  } catch (_) {}

  let lastAboutSyncAt = 0;
  setInterval(() => {
    if (extRemoved) return;
    try {
      if (!chrome?.runtime?.id) {
        extRemoved = true;
        revokeFlowTabAccess();
        return;
      }
      if (isFlowHost && window === window.top) {
        if (/^\/about(?:\/|$)/i.test(location.pathname)) {
          if (Date.now() - lastAboutSyncAt > 12000) {
            lastAboutSyncAt = Date.now();
            chrome.runtime.sendMessage({ type: 'SYNC_SESSION', force: false }, () => {
              void chrome.runtime.lastError;
            });
          }
          return;
        }
        chrome.runtime.sendMessage({ type: 'CHECK_FLOW_ACCESS' }, (res) => {
          if (chrome.runtime.lastError) {
            extRemoved = true;
            revokeFlowTabAccess();
            return;
          }
          handleFlowAccessResponse(res);
        });
      }
    } catch (_) {
      extRemoved = true;
      revokeFlowTabAccess();
    }
  }, 4000);

  // 1. Instant CSS Shield + User Project History Styles injected at document_start
  const style = document.createElement('style');
  style.id = 'veoxflow-shield-css';
  style.textContent = `
    /* Hide hidden shield elements */
    [data-veox-hide="true"],
    [data-veox-hidden-native="1"],
    [data-veox-hidden-batch="1"],
    [data-veox-hidden-mode="1"],
    [data-veox-hidden-credit="1"],
    form:not(:has(video)):has([placeholder*="Describe how to edit" i], [data-placeholder*="Describe how to edit" i], [aria-placeholder*="Describe how to edit" i], [aria-label*="Describe how to edit" i], [placeholder*="edit this video" i], [data-placeholder*="edit this video" i]),
    div:not(:has(video)):has([placeholder*="Describe how to edit" i], [data-placeholder*="Describe how to edit" i], [aria-placeholder*="Describe how to edit" i], [aria-label*="Describe how to edit" i], [placeholder*="edit this video" i], [data-placeholder*="edit this video" i]),
    [placeholder*="Describe how to edit" i],
    [data-placeholder*="Describe how to edit" i],
    [aria-placeholder*="Describe how to edit" i],
    [aria-label*="Describe how to edit" i],
    button[aria-label*="Extend" i],
    button[title*="Extend" i],
    [role="button"][aria-label*="Extend" i],
    button.agent-mode-chip:not([aria-pressed="true"]):not(.agent-mode-chip-checked),
    flow-agent-mode-toggle-chip:not(.checked),
    button.agent-action-button,
    flow-creative-agent-prompt-box button.expand-button,
    button[aria-label*="Agent" i]:not(.agent-mode-chip),
    button[title*="Agent" i]:not(.agent-mode-chip),
    [role="button"][aria-label*="Agent" i],
    [role="button"][title*="Agent" i],
    [role="tab"][aria-label*="Agent" i],
    [role="menuitem"][aria-label*="Agent" i],
    [role="option"][aria-label*="Agent" i],
    [data-tooltip*="Agent" i] {
      display: none !important;
      visibility: hidden !important;
      pointer-events: none !important;
      width: 0 !important;
      min-width: 0 !important;
      max-width: 0 !important;
      height: 0 !important;
      min-height: 0 !important;
      max-height: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
      border: none !important;
      overflow: hidden !important;
      opacity: 0 !important;
      position: absolute !important;
    }

    /* Locked Media Mode Tab (Image locked on Video Acc / Video locked on Image Acc) */
    [data-veox-locked-mode="1"] {
      opacity: 0.42 !important;
      cursor: not-allowed !important;
      filter: grayscale(1) !important;
      user-select: none !important;
    }
    [data-veox-locked-mode="1"] * {
      cursor: not-allowed !important;
      pointer-events: none !important;
    }

    /* Custom Vertical Model List & Items (Clean Native Dark Theme) */
    [data-veox-vertical-list="true"] {
      display: flex !important;
      flex-direction: column !important;
      align-items: stretch !important;
      width: 100% !important;
      height: auto !important;
      max-height: none !important;
      background: transparent !important;
      border: none !important;
      padding: 4px !important;
      gap: 4px !important;
      box-sizing: border-box !important;
    }

    [data-veox-custom-row="true"],
    [data-veox-custom-row="true"].veox-active-model-row {
      display: flex !important;
      flex-direction: row !important;
      align-items: center !important;
      justify-content: flex-start !important;
      width: 100% !important;
      min-width: 210px !important;
      height: auto !important;
      min-height: 40px !important;
      padding: 8px 14px !important;
      margin: 0 !important;
      border-radius: 10px !important;
      white-space: nowrap !important;
      overflow: visible !important;
      text-overflow: clip !important;
      box-sizing: border-box !important;
      cursor: pointer !important;
      background: transparent !important;
      color: #ffffff !important;
      font-weight: 500 !important;
      border: none !important;
      box-shadow: none !important;
      transition: background 0.15s ease !important;
    }

    [data-veox-custom-row="true"]:hover,
    [data-veox-custom-row="true"].veox-active-model-row:hover {
      background: rgba(255, 255, 255, 0.08) !important;
    }

    [data-veox-custom-row="true"].veox-active-model-row {
      background: rgba(255, 255, 255, 0.11) !important;
    }

    [data-veox-custom-row="true"] * {
      overflow: visible !important;
      text-overflow: clip !important;
      white-space: nowrap !important;
      max-width: none !important;
      color: inherit !important;
    }

    [data-veox-lock="true"] {
      pointer-events: none !important;
      cursor: default !important;
      user-select: none !important;
    }

    /* On Flow Home Page (not inside /project/), hide all global shared project cards */
    html[data-veox-flow-home="true"] a[href*="/project/"]:not([data-bunny-own="true"]),
    html[data-veox-flow-home="true"] [data-veox-project-card="true"] {
      display: none !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }

    /* Never show big inline banner on Flow Home Screen — only the small bottom button */
    #bunny-user-projects-history {
      display: none !important;
      visibility: hidden !important;
      height: 0 !important;
      overflow: hidden !important;
      pointer-events: none !important;
    }
    html:not([data-veox-flow-home="true"]) #bunny-onscreen-projects-btn,
    html:not([data-veox-flow-home="true"]) #bunny-onscreen-projects-modal {
      display: none !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
    .bunny-hist-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 14px;
      padding-bottom: 10px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }
    .bunny-hist-title {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 16px;
      font-weight: 700;
      color: #ffffff;
      letter-spacing: -0.2px;
    }
    .bunny-hist-badge {
      font-size: 11px;
      font-weight: 700;
      padding: 3px 9px;
      border-radius: 999px;
      background: rgba(139, 92, 246, 0.18);
      border: 1px solid rgba(139, 92, 246, 0.42);
      color: #c4b5fd;
    }
    .bunny-hist-sub {
      font-size: 12px;
      color: #9ca3af;
    }
    .bunny-hist-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
      gap: 16px;
    }
    .bunny-hist-card {
      background: #14141c;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 14px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
      position: relative;
    }
    .bunny-hist-card:hover {
      transform: translateY(-2px);
      border-color: rgba(139, 92, 246, 0.55);
      box-shadow: 0 10px 26px rgba(0, 0, 0, 0.45);
    }
    .bunny-hist-thumb-wrap {
      width: 100%;
      aspect-ratio: 16 / 9;
      background: linear-gradient(135deg, #1e1b2e 0%, #111118 100%);
      position: relative;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .bunny-hist-thumb {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .bunny-hist-placeholder {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      color: #a78bfa;
      font-size: 11.5px;
      font-weight: 600;
      opacity: 0.85;
    }
    .bunny-hist-del {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 26px;
      height: 26px;
      border-radius: 50%;
      border: 1px solid rgba(255,255,255,0.18);
      background: rgba(15, 15, 22, 0.78);
      color: #fca5a5;
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 3;
    }
    .bunny-hist-del:hover {
      background: rgba(239, 68, 68, 0.85);
      color: #fff;
    }
    .bunny-hist-body {
      padding: 12px 14px 14px 14px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex: 1;
    }
    .bunny-hist-name {
      font-size: 13.5px;
      font-weight: 700;
      color: #f3f4f6;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .bunny-hist-date {
      font-size: 11.5px;
      color: #9ca3af;
      margin-bottom: 6px;
    }
    .bunny-hist-open-btn {
      margin-top: auto;
      width: 100%;
      padding: 9px 12px;
      border: 0;
      border-radius: 9px;
      background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%);
      color: #ffffff;
      font-size: 12.5px;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: filter 0.15s ease;
    }
    .bunny-hist-open-btn:hover {
      filter: brightness(1.1);
    }

    /* Floating On-Screen Button & Full-Screen Projects Modal on Google Flow Home Screen (PC & Mobile) */
    #bunny-onscreen-projects-btn {
      position: fixed !important;
      bottom: 20px !important;
      left: 20px !important;
      z-index: 2147483646 !important;
      padding: 10px 16px !important;
      border-radius: 999px !important;
      border: 1px solid rgba(139, 92, 246, 0.55) !important;
      background: linear-gradient(135deg, #1b1730 0%, #11111c 100%) !important;
      color: #f5f3ff !important;
      font-family: 'Google Sans', 'Inter', sans-serif !important;
      font-size: 13px !important;
      font-weight: 700 !important;
      cursor: pointer !important;
      display: inline-flex !important;
      align-items: center !important;
      gap: 8px !important;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55) !important;
      touch-action: manipulation !important;
      pointer-events: auto !important;
      user-select: none !important;
    }
    #bunny-onscreen-projects-btn * {
      pointer-events: none !important;
    }
    #bunny-onscreen-projects-btn:hover {
      border-color: #a78bfa !important;
      transform: translateY(-1px) !important;
    }
    #bunny-onscreen-projects-modal {
      position: fixed;
      inset: 0;
      z-index: 2147483645;
      background: rgba(8, 9, 15, 0.88);
      backdrop-filter: blur(8px);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      font-family: 'Google Sans', 'Inter', sans-serif;
    }
    .bunny-modal-box {
      width: 100%;
      max-width: 1120px;
      max-height: 86vh;
      background: #10111a;
      border: 1px solid rgba(139, 92, 246, 0.38);
      border-radius: 18px;
      padding: 20px 22px;
      overflow-y: auto;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.75);
    }
    @media (max-width: 640px) {
      #bunny-onscreen-projects-btn {
        bottom: 14px;
        left: 14px;
        padding: 9px 14px;
        font-size: 12px;
      }
      #bunny-onscreen-projects-modal {
        padding: 10px;
      }
      .bunny-modal-box {
        padding: 14px;
        max-height: 90vh;
        border-radius: 14px;
      }
      .bunny-hist-grid {
        grid-template-columns: 1fr;
        gap: 12px;
      }
    }

    /* Free Plan Top Scrolling Ticker Bar (VeoxFlow Style) */
    @keyframes bunnyTickerScroll {
      0% { transform: translateX(0%); }
      100% { transform: translateX(-50%); }
    }
    html[data-bunny-free-ticker="1"] body {
      padding-top: 28px !important;
    }
    #bunnyflow-free-ticker {
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      right: 0 !important;
      height: 28px !important;
      background: linear-gradient(90deg, #160d2e 0%, #3b0764 50%, #160d2e 100%) !important;
      border-bottom: 1px solid rgba(168, 85, 247, 0.5) !important;
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.55) !important;
      z-index: 2147483642 !important;
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      padding: 0 10px !important;
      box-sizing: border-box !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
      overflow: hidden !important;
      pointer-events: auto !important;
    }
    .bunny-ticker-badge {
      flex-shrink: 0 !important;
      font-size: 10px !important;
      font-weight: 800 !important;
      letter-spacing: 0.6px !important;
      text-transform: uppercase !important;
      color: #f3e8ff !important;
      background: rgba(168, 85, 247, 0.28) !important;
      border: 1px solid rgba(168, 85, 247, 0.5) !important;
      padding: 2px 7px !important;
      border-radius: 99px !important;
      margin-right: 10px !important;
    }
    .bunny-ticker-viewport {
      flex: 1 1 auto !important;
      overflow: hidden !important;
      white-space: nowrap !important;
      position: relative !important;
      height: 28px !important;
      display: flex !important;
      align-items: center !important;
    }
    .bunny-ticker-track {
      display: inline-flex !important;
      align-items: center !important;
      white-space: nowrap !important;
      will-change: transform !important;
      animation: bunnyTickerScroll 30s linear infinite !important;
    }
    .bunny-ticker-track:hover {
      animation-play-state: paused !important;
    }
    .bunny-ticker-item {
      display: inline-block !important;
      padding-right: 60px !important;
      font-size: 12px !important;
      font-weight: 600 !important;
      color: #f3e8ff !important;
      letter-spacing: 0.2px !important;
    }
    .bunny-ticker-btn {
      flex-shrink: 0 !important;
      margin-left: 10px !important;
      padding: 3px 10px !important;
      border-radius: 99px !important;
      background: linear-gradient(135deg, #a855f7 0%, #ec4899 100%) !important;
      color: #ffffff !important;
      font-size: 11px !important;
      font-weight: 700 !important;
      text-decoration: none !important;
      white-space: nowrap !important;
      box-shadow: 0 2px 8px rgba(168, 85, 247, 0.4) !important;
    }
  `;

  function injectStyle() {
    const root = document.head || document.documentElement;
    if (root && !document.getElementById('veoxflow-shield-css')) {
      root.appendChild(style);
    }
  }
  injectStyle();

  function isFlowHomePage() {
    if (!isFlowHost) return false;
    const p = location.pathname;
    if (p.includes('/project/')) return false;
    return p === '/' || p === '' || p.endsWith('/flow') || p.endsWith('/flow/');
  }

  function updatePageModeAttribute() {
    if (!document.documentElement) return;
    if (isFlowHomePage()) {
      if (document.documentElement.getAttribute('data-veox-flow-home') !== 'true') {
        document.documentElement.setAttribute('data-veox-flow-home', 'true');
      }
    } else if (document.documentElement.hasAttribute('data-veox-flow-home')) {
      document.documentElement.removeAttribute('data-veox-flow-home');
    }
  }

  // Capture a real thumbnail from <video> or <img> inside the active project editor
  function captureElementThumbnail(el) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.78);
      if (dataUrl && dataUrl.length > 200) return dataUrl;
    } catch (_) {}
    if (el.tagName === 'IMG' && el.src && el.src.startsWith('http')) {
      return el.src;
    }
    if (el.tagName === 'VIDEO' && el.poster && el.poster.startsWith('http')) {
      return el.poster;
    }
    return null;
  }

  function findBestProjectMediaThumbnail() {
    // 1. Check active <video> elements inside the project
    const videos = Array.from(document.querySelectorAll('video'));
    for (const v of videos) {
      if (v.closest('#bunny-user-projects-history')) continue;
      const rect = v.getBoundingClientRect();
      if (rect.width >= 100 && rect.height >= 60 && v.readyState >= 2 && v.videoWidth > 0) {
        const thumb = captureElementThumbnail(v);
        if (thumb) return thumb;
      }
      if (v.poster && v.poster.startsWith('http')) return v.poster;
    }
    // 2. Check project <img> elements (excluding tiny avatars/icons)
    const imgs = Array.from(document.querySelectorAll('img'));
    for (const img of imgs) {
      if (img.closest('#bunny-user-projects-history')) continue;
      const src = img.currentSrc || img.src || '';
      if (!src || src.includes('avatar') || src.includes('/a/') || src.includes('icon')) continue;
      const rect = img.getBoundingClientRect();
      if (rect.width >= 130 && rect.height >= 75 && img.complete && img.naturalWidth >= 120) {
        const thumb = captureElementThumbnail(img);
        if (thumb) return thumb;
      }
    }
    return null;
  }

  function detectProjectPromptTitle() {
    // Look for prompt text or project title inside the project editor
    const ta = document.querySelector('textarea, [contenteditable="true"]');
    if (ta) {
      const val = (ta.value || ta.textContent || '').trim();
      if (val && val.length >= 3 && val.length <= 90) return val;
    }
    const docTitle = (document.title || '').replace(/\s*[-|–]\s*Google Flow.*$/i, '').trim();
    if (docTitle && docTitle.toLowerCase() !== 'google flow' && docTitle.toLowerCase() !== 'flow') {
      return docTitle;
    }
    return null;
  }

  async function saveProjectToLocalStorageDirect(entry) {
    try {
      const stored = await chrome.storage.local.get(['userEmail', 'userProjectsByEmail']);
      const key = String(stored.userEmail || 'default').toLowerCase().trim();
      const map = stored.userProjectsByEmail || {};
      const list = Array.isArray(map[key]) ? map[key] : [];
      const nowIso = new Date().toISOString();
      const idx = list.findIndex(p => p.projectId === entry.projectId);
      if (idx >= 0) {
        list[idx] = {
          ...list[idx],
          projectUrl: entry.projectUrl || list[idx].projectUrl,
          title: entry.title || list[idx].title || `Flow Project (${entry.projectId.slice(0, 8)})`,
          thumbnail: entry.thumbnail || list[idx].thumbnail || null,
          updatedAt: nowIso
        };
      } else {
        list.unshift({
          projectId: entry.projectId,
          projectUrl: entry.projectUrl,
          title: entry.title || `Flow Project (${entry.projectId.slice(0, 8)})`,
          thumbnail: entry.thumbnail || null,
          createdAt: nowIso,
          updatedAt: nowIso
        });
      }
      map[key] = list.slice(0, 100);
      await chrome.storage.local.set({ userProjectsByEmail: map, currentUserProjects: map[key] });
      setUserProjects(map[key]);
    } catch (_) {}
  }

  function monitorActiveProjectPage() {
    if (!isFlowHost || window !== window.top) return;
    const pid = extractProjectId(location.href);
    if (!pid) {
      lastActiveProjectId = '';
      return;
    }
    const thumb = findBestProjectMediaThumbnail();
    const title = detectProjectPromptTitle();
    const sig = `${pid}|${location.href}|${title || ''}|${thumb ? thumb.slice(0, 64) : ''}`;
    const isNewVisit = lastActiveProjectId !== pid;
    lastActiveProjectId = pid;

    if (isNewVisit || (sig !== lastSavedProjectSig && thumb)) {
      lastSavedProjectSig = sig;
      const entry = {
        projectId: pid,
        projectUrl: location.href,
        title: title || `Flow Project (${pid.slice(0, 8)})`,
        thumbnail: thumb || null
      };
      saveProjectToLocalStorageDirect(entry);
      try {
        chrome.runtime.sendMessage({
          type: 'SAVE_USER_PROJECT',
          ...entry,
          captureTab: Boolean(!thumb && document.querySelector('video, canvas'))
        }, (res) => {
          if (res?.projects) {
            setUserProjects(res.projects);
          }
        });
      } catch (_) {}
    }
  }

  function setUserProjects(list) {
    userProjects = Array.isArray(list) ? list : [];
    userProjectMap = new Map();
    for (const p of userProjects) {
      if (p?.projectId) userProjectMap.set(p.projectId, p);
    }
    updateFloatingProjectsButton();
    if (document.getElementById('bunny-onscreen-projects-modal')) {
      showOnScreenProjectsModal(false);
    }
  }

  function updateFloatingProjectsButton() {
    if (!isFlowHost || window !== window.top || !document.body) return;
    const oldInline = document.getElementById('bunny-user-projects-history');
    if (oldInline) oldInline.remove();

    // ONLY show "My Projects" button on the Flow Home Page (where "+ New project" is).
    // NEVER show it inside the Studio (/project/...) where videos are created!
    if (!isFlowHomePage()) {
      const existingBtn = document.getElementById('bunny-onscreen-projects-btn');
      if (existingBtn) existingBtn.remove();
      const existingModal = document.getElementById('bunny-onscreen-projects-modal');
      if (existingModal) existingModal.remove();
      return;
    }

    let btn = document.getElementById('bunny-onscreen-projects-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'bunny-onscreen-projects-btn';
      btn.type = 'button';
      document.body.appendChild(btn);
    }
    const countStr = String(userProjects.length);
    if (btn.getAttribute('data-count') !== countStr) {
      btn.setAttribute('data-count', countStr);
      btn.innerHTML = `<span>🎬 My Projects</span><span class="bunny-hist-badge">${countStr}</span>`;
    }
  }

  function renderHomeProjectHistory() {
    // Inline section disabled — only the bottom "🎬 My Projects" button is shown on the Home page
    const old = document.getElementById('bunny-user-projects-history');
    if (old) old.remove();
  }

  function showOnScreenProjectsModal(forceRender = true) {
    if (!document.body) return;
    const sig = userProjects.map(p => `${p.projectId}:${p.title || ''}:${p.updatedAt || ''}:${p.thumbnail ? p.thumbnail.length : 0}`).join('|') || 'empty';
    let modal = document.getElementById('bunny-onscreen-projects-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'bunny-onscreen-projects-modal';
      document.body.appendChild(modal);
      forceRender = true;
    }
    if (!forceRender && modal.getAttribute('data-sig') === sig) {
      return;
    }
    modal.setAttribute('data-sig', sig);

    const cardsHtml = userProjects.length ? userProjects.map((p) => {
      const dateStr = p.updatedAt || p.createdAt
        ? new Date(p.updatedAt || p.createdAt).toLocaleString()
        : 'Saved Project';
      const titleStr = p.title || `Flow Project ${String(p.projectId || '').slice(0, 8)}`;
      const thumbHtml = p.thumbnail
        ? `<img class="bunny-hist-thumb" src="${escHtml(p.thumbnail)}" alt="${escHtml(titleStr)}">`
        : `<div class="bunny-hist-placeholder">
             <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M5 3l14 9-14 9V3z"/></svg>
             <span>Flow Video Project</span>
           </div>`;
      return `
        <div class="bunny-hist-card">
          <div class="bunny-hist-thumb-wrap">
            ${thumbHtml}
            <button type="button" class="bunny-hist-del" data-modal-del="${escHtml(p.projectId)}" title="Remove">×</button>
          </div>
          <div class="bunny-hist-body">
            <div class="bunny-hist-name" title="${escHtml(titleStr)}">${escHtml(titleStr)}</div>
            <div class="bunny-hist-date">📅 ${escHtml(dateStr)}</div>
            <button type="button" class="bunny-hist-open-btn" data-modal-open="${escHtml(p.projectUrl)}">
              <span>▶ Open This Project</span>
            </button>
          </div>
        </div>
      `;
    }).join('') : `<div style="padding:36px;text-align:center;color:#9ca3af;font-size:14px">No saved projects yet. Click <b>+ New project</b> on Google Flow to create and auto-save your first project!</div>`;

    modal.innerHTML = `
      <div class="bunny-modal-box">
        <div class="bunny-hist-header">
          <div class="bunny-hist-title">
            <span>🎬 My Saved Projects History</span>
            <span class="bunny-hist-badge">${userProjects.length} Saved</span>
          </div>
          <button type="button" id="bunny-close-modal-btn" style="padding:6px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);background:#1b1c29;color:#fff;font-weight:700;cursor:pointer">✕ Close</button>
        </div>
        <div class="bunny-hist-grid">${cardsHtml}</div>
      </div>
    `;
  }

  // Global capture-phase click handler so button & modal clicks always work reliably on PC & Mobile
  window.addEventListener('click', async (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    const openModalBtn = target.closest('#bunny-onscreen-projects-btn');
    if (openModalBtn) {
      e.preventDefault();
      e.stopPropagation();
      showOnScreenProjectsModal(true);
      refreshUserProjects();
      return;
    }

    const closeModalBtn = target.closest('#bunny-close-modal-btn');
    if (closeModalBtn || target.id === 'bunny-onscreen-projects-modal') {
      e.preventDefault();
      e.stopPropagation();
      const modal = document.getElementById('bunny-onscreen-projects-modal');
      if (modal) modal.remove();
      return;
    }

    const openProjBtn = target.closest('[data-modal-open]');
    if (openProjBtn) {
      e.preventDefault();
      e.stopPropagation();
      const u = openProjBtn.getAttribute('data-modal-open');
      if (u) location.href = u;
      return;
    }

    const delProjBtn = target.closest('[data-modal-del]');
    if (delProjBtn) {
      e.preventDefault();
      e.stopPropagation();
      const pid = delProjBtn.getAttribute('data-modal-del');
      if (!pid) return;
      const nextList = userProjects.filter(x => x.projectId !== pid);
      try {
        const stored = await chrome.storage.local.get(['userEmail', 'userProjectsByEmail']);
        const key = String(stored.userEmail || 'default').toLowerCase().trim();
        const map = stored.userProjectsByEmail || {};
        map[key] = nextList;
        await chrome.storage.local.set({ userProjectsByEmail: map, currentUserProjects: nextList });
      } catch (_) {}
      setUserProjects(nextList);
      try {
        chrome.runtime.sendMessage({ type: 'DELETE_USER_PROJECT', projectId: pid });
      } catch (_) {}
    }
  }, true);

  try {
    chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
      if (req?.type === 'SHOW_ON_SCREEN_PROJECTS') {
        refreshUserProjects().then(() => {
          showOnScreenProjectsModal();
          sendResponse({ ok: true });
        });
        return true;
      }
      return false;
    });
  } catch (_) {}

  async function refreshUserProjects() {
    if (!isFlowHost || window !== window.top) return;
    try {
      const stored = await chrome.storage.local.get(['userEmail', 'userProjectsByEmail', 'currentUserProjects']);
      const key = String(stored.userEmail || 'default').toLowerCase().trim();
      const map = stored.userProjectsByEmail || {};
      const localList = Array.isArray(map[key]) ? map[key] : (Array.isArray(stored.currentUserProjects) ? stored.currentUserProjects : []);
      if (localList.length) setUserProjects(localList);
    } catch (_) {}
    try {
      chrome.runtime.sendMessage({ type: 'GET_USER_PROJECTS' }, (res) => {
        if (res?.projects && res.projects.length) setUserProjects(res.projects);
      });
    } catch (_) {}
  }

  function escHtml(str) {
    return String(str ?? '').replace(/[&<>'"]/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[c]));
  }

  // ============================================================================
  // PLAN-BASED MODEL SWITCHER + CREDIT FOOTER SANITIZER + VIDEO BATCH LIMIT
  // ============================================================================
  // Exact Model Hierarchy (Top to Bottom):
  // 1. Omni 1.1 Flash         -> Max Plan only
  // 2. Veo 3.1 - Lite         -> Plus & Max Plans
  // 3. Veo 3.1 - Fast         -> Plus & Max Plans
  // 4. Veo 3.1 - Quality      -> Plus & Max Plans
  // 5. Veo 3.1 - Lite [Lower Priority] -> Free, Plus & Max Plans
  const ALL_MAX_MODELS = [
    'Omni 1.1 Flash',
    'Veo 3.1 - Lite',
    'Veo 3.1 - Fast',
    'Veo 3.1 - Quality',
    'Veo 3.1 - Lite [Lower Priority]'
  ];
  const PLUS_MODELS = [
    'Veo 3.1 - Lite',
    'Veo 3.1 - Fast',
    'Veo 3.1 - Quality',
    'Veo 3.1 - Lite [Lower Priority]'
  ];
  const FREE_MODELS = [
    'Veo 3.1 - Lite [Lower Priority]'
  ];

  let currentUserPlan = 'free';
  let isFlowAuthenticated = false;
  let currentUserEmail = '';
  let currentUserName = '';

  function getPlanTier() {
    const p = String(currentUserPlan || 'free').trim().toLowerCase();
    if (p.includes('max') || p.includes('ultra') || p.includes('heavy')) {
      return 'max';
    }
    if (p.includes('plus') || p.includes('pro') || p.includes('vibe') || p.includes('basic') || p.includes('paid') || p.includes('active')) {
      return 'plus';
    }
    return 'free';
  }

  function getPlanBaseCredits(tierOverride) {
    const p = String(currentUserPlan || '').trim().toLowerCase();
    if (!tierOverride && (p.includes('vibe') || p.includes('basic'))) return 5000;
    const tier = tierOverride || getPlanTier();
    if (tier === 'max') return 45000;
    if (tier === 'plus') return 25000;
    return 1000;
  }

  let bunnySpentByTier = { free: 0, plus: 0, max: 0 };
  try {
    const rawSpent = localStorage.getItem('bunny_spent_by_tier');
    if (rawSpent) {
      const parsed = JSON.parse(rawSpent);
      if (parsed && typeof parsed === 'object') {
        bunnySpentByTier = {
          free: Math.max(0, Number(parsed.free || 0)),
          plus: Math.max(0, Number(parsed.plus || 0)),
          max: Math.max(0, Number(parsed.max || 0))
        };
      }
    }
  } catch (_) {}

  function syncCreditsFromExtensionState(epoch, serverSpent) {
    let changed = false;
    try {
      const cleanEpoch = epoch ? String(epoch).trim() : '';
      if (cleanEpoch) {
        const prevEpoch = localStorage.getItem('bunny_credit_reset_epoch') || '';
        if (prevEpoch !== cleanEpoch) {
          bunnySpentByTier = { free: 0, plus: 0, max: 0 };
          localStorage.setItem('bunny_credit_reset_epoch', cleanEpoch);
          localStorage.setItem('bunny_spent_by_tier', JSON.stringify(bunnySpentByTier));
          changed = true;
        }
      }
      if (!changed && serverSpent && typeof serverSpent === 'object') {
        const nextFree = Math.max(0, Number(serverSpent.free || 0));
        const nextPlus = Math.max(0, Number(serverSpent.plus || 0));
        const nextMax = Math.max(0, Number(serverSpent.max || 0));
        if (nextFree !== bunnySpentByTier.free || nextPlus !== bunnySpentByTier.plus || nextMax !== bunnySpentByTier.max) {
          bunnySpentByTier = { free: nextFree, plus: nextPlus, max: nextMax };
          localStorage.setItem('bunny_spent_by_tier', JSON.stringify(bunnySpentByTier));
          changed = true;
        }
      }
    } catch (_) {}
    if (changed && isFlowHost) {
      try { customizeGoogleAccountMenu(); } catch (_) {}
    }
  }

  function getRemainingCredits() {
    const tier = getPlanTier();
    const base = getPlanBaseCredits(tier);
    const spent = Math.max(0, Number(bunnySpentByTier[tier] || 0));
    return Math.max(0, base - spent);
  }

  function getPlanCreditsText() {
    return `${getRemainingCredits().toLocaleString('en-US')} Google Flow credits`;
  }

  function saveSpentCredits() {
    try {
      localStorage.setItem('bunny_spent_by_tier', JSON.stringify(bunnySpentByTier));
    } catch (_) {}
    try {
      if (chrome?.storage?.local) {
        chrome.storage.local.set({ bunnySpentByTier });
      }
      if (chrome?.runtime?.id) {
        chrome.runtime.sendMessage({
          type: 'SYNC_USER_CREDITS',
          spentByTier: bunnySpentByTier
        }, () => {
          void chrome.runtime?.lastError;
        });
      }
    } catch (_) {}
  }

  function deductUserCredits(cost) {
    const num = Math.max(0, Number(cost || 0));
    if (num <= 0) return getRemainingCredits();
    const tier = getPlanTier();
    const base = getPlanBaseCredits(tier);
    bunnySpentByTier[tier] = Math.min(base, Math.max(0, Number(bunnySpentByTier[tier] || 0)) + num);
    saveSpentCredits();
    customizeGoogleAccountMenu();
    return getRemainingCredits();
  }

  function refundUserCredits(amount) {
    const num = Math.max(0, Number(amount || 0));
    if (num <= 0) return getRemainingCredits();
    const tier = getPlanTier();
    bunnySpentByTier[tier] = Math.max(0, Number(bunnySpentByTier[tier] || 0) - num);
    saveSpentCredits();
    customizeGoogleAccountMenu();
    return getRemainingCredits();
  }

  function getModelList() {
    const tier = getPlanTier();
    if (tier === 'max') return ALL_MAX_MODELS;
    if (tier === 'plus') return PLUS_MODELS;
    return FREE_MODELS;
  }

  // Batch Limits:
  // Free Plan = x1 (1x locked)
  // Plus Plan = x2 (x1 & x2)
  // Max Plan  = x3 (x1, x2 & x3)
  function getMaxAllowedBatchCount() {
    const tier = getPlanTier();
    if (tier === 'max') return 3;
    if (tier === 'plus') return 2;
    return 1;
  }

  let activeModelChoice = 'Veo 3.1 - Lite [Lower Priority]';
  function normalizeSavedModelChoice(saved) {
    const list = getModelList();
    if (saved && list.includes(saved)) return saved;
    return 'Veo 3.1 - Lite [Lower Priority]';
  }

  function updateCurrentUserPlan(newPlan) {
    if (!newPlan) return;
    const prevTier = getPlanTier();
    currentUserPlan = String(newPlan);
    const nextTier = getPlanTier();
    activeModelChoice = normalizeSavedModelChoice(activeModelChoice);
    try { localStorage.setItem('bunny_model_choice_v2', activeModelChoice); } catch (_) {}
    if (prevTier !== nextTier) {
      document.querySelectorAll('[data-veox-custom-row="true"], [data-veox-locked-model="1"], [data-veox-locked-batch="1"]').forEach(el => el.remove());
      document.querySelectorAll('[data-veox-batch-synced]').forEach(el => el.removeAttribute('data-veox-batch-synced'));
      if (isFlowHost) {
        handleModelMenus();
        updateTriggerLabel();
        enforcePlanBatchLimit();
        enforceFreePlanBanners();
        customizeGoogleAccountMenu();
      }
    }
  }

  try {
    activeModelChoice = normalizeSavedModelChoice(localStorage.getItem('bunny_model_choice_v2'));
    localStorage.setItem('bunny_model_choice_v2', activeModelChoice);
  } catch (_) {
    activeModelChoice = 'Veo 3.1 - Lite [Lower Priority]';
  }

  let currentFlowMode = 'video';
  let lastModeAutoSwitchAt = 0;

  function setModeTabLocked(tabEl, locked) {
    if (!tabEl) return;
    if (locked) {
      tabEl.removeAttribute('data-veox-hidden-mode');
      tabEl.setAttribute('data-veox-locked-mode', '1');
      tabEl.setAttribute('aria-disabled', 'true');
      if (!tabEl.querySelector('[data-veox-mode-lock-badge="1"]')) {
        const badge = document.createElement('span');
        badge.setAttribute('data-veox-mode-lock-badge', '1');
        badge.textContent = '🔒';
        badge.style.cssText = 'margin-left:5px !important;font-size:11px !important;line-height:1 !important;display:inline-block !important;pointer-events:none !important;';
        tabEl.appendChild(badge);
      }
    } else {
      tabEl.removeAttribute('data-veox-hidden-mode');
      tabEl.removeAttribute('data-veox-locked-mode');
      tabEl.removeAttribute('aria-disabled');
      tabEl.querySelectorAll('[data-veox-mode-lock-badge="1"]').forEach(b => b.remove());
    }
  }

  function findMediaModeTabs() {
    const candidates = document.querySelectorAll('button, [role="radio"], [role="tab"], [role="button"]');
    let imageRadio = null;
    let videoRadio = null;

    for (const el of candidates) {
      if (el.closest('#bunny-user-projects-history, #bunny-onscreen-projects-modal, #bunny-onscreen-projects-btn, #bunny-injected-credits-card, #bunnyflow-free-ticker, #bunnyflow-floating-upgrade, #bunny-locked-mode-toast')) continue;
      const raw = (el.textContent || '').replace(/🔒/g, '').replace(/\s+/g, ' ').trim();
      if (!raw || raw.length > 34) continue;
      const lower = raw.toLowerCase();
      if (lower.includes('frames') || lower.includes('ingredients')) continue;

      // Strip Material Symbol icon ligatures (e.g. "imageImage", "videocamVideo", "photo_libraryImage")
      const cleanedImg = lower.replace(/^(?:image|photo_library|photo_camera|photo|collections|wallpaper|panorama|crop_original)\s*/i, '').trim();
      const cleanedVid = lower.replace(/^(?:videocam|movie|smart_display|video_library|play_circle|theaters|video_stable|video_camera_back)\s*/i, '').trim();

      if (cleanedImg === 'image' || lower === 'image') {
        imageRadio = el;
      } else if (cleanedVid === 'video' || lower === 'video') {
        videoRadio = el;
      }
    }
    return { imageRadio, videoRadio };
  }

  function isModeTabActive(el) {
    if (!el) return false;
    return (
      el.getAttribute('aria-checked') === 'true' ||
      el.getAttribute('aria-selected') === 'true' ||
      el.getAttribute('data-state') === 'checked' ||
      el.getAttribute('data-state') === 'active'
    );
  }

  function updateCurrentFlowMode(newMode) {
    const next = String(newMode || 'video').toLowerCase() === 'image' ? 'image' : 'video';
    const changed = next !== currentFlowMode;
    currentFlowMode = next;
    if (changed && isFlowHost) {
      document.querySelectorAll('[data-veox-hidden-mode="1"], [data-veox-locked-mode="1"]').forEach(el => {
        el.removeAttribute('data-veox-hidden-mode');
        el.removeAttribute('data-veox-locked-mode');
        el.removeAttribute('aria-disabled');
      });
      document.querySelectorAll('[data-veox-mode-lock-badge="1"]').forEach(b => b.remove());
      if (currentFlowMode === 'image') {
        document.querySelectorAll('[data-veox-custom-row="true"], [data-veox-locked-model="1"]').forEach(el => el.remove());
        document.querySelectorAll('[data-veox-hidden-native="1"]').forEach(el => el.removeAttribute('data-veox-hidden-native'));
        document.getElementById('bunny-smart-switch-toast')?.remove();
      }
      lastModeAutoSwitchAt = 0;
      enforceFlowMediaMode();
    }
  }

  function enforceFlowMediaMode() {
    if (!isFlowHost || isFlowHomePage()) return;

    const { imageRadio, videoRadio } = findMediaModeTabs();

    if (currentFlowMode === 'video') {
      // Video Account: NEVER lock Nano Banana / Image mode! Both Video and Image are freely usable.
      if (imageRadio) setModeTabLocked(imageRadio, false);
      if (videoRadio) setModeTabLocked(videoRadio, false);
      document.querySelectorAll('[data-veox-locked-mode="1"]').forEach(el => setModeTabLocked(el, false));
    } else if (currentFlowMode === 'image') {
      // Remove any custom video model rows so Nano Banana model family works cleanly
      document.querySelectorAll('[data-veox-custom-row="true"], [data-veox-locked-model="1"]').forEach(el => el.remove());
      document.querySelectorAll('[data-veox-hidden-native="1"]').forEach(el => el.removeAttribute('data-veox-hidden-native'));

      // Lock Video option in settings popover so only Image (Nano Banana) is selectable on Image Account
      if (videoRadio) setModeTabLocked(videoRadio, true);
      if (imageRadio) {
        setModeTabLocked(imageRadio, false);
        const isVidSelected = isModeTabActive(videoRadio);
        const isImgSelected = isModeTabActive(imageRadio);
        if ((isVidSelected || !isImgSelected) && Date.now() - lastModeAutoSwitchAt > 1800) {
          lastModeAutoSwitchAt = Date.now();
          firePointerSeq(imageRadio);
        }
      } else {
        // Check if Flow is currently sitting in Video mode while popover is closed
        const settingsTrigger = document.querySelector("button[aria-label='Settings trigger']") ||
          Array.from(document.querySelectorAll('button')).find(b => {
            const t = (b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            return t.length < 60 && (t.includes('720p') || t.includes('1080p') || /\b[468]s\b/.test(t) || t.includes('veo 3.1'));
          });
        if (settingsTrigger) {
          const trigText = (settingsTrigger.textContent || '').toLowerCase();
          const looksLikeVideoMode =
            trigText.includes('videocam') ||
            trigText.includes('720p') ||
            trigText.includes('1080p') ||
            /\b[468]s\b/.test(trigText) ||
            trigText.includes('veo');
          if (looksLikeVideoMode && Date.now() - lastModeAutoSwitchAt > 3500) {
            lastModeAutoSwitchAt = Date.now();
            firePointerSeq(settingsTrigger);
            setTimeout(() => {
              const { imageRadio: ir, videoRadio: vr } = findMediaModeTabs();
              if (vr) setModeTabLocked(vr, true);
              if (ir) {
                setModeTabLocked(ir, false);
                firePointerSeq(ir);
                setTimeout(() => {
                  try { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (_) {}
                }, 180);
              }
            }, 180);
          }
        }
      }
    }
  }

  function showLockedModeHintToast(isTryingImage) {
    if (!document.body || document.getElementById('bunny-locked-mode-toast')) return;
    const toast = document.createElement('div');
    toast.id = 'bunny-locked-mode-toast';
    toast.style.cssText = 'position:fixed!important;bottom:64px!important;left:50%!important;transform:translateX(-50%)!important;z-index:2147483647!important;display:flex!important;align-items:center!important;gap:10px!important;padding:10px 16px!important;border-radius:999px!important;background:#131126!important;border:1px solid rgba(168,85,247,0.6)!important;box-shadow:0 12px 32px rgba(0,0,0,0.7)!important;color:#f8fafc!important;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif!important;font-size:12.5px!important;font-weight:600!important;white-space:nowrap!important;';
    if (isTryingImage) {
      toast.innerHTML = '<span>🖼️ Use <b>Nano Banana AI</b> on the website for Images</span><a href="https://flow.toolsbydcx.com/nano-banana" target="_blank" style="padding:4px 11px;border-radius:99px;background:linear-gradient(135deg,#ec4899,#a855f7);color:#fff;font-size:11.5px;font-weight:700;text-decoration:none;">Open Nano Banana AI →</a>';
    } else {
      toast.innerHTML = '<span>🎬 This is the Nano Banana AI Image server — open Google Flow for Video</span><a href="https://flow.toolsbydcx.com/generate/video" target="_blank" style="padding:4px 11px;border-radius:99px;background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff;font-size:11.5px;font-weight:700;text-decoration:none;">Open Google Flow →</a>';
    }
    document.body.appendChild(toast);
    setTimeout(() => { try { toast.remove(); } catch (_) {} }, 4200);
  }

  for (const evtName of ['pointerdown', 'mousedown', 'click']) {
    window.addEventListener(evtName, (e) => {
      if (!e || !e.isTrusted || !isFlowHost) return;
      const t = e.target instanceof Element ? e.target : null;
      if (!t) return;
      const lockedTab = t.closest('[data-veox-locked-mode="1"]');
      if (lockedTab) {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (evtName === 'click' || evtName === 'pointerdown') {
          showLockedModeHintToast(currentFlowMode === 'video');
        }
      }
    }, true);
  }

  function enforceFreePlanBanners() {
    if (!isFlowHost || window !== window.top) return;
    const onAbout = /^\/about(?:\/|$)/i.test(location.pathname);
    const shouldShow = isFlowAuthenticated && !onAbout && getPlanTier() === 'free';

    let ticker = document.getElementById('bunnyflow-free-ticker');
    let floatBtn = document.getElementById('bunnyflow-floating-upgrade');

    if (!shouldShow) {
      if (ticker) ticker.remove();
      if (floatBtn) floatBtn.remove();
      document.documentElement?.removeAttribute('data-bunny-free-ticker');
      return;
    }

    document.documentElement?.setAttribute('data-bunny-free-ticker', '1');
    const pricingUrl = 'https://flow.toolsbydcx.com/pricing';
    const msgText = '⚡ You\'re on Free Trial — if you are facing issues creating videos or seeing "Flow is experiencing high demand" errors, this is normal on the Free Plan. If you want to fix this issue and create videos smoothly without any errors, please upgrade your plan!';

    if (!ticker || !document.body?.contains(ticker)) {
      if (ticker) ticker.remove();
      if (document.body) {
        ticker = document.createElement('div');
        ticker.id = 'bunnyflow-free-ticker';
        ticker.innerHTML = `
          <span class="bunny-ticker-badge">FREE TRIAL</span>
          <div class="bunny-ticker-viewport">
            <div class="bunny-ticker-track">
              <span class="bunny-ticker-item">${msgText}</span>
              <span class="bunny-ticker-item">${msgText}</span>
              <span class="bunny-ticker-item">${msgText}</span>
              <span class="bunny-ticker-item">${msgText}</span>
            </div>
          </div>
          <a href="${pricingUrl}" target="_blank" class="bunny-ticker-btn">Upgrade Plan →</a>
        `;
        document.body.appendChild(ticker);
      }
    }

    if (!floatBtn || !document.body?.contains(floatBtn)) {
      if (floatBtn) floatBtn.remove();
      if (document.body) {
        floatBtn = document.createElement('a');
        floatBtn.id = 'bunnyflow-floating-upgrade';
        floatBtn.href = pricingUrl;
        floatBtn.target = '_blank';
        floatBtn.style.cssText = 'position:fixed!important;bottom:16px!important;right:16px!important;padding:8px 15px!important;border-radius:999px!important;background:linear-gradient(135deg,#7e22ce 0%,#db2777 100%)!important;border:1px solid rgba(255,255,255,0.28)!important;color:#fff!important;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif!important;font-size:12px!important;font-weight:700!important;text-decoration:none!important;box-shadow:0 8px 24px rgba(0,0,0,0.65),0 0 20px rgba(168,85,247,0.45)!important;z-index:2147483642!important;pointer-events:auto!important;';
        floatBtn.textContent = '⚡ Free Plan (Slow Queue) • Upgrade Now →';
        document.body.appendChild(floatBtn);
      }
    }
  }

  try {
    if (chrome?.storage?.local) {
      chrome.storage.local.get(['isLoggedIn', 'userPlan', 'testPlanOverride', 'userEmail', 'userName', 'bunnySpentByTier', 'flowMode'], (data) => {
        if (data) {
          isFlowAuthenticated = data.isLoggedIn === 'true';
          if (data.userEmail) currentUserEmail = String(data.userEmail).trim();
          if (data.userName) currentUserName = String(data.userName).trim();
          if (data.flowMode) updateCurrentFlowMode(data.flowMode);
          if (data.bunnySpentByTier && typeof data.bunnySpentByTier === 'object') {
            bunnySpentByTier = {
              free: Math.max(0, Number(data.bunnySpentByTier.free || 0)),
              plus: Math.max(0, Number(data.bunnySpentByTier.plus || 0)),
              max: Math.max(0, Number(data.bunnySpentByTier.max || 0))
            };
            try { localStorage.setItem('bunny_spent_by_tier', JSON.stringify(bunnySpentByTier)); } catch (_) {}
          }
          updateCurrentUserPlan(data.userPlan || 'Free Plan');
          customizeGoogleAccountMenu();
        }
      });
    }
    if (chrome?.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && (changes.isLoggedIn || changes.userPlan || changes.testPlanOverride || changes.userEmail || changes.userName || changes.bunnySpentByTier || changes.flowMode)) {
          chrome.storage.local.get(['isLoggedIn', 'userPlan', 'testPlanOverride', 'userEmail', 'userName', 'bunnySpentByTier', 'flowMode'], (data) => {
            if (data) {
              isFlowAuthenticated = data.isLoggedIn === 'true';
              if (data.userEmail) currentUserEmail = String(data.userEmail).trim();
              if (data.userName) currentUserName = String(data.userName).trim();
              if (data.flowMode) updateCurrentFlowMode(data.flowMode);
              if (data.bunnySpentByTier && typeof data.bunnySpentByTier === 'object') {
                bunnySpentByTier = {
                  free: Math.max(0, Number(data.bunnySpentByTier.free || 0)),
                  plus: Math.max(0, Number(data.bunnySpentByTier.plus || 0)),
                  max: Math.max(0, Number(data.bunnySpentByTier.max || 0))
                };
                try { localStorage.setItem('bunny_spent_by_tier', JSON.stringify(bunnySpentByTier)); } catch (_) {}
              }
              updateCurrentUserPlan(data.userPlan || 'Free Plan');
              enforceFreePlanBanners();
              customizeGoogleAccountMenu();
            }
          });
        }
      });
    }
  } catch (_) {}

  function normText(s) {
    return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function isBlockedModelLabel(text, el) {
    if (el && (el.getAttribute?.('data-veox-keep') === '1' || el.closest?.('[data-veox-keep="1"]'))) {
      return false;
    }
    const t = normText(text);
    if (!t) return false;
    if (t.includes('lower priority')) return false;
    return (
      /omni[\s\d.]*flash/.test(t) ||
      t.includes('quality') ||
      t.includes('veo 3.1 - fast') ||
      t.includes('veo 3.1 - lite') ||
      t.includes('veo 3.1 fast') ||
      t.includes('veo 3.1 lite')
    );
  }

  function firePointerSeq(el) {
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (_) {}
    const seq = ['pointerover', 'pointerenter', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (let i = 0; i < seq.length; i++) {
      const type = seq[i];
      const isPointer = type.startsWith('pointer');
      const isDown = type.includes('down');
      const opts = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons: isDown ? 1 : 0 };
      let ev;
      try {
        ev = isPointer
          ? new PointerEvent(type, Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, opts))
          : new MouseEvent(type, opts);
      } catch (_) {
        try { ev = new MouseEvent(type, opts); } catch (e2) { ev = new Event(type, { bubbles: true, cancelable: true }); }
      }
      el.dispatchEvent(ev);
    }
  }

  function isModelDropdownMenu(el) {
    if (!el) return false;
    const txt = normText(el.textContent);
    if (!/veo\s*3\.1|lower priority|omni[\s\d.]*flash/i.test(txt)) return false;
    if (
      txt.includes('generating will use') ||
      txt.includes('16:9') ||
      txt.includes('9:16') ||
      txt.includes('360p') ||
      txt.includes('720p') ||
      txt.includes('frames') ||
      txt.includes('ingredients') ||
      (/\b4s\b/.test(txt) && /\b8s\b/.test(txt))
    ) {
      return false;
    }
    return true;
  }

  function findAllModelTriggers() {
    const triggers = [];
    const btns = document.querySelectorAll("button, [role='button'], [role='combobox']");
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      if (b.closest('#bunny-live-remote-html')) continue;
      if (b.getAttribute('data-veox-custom-row') === 'true') continue;
      if (b.classList?.contains('header-action') || b.classList?.contains('agent-mode-chip')) continue;
      const bAria = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')).toLowerCase();
      if (/close|dismiss|agent|new\s+session|history/i.test(bAria)) continue;
      if (b.closest('[data-veox-hidden-native="1"]')) continue;
      const role = (b.getAttribute('role') || '').toLowerCase();
      if (role === 'option' || role === 'menuitem' || role === 'menuitemradio') continue;

      const parentMenu = b.closest("[role='menu'], [role='listbox'], [data-radix-popper-content-wrapper]");
      if (parentMenu && isModelDropdownMenu(parentMenu)) continue;

      const t = normText(b.textContent);
      if (!t || t.length > 55) continue;
      if (!/veo\s*3\.1|lower priority|omni[\s\d.]*flash/i.test(t)) continue;

      const r = b.getBoundingClientRect();
      if (r.width >= 20 && r.height >= 16) {
        triggers.push(b);
      }
    }
    return triggers;
  }

  function updateTriggerLabel() {
    activeModelChoice = normalizeSavedModelChoice(activeModelChoice);
    const triggers = findAllModelTriggers();
    for (const trigger of triggers) {
      const rawText = normText(trigger.textContent);
      if (rawText.includes('lower priority')) {
        trigger.setAttribute('data-veox-keep', '1');
      }
      if (trigger.getAttribute('data-veox-keep') === '1') {
        const walker = document.createTreeWalker(trigger, NodeFilter.SHOW_TEXT, null, false);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const nt = normText(node.textContent);
          if (/veo\s*3\.1|omni|lower priority|quality|lite|fast/i.test(nt)) {
            if (node.textContent.trim() !== activeModelChoice) {
              node.textContent = activeModelChoice;
            }
            break;
          }
        }
      }
    }
  }

  function findRealLowerPriorityOption(menuRoot) {
    const root = menuRoot || document;
    const items = root.querySelectorAll("[role='option'], [role='menuitem'], [role='menuitemradio'], li, button");
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.getAttribute('data-veox-custom-row') === 'true') continue;
      const parentMenu = item.closest("[role='menu'], [role='listbox'], [data-radix-popper-content-wrapper]");
      if (!parentMenu || !isModelDropdownMenu(parentMenu)) continue;

      const t = normText(item.textContent);
      if (t.includes('lower priority') && (t.includes('veo') || t.includes('lite'))) {
        return item;
      }
    }
    return null;
  }

  function hideNativeMenuElement(el) {
    if (!el || el.getAttribute('data-veox-custom-row') === 'true') return;
    el.setAttribute('data-veox-hidden-native', '1');
    el.style.setProperty('display', 'none', 'important');
    el.style.setProperty('visibility', 'hidden', 'important');
    el.style.setProperty('height', '0', 'important');
    el.style.setProperty('min-height', '0', 'important');
    el.style.setProperty('margin', '0', 'important');
    el.style.setProperty('padding', '0', 'important');
    el.style.setProperty('overflow', 'hidden', 'important');
  }

  let isFixingModel = false;
  let lastModelFixTs = 0;
  let lastAutoOpenSettingsForModelTs = 0;

  function selectNativeLowerOption(lowerOpt) {
    if (!lowerOpt) return;
    const prevAttr = lowerOpt.getAttribute('data-veox-hidden-native');
    const parentEl = lowerOpt.parentElement;
    const prevParentAttr = parentEl ? parentEl.getAttribute('data-veox-hidden-native') : null;
    try {
      lowerOpt.removeAttribute('data-veox-hidden-native');
      lowerOpt.style.setProperty('display', 'flex', 'important');
      lowerOpt.style.setProperty('visibility', 'visible', 'important');
      lowerOpt.style.setProperty('pointer-events', 'auto', 'important');
      if (parentEl) {
        parentEl.removeAttribute('data-veox-hidden-native');
        parentEl.style.setProperty('display', 'block', 'important');
        parentEl.style.setProperty('visibility', 'visible', 'important');
        parentEl.style.setProperty('pointer-events', 'auto', 'important');
      }
      try { lowerOpt.click(); } catch (_) {}
      try { firePointerSeq(lowerOpt); } catch (_) {}
    } finally {
      setTimeout(() => {
        if (prevAttr) hideNativeMenuElement(lowerOpt);
        if (parentEl && prevParentAttr) hideNativeMenuElement(parentEl);
      }, 60);
    }
  }

  function isVideoAccountMode() {
    return currentFlowMode !== 'image';
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function autoSelectAllowedModel() {
    if (isFixingModel) return;
    const hasCreditsWarn = Boolean(document.querySelector('button[aria-label="Insufficient credits warning"]'));
    const triggers = findAllModelTriggers();

    if (triggers.length === 0) {
      if (hasCreditsWarn && isVideoAccountMode()) {
        const now = Date.now();
        if (now - lastAutoOpenSettingsForModelTs >= 3500) {
          const settingsBtn = document.querySelector('button[aria-label="Settings trigger"], button.settings-trigger-button');
          if (settingsBtn && isVisible(settingsBtn)) {
            lastAutoOpenSettingsForModelTs = now;
            try { settingsBtn.click(); } catch (_) {}
            try { firePointerSeq(settingsBtn); } catch (_) {}
          }
        }
      }
      return;
    }

    const trigger = triggers[triggers.length - 1];
    if (hasCreditsWarn) {
      triggers.forEach(tr => tr.removeAttribute('data-veox-keep'));
    }
    const t = normText(trigger.textContent);

    if (!hasCreditsWarn && t.includes('lower priority')) {
      trigger.setAttribute('data-veox-keep', '1');
      updateTriggerLabel();
      return;
    }

    if (!hasCreditsWarn && trigger.getAttribute('data-veox-keep') === '1') {
      updateTriggerLabel();
      return;
    }

    if (hasCreditsWarn || isBlockedModelLabel(t, trigger)) {
      const now = Date.now();
      if (now - lastModelFixTs < 1500) return;
      lastModelFixTs = now;
      isFixingModel = true;

      firePointerSeq(trigger);

      let hideTimer = setInterval(() => {
        const menus = document.querySelectorAll("[role='menu'], [role='listbox'], [data-radix-popper-content-wrapper]");
        menus.forEach(m => {
          if (isModelDropdownMenu(m)) m.style.setProperty('opacity', '0', 'important');
        });
      }, 15);

      let attempts = 0;
      let pollTimer = setInterval(() => {
        attempts++;
        const lowerOpt = findRealLowerPriorityOption();
        if (lowerOpt) {
          clearInterval(pollTimer);
          clearInterval(hideTimer);
          selectNativeLowerOption(lowerOpt);
          trigger.setAttribute('data-veox-keep', '1');
          setTimeout(() => {
            const menus = document.querySelectorAll("[role='menu'], [role='listbox'], [data-radix-popper-content-wrapper]");
            menus.forEach(m => m.style.removeProperty('opacity'));
            isFixingModel = false;
            updateTriggerLabel();
          }, 250);
        } else if (attempts >= 12) {
          clearInterval(pollTimer);
          clearInterval(hideTimer);
          const menus = document.querySelectorAll("[role='menu'], [role='listbox'], [data-radix-popper-content-wrapper]");
          menus.forEach(m => m.style.removeProperty('opacity'));
          isFixingModel = false;
        }
      }, 80);
    }
  }

  function transformModelMenu(menu) {
    if (!menu || !isModelDropdownMenu(menu)) return;

    const realLower = findRealLowerPriorityOption(menu);
    if (!realLower) return;

    // 1. Hide ALL native model rows inside this menu
    const allNodes = menu.querySelectorAll("[role='option'], [role='menuitem'], [role='menuitemradio'], li, button");
    allNodes.forEach(node => {
      if (node === realLower || node.contains(realLower) || realLower.contains(node)) return;
      if (node.getAttribute('data-veox-custom-row') === 'true' || node.closest('[data-veox-custom-row="true"]')) return;
      if (node.getAttribute('data-veox-locked-model') === '1' || node.closest('[data-veox-locked-model="1"]')) return;
      const txt = normText(node.textContent);
      if (/veo\s*3\.1|omni|quality|fast|lite/i.test(txt)) {
        hideNativeMenuElement(node);
        let p = node.parentElement;
        while (p && p !== menu && !p.contains(realLower)) {
          hideNativeMenuElement(p);
          p = p.parentElement;
        }
      }
    });

    // 2. Make realLower's parent container a clean vertical list
    const parentContainer = realLower.parentElement;
    if (!parentContainer) return;

    parentContainer.setAttribute('data-veox-vertical-list', 'true');
    let anc = parentContainer;
    while (anc && anc !== menu && anc !== document.body) {
      anc.style.setProperty('height', 'auto', 'important');
      anc.style.setProperty('max-height', 'none', 'important');
      anc.style.setProperty('overflow', 'visible', 'important');
      anc = anc.parentElement;
    }

    hideNativeMenuElement(realLower);

    const modelList = getModelList();
    const tier = getPlanTier();
    activeModelChoice = normalizeSavedModelChoice(activeModelChoice);

    const existingCustom = Array.from(parentContainer.querySelectorAll('[data-veox-custom-row="true"]'));
    const existingSig = existingCustom.map(r => r.getAttribute('data-veox-model-item')).join('|');
    const targetSig = modelList.join('|');

    if (existingSig !== targetSig) {
      existingCustom.forEach(el => el.remove());

      function createModelRow(modelName) {
        const row = realLower.cloneNode(true);
        row.removeAttribute('data-veox-hidden-native');
        row.removeAttribute('data-veox-hide');
        row.removeAttribute('style');
        row.removeAttribute('id');
        row.setAttribute('data-veox-model-item', modelName);
        row.setAttribute('data-veox-custom-row', 'true');
        row.setAttribute('data-veox-keep', '1');

        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, null, false);
        let replaced = false;
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (normText(node.textContent).includes('veo') || normText(node.textContent).includes('lower') || normText(node.textContent).includes('omni')) {
            node.textContent = modelName;
            replaced = true;
            break;
          }
        }
        if (!replaced) {
          row.textContent = modelName;
        }

        const isActive = (modelName === activeModelChoice);
        if (isActive) {
          row.classList.add('veox-active-model-row');
          row.setAttribute('aria-selected', 'true');
        } else {
          row.classList.remove('veox-active-model-row');
          row.setAttribute('aria-selected', 'false');
        }

        function onSelect(e) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();

          activeModelChoice = modelName;
          try { localStorage.setItem('bunny_model_choice_v2', modelName); } catch (_) {}

          findAllModelTriggers().forEach(t => t.setAttribute('data-veox-keep', '1'));

          selectNativeLowerOption(realLower);

          updateTriggerLabel();
          enforceOmniResolutionRow();
          setTimeout(() => { updateTriggerLabel(); enforceOmniResolutionRow(); }, 50);
          setTimeout(() => { updateTriggerLabel(); enforceOmniResolutionRow(); }, 200);
        }

        row.addEventListener('click', onSelect, true);
        row.addEventListener('pointerdown', onSelect, true);
        return row;
      }

      for (const mName of modelList) {
        const r = createModelRow(mName);
        parentContainer.insertBefore(r, realLower);
      }
    } else {
      existingCustom.forEach(r => {
        const mName = r.getAttribute('data-veox-model-item');
        if (mName === activeModelChoice) {
          r.classList.add('veox-active-model-row');
          r.setAttribute('aria-selected', 'true');
        } else {
          r.classList.remove('veox-active-model-row');
          r.setAttribute('aria-selected', 'false');
        }
      });
    }

    // 3. Render Locked Upgrade Banner for Free Plan and Plus Plan
    let lockedModelBtn = parentContainer.querySelector('[data-veox-locked-model="1"]');
    if (tier === 'free' || tier === 'plus') {
      const lockLabel = tier === 'free'
        ? '🔒 Omni 1.1, Fast, Quality &amp; Lite'
        : '🔒 Omni 1.1 Flash';
      if (!lockedModelBtn || lockedModelBtn.getAttribute('data-tier') !== tier) {
        if (lockedModelBtn) lockedModelBtn.remove();
        lockedModelBtn = document.createElement('div');
        lockedModelBtn.setAttribute('data-veox-locked-model', '1');
        lockedModelBtn.setAttribute('data-tier', tier);
        lockedModelBtn.setAttribute('data-veox-keep', '1');
        lockedModelBtn.style.cssText = 'display:flex!important;align-items:center!important;justify-content:space-between!important;gap:10px!important;width:100%!important;padding:8px 12px!important;margin-top:4px!important;border-radius:10px!important;background:rgba(168,85,247,0.14)!important;border:1px dashed rgba(168,85,247,0.45)!important;color:#e9d5ff!important;font-size:12px!important;font-weight:700!important;text-decoration:none!important;box-sizing:border-box!important;cursor:default!important;pointer-events:auto!important;';
        lockedModelBtn.innerHTML = `<span>${lockLabel}</span><span data-veox-upgrade-trigger="1" style="padding:3px 9px;border-radius:99px;background:linear-gradient(135deg,#a855f7,#ec4899);color:#fff;font-size:10.5px;font-weight:800;cursor:pointer;">Upgrade →</span>`;
        const upgSpan = lockedModelBtn.querySelector('[data-veox-upgrade-trigger="1"]');
        if (upgSpan) {
          upgSpan.addEventListener('click', (e) => {
            if (!e || !e.isTrusted) return;
            e.preventDefault();
            e.stopPropagation();
            window.open('https://flow.toolsbydcx.com/pricing', '_blank');
          }, true);
        }
        parentContainer.appendChild(lockedModelBtn);
      }
    } else if (lockedModelBtn) {
      lockedModelBtn.remove();
    }
  }

  function handleModelMenus() {
    const menus = document.querySelectorAll("[role='menu'], [role='listbox'], [data-radix-popper-content-wrapper]");
    for (let i = 0; i < menus.length; i++) {
      if (isModelDropdownMenu(menus[i])) {
        transformModelMenu(menus[i]);
      }
    }
  }

  function getActiveBatchCount() {
    const maxAllowed = getMaxAllowedBatchCount();
    if (!document.body) return 1;

    // 1. Check active button in open batch selector row (x1 / x2 / x3 / x4)
    const btns = document.querySelectorAll('button, [role="tab"], [role="radio"], [role="button"]');
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      if (b.getAttribute('data-veox-hidden-batch') === '1') continue;
      const t = (b.textContent || '').trim();
      const m = t.match(/^(?:x\s*([1-4])|([1-4])\s*x)$/i);
      if (m && isBatchButtonActive(b)) {
        const n = Number(m[1] || m[2]) || 1;
        return Math.min(n, maxAllowed);
      }
    }

    // 2. Fallback to bottom summary pill ("Video · 720p · 8s ▯ x2")
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      const txt = (b.textContent || '').trim();
      if (txt.length > 60) continue;
      if (!/(?:360p|720p|1080p|4s|6s|8s|10s|video)/i.test(txt)) continue;
      const bm = txt.match(/x([1-4])(?:\s|$)/i);
      if (bm) {
        return Math.min(Number(bm[1]) || 1, maxAllowed);
      }
    }
    return 1;
  }

  function getActiveDurationSeconds() {
    if (!document.body) return 8;
    const btns = document.querySelectorAll('button, [role="tab"], [role="radio"], [role="button"]');
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      const t = (b.textContent || '').trim();
      const m = t.match(/^(4|6|8|10)\s*s$/i);
      if (m && isBatchButtonActive(b)) {
        return Number(m[1]) || 8;
      }
    }
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      const txt = (b.textContent || '').trim();
      if (txt.length > 60) continue;
      if (!/(?:360p|720p|1080p|x1|x2|video)/i.test(txt)) continue;
      const dm = txt.match(/\b(4|6|8|10)s\b/i);
      if (dm) return Number(dm[1]) || 8;
    }
    return 8;
  }

  function isCurrentlyGeneratingImage() {
    if (currentFlowMode === 'image') return true;
    const { imageRadio, videoRadio } = findMediaModeTabs();
    if (imageRadio && isModeTabActive(imageRadio)) return true;
    if (videoRadio && isModeTabActive(videoRadio)) return false;
    const settingsTrigger = document.querySelector("button[aria-label='Settings trigger']");
    if (settingsTrigger) {
      const trigText = (settingsTrigger.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (/\bimagen\b|nano\s*banana|photo_library/i.test(trigText)) return true;
      if (/^image\b/i.test(trigText) && !/videocam|veo|omni|\b[468]s\b|720p|1080p/i.test(trigText)) return true;
    }
    return false;
  }

  // Official Google Flow Model Credit Cost Calculator (STRICTLY VIDEO GENERATION ONLY — Images cost 0 credits)
  function getCurrentGenerationCreditCost() {
    if (isCurrentlyGeneratingImage()) return 0;
    const model = normalizeSavedModelChoice(activeModelChoice);
    const batch = getActiveBatchCount();
    const dur = getActiveDurationSeconds();
    const tier = getPlanTier();

    let perVideo = 0;
    if (model === 'Omni 1.1 Flash') {
      perVideo = dur === 4 ? 6 : dur === 6 ? 9 : dur === 10 ? 15 : 12;
    } else if (model === 'Veo 3.1 - Quality') {
      perVideo = 100;
    } else if (model === 'Veo 3.1 - Fast') {
      perVideo = 20;
    } else if (model === 'Veo 3.1 - Lite') {
      perVideo = 10;
    } else {
      // Veo 3.1 - Lite [Lower Priority]
      perVideo = tier === 'free' ? 10 : 0;
    }
    return perVideo * batch;
  }

  function sanitizeCreditFooter() {
    if (!document.body) return;
    const cost = getCurrentGenerationCreditCost();
    const creditLabel = `${cost} ${cost === 1 ? 'credit' : 'credits'}`;

    const leafCandidates = document.querySelectorAll('span, u, a, button, div, p');
    for (let i = 0; i < leafCandidates.length; i++) {
      const el = leafCandidates[i];
      if (el.getAttribute('data-bunny-credit-val') === '1') continue;
      if (el.children.length > 0) continue;
      const t = (el.textContent || '').trim();
      if (/^\d+\s*credits?$/i.test(t)) {
        el.setAttribute('data-veox-hidden-credit', '1');
        if (el.parentElement && el.parentElement.getAttribute('data-bunny-credit-val') !== '1' && /^\s*\d+\s*credits?\s*$/i.test(el.parentElement.textContent || '')) {
          el.parentElement.setAttribute('data-veox-hidden-credit', '1');
        }
      }
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const raw = node.textContent || '';
      if (/generating will use/i.test(raw)) {
        const parent = node.parentElement;
        if (parent) {
          parent.querySelectorAll('span, u, a, button').forEach(child => {
            if (child.getAttribute('data-bunny-credit-val') === '1') return;
            if (/credit/i.test(child.textContent || '')) {
              child.setAttribute('data-veox-hidden-credit', '1');
            }
          });
          if (parent.parentElement) {
            parent.parentElement.querySelectorAll('span, u, a, button').forEach(child => {
              if (child.getAttribute('data-bunny-credit-val') === '1') return;
              if (child !== parent && /^\s*\d+\s*credits?\s*$/i.test(child.textContent || '')) {
                child.setAttribute('data-veox-hidden-credit', '1');
              }
            });
          }
        }
        if (raw !== 'Generating will use ') {
          node.textContent = 'Generating will use ';
        }
        if (parent) {
          let customSpan = parent.querySelector('[data-bunny-credit-val="1"]');
          if (!customSpan && parent.parentElement) {
            customSpan = parent.parentElement.querySelector('[data-bunny-credit-val="1"]');
          }
          if (!customSpan) {
            customSpan = document.createElement('span');
            customSpan.setAttribute('data-bunny-credit-val', '1');
            customSpan.style.cssText = 'text-decoration:underline!important;margin-left:3px!important;font-weight:500!important;cursor:pointer!important;color:inherit!important;display:inline!important;';
            customSpan.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              window.open('https://flow.toolsbydcx.com/pricing', '_blank');
            }, true);
            parent.appendChild(customSpan);
          }
          if (customSpan.textContent !== creditLabel) {
            customSpan.textContent = creditLabel;
          }
        }
      }
    }
  }

  // Intercept Video Generation (Generate Arrow Button Click OR Enter Key in Prompt Input) & Deduct Credits
  let lastCreditDeductTs = 0;

  function hasNonEmptyPromptOnPage() {
    const inputs = document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]');
    for (let i = 0; i < inputs.length; i++) {
      const el = inputs[i];
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const val = (el.value !== undefined ? el.value : el.textContent) || '';
      if (val.trim().length > 0) return true;
    }
    return false;
  }

  function isFlowGenerateButton(btn) {
    if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
    if (btn.closest('[role="menu"], [role="listbox"], [role="dialog"], #bunny-user-projects-history, #bunny-onscreen-projects-modal')) return false;

    const txt = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    const lower = txt.toLowerCase();
    const aria = ((btn.getAttribute('aria-label') || '') + ' ' + (btn.getAttribute('title') || '')).toLowerCase();

    // Never match settings pill, Agent toggle, or '+' attachment button
    if (/(?:360p|720p|1080p|4s|6s|8s|10s|x1|x2|x3|x4|agent|upgrade|ultra|sign out|switch account)/i.test(txt)) return false;
    if (txt === '+' || lower === 'add') return false;

    if (
      /\b(?:generate|create|submit|send)\b/i.test(aria) ||
      lower === 'arrow_forward' ||
      lower === 'arrow_upward' ||
      lower === 'send' ||
      lower === '→'
    ) {
      return true;
    }

    // Check if button is inside the bottom prompt bar (sibling/cousin of the "Video · 720p · 8s" summary pill or prompt textarea)
    const rect = btn.getBoundingClientRect();
    if (rect.width >= 24 && rect.width <= 64 && rect.height >= 24 && rect.height <= 64 && txt.length <= 4) {
      let anc = btn.parentElement;
      for (let d = 0; d < 5 && anc && anc !== document.body; d++) {
        const ancTxt = (anc.textContent || '');
        const hasPromptInput = !!anc.querySelector('textarea, [contenteditable="true"]');
        const hasVideoPill = /(?:360p|720p|1080p).*(?:4s|6s|8s|10s)/i.test(ancTxt);
        if (hasPromptInput || hasVideoPill) {
          // Ensure it's the rightmost action button in the prompt bar (not the left '+' button)
          const ancRect = anc.getBoundingClientRect();
          if (rect.left > ancRect.left + ancRect.width * 0.5) {
            return true;
          }
        }
        anc = anc.parentElement;
      }
    }
    return false;
  }

  // Track pending video generations (persisted in sessionStorage so Home -> /project/<id> navigation preserves refund info)
  function getPendingGenerations() {
    try {
      const raw = sessionStorage.getItem('bunny_pending_generations');
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      const cutoff = Date.now() - 15 * 60 * 1000; // 15 min window
      return arr.filter(it => it && it.ts > cutoff && it.remaining > 0);
    } catch (_) {
      return [];
    }
  }

  function savePendingGenerations(list) {
    try {
      sessionStorage.setItem('bunny_pending_generations', JSON.stringify(list || []));
    } catch (_) {}
  }

  function recordGenerationForRefund(totalCost, batchCount) {
    if (totalCost <= 0) return;
    const perVideo = Math.max(1, Math.round(totalCost / Math.max(1, batchCount || 1)));
    const list = getPendingGenerations();
    list.push({
      perVideo,
      remaining: totalCost,
      ts: Date.now()
    });
    savePendingGenerations(list);
  }

  function consumePendingRefund() {
    const list = getPendingGenerations();
    if (!list.length) return 0;
    // Refund from the most recent active generation
    const latest = list[list.length - 1];
    const refundAmt = Math.min(latest.remaining, latest.perVideo);
    latest.remaining = Math.max(0, latest.remaining - refundAmt);
    savePendingGenerations(list.filter(it => it.remaining > 0));
    if (refundAmt > 0) {
      refundUserCredits(refundAmt);
    }
    return refundAmt;
  }

  function markExistingFailuresAsSeen() {
    if (!document.body) return;
    const els = document.querySelectorAll('[role="alert"], [role="status"], article, [role="listitem"], [role="gridcell"], div, p, span');
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (isFailedGenerationNode(el)) {
        const container = findFailureCardContainer(el);
        container.setAttribute('data-bunny-refunded', '1');
      }
    }
  }

  function isFailedGenerationNode(el) {
    if (!el || el.children.length > 4) return false;
    const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!txt || txt.length > 260) return false;
    return (
      /\bfailed to generate\b/i.test(txt) ||
      /\bgeneration failed\b/i.test(txt) ||
      /\bcould(?:n't| not) generate\b/i.test(txt) ||
      /\bunable to generate\b/i.test(txt) ||
      /\bwasn't able to generate\b/i.test(txt) ||
      /\bsomething went wrong\b/i.test(txt) ||
      /\berror generating\b/i.test(txt) ||
      /\bviolates (?:our |google's )?polic/i.test(txt) ||
      /\bblocked by safety\b/i.test(txt) ||
      /\baudio error\b/i.test(txt) ||
      /\bno credits were used\b/i.test(txt) ||
      /\bcredits (?:were |have been )?refunded\b/i.test(txt)
    );
  }

  function findFailureCardContainer(el) {
    let curr = el;
    for (let d = 0; d < 5 && curr && curr.parentElement && curr.parentElement !== document.body && curr.parentElement.tagName !== 'MAIN'; d++) {
      const r = curr.getBoundingClientRect();
      if (r.width >= 160 && r.height >= 40 && r.width <= 900 && r.height <= 600) {
        return curr;
      }
      curr = curr.parentElement;
    }
    return el.parentElement || el;
  }

  function checkFailedVideoRefunds() {
    if (!document.body || !isFlowHost) return;
    const pending = getPendingGenerations();
    if (!pending.length) {
      // No active pending generation — mark any historical failed cards on screen so they don't refund later
      markExistingFailuresAsSeen();
      return;
    }

    const candidates = document.querySelectorAll('[role="alert"], [role="status"], div, p, span');
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (!isFailedGenerationNode(el)) continue;
      if (el.closest('[data-bunny-refunded="1"]')) continue;

      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;

      const container = findFailureCardContainer(el);
      if (container.getAttribute('data-bunny-refunded') === '1') continue;

      container.setAttribute('data-bunny-refunded', '1');
      el.setAttribute('data-bunny-refunded', '1');
      consumePendingRefund();
    }
  }

  function processGenerationAttempt(e) {
    if (!isFlowHost) return;
    // Credits ONLY deduct when creating Videos in Google Flow — never on Image generation!
    if (isCurrentlyGeneratingImage()) return;
    if (!hasNonEmptyPromptOnPage()) return;

    const now = Date.now();
    const cost = getCurrentGenerationCreditCost();
    const batch = getActiveBatchCount();
    const remaining = getRemainingCredits();

    if (cost > 0 && remaining < cost) {
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      window.open('https://flow.toolsbydcx.com/pricing', '_blank');
      return;
    }

    if (now - lastCreditDeductTs < 1500) return;
    lastCreditDeductTs = now;

    // Mark any already-visible failure cards before starting this new generation
    markExistingFailuresAsSeen();

    if (cost > 0) {
      deductUserCredits(cost);
      recordGenerationForRefund(cost, batch);
    }
  }

  window.addEventListener('click', (e) => {
    if (!e || !e.isTrusted || !isFlowHost) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const btn = target.closest('button, [role="button"]');
    if (btn && isFlowGenerateButton(btn)) {
      processGenerationAttempt(e);
    }
  }, true);

  window.addEventListener('keydown', (e) => {
    if (!e || !e.isTrusted || !isFlowHost) return;
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    if (target.tagName === 'TEXTAREA' || target.getAttribute('contenteditable') === 'true') {
      processGenerationAttempt(e);
    }
  }, true);

  let lastBatchAutoClickTs = 0;
  let pageBatchSyncedForMax = 0;
  let lastBatchSyncPath = '';

  function isBatchButtonActive(btn) {
    if (!btn) return false;
    if (
      btn.getAttribute('aria-selected') === 'true' ||
      btn.getAttribute('aria-checked') === 'true' ||
      btn.getAttribute('data-state') === 'active' ||
      btn.getAttribute('data-state') === 'on' ||
      btn.getAttribute('aria-pressed') === 'true'
    ) {
      return true;
    }
    try {
      const bg = window.getComputedStyle(btn).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        return true;
      }
    } catch (_) {}
    return false;
  }

  function findBatchRowContainer(btn) {
    let curr = btn.parentElement;
    for (let depth = 0; depth < 4 && curr && curr !== document.body; depth++) {
      const txt = normText(curr.textContent);
      if (/x\s*1/i.test(txt) && (/x\s*[234]/i.test(txt) || curr.querySelector('[data-veox-locked-batch="1"]')) && !/4\s*s/i.test(txt) && !/8\s*s/i.test(txt) && !/16:9|9:16|frames|ingredients|generating/i.test(txt)) {
        return curr;
      }
      curr = curr.parentElement;
    }
    return btn.parentElement;
  }

  function enforcePlanBatchLimit() {
    if (!document.body) return;
    const maxBatch = getMaxAllowedBatchCount(); // Free=1, Plus=1, Max=2

    const batchGroups = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    while (walker.nextNode()) {
      const tNode = walker.currentNode;
      const t = (tNode.textContent || '').trim();
      const m = t.match(/^(?:x\s*([1-4])|([1-4])\s*x)$/i);
      if (!m) continue;
      const num = Number(m[1] || m[2]);
      if (!num || num < 1 || num > 4) continue;

      const parentEl = tNode.parentElement;
      if (!parentEl) continue;
      if (parentEl.closest('[data-veox-locked-batch="1"]')) continue;
      const btn = parentEl.closest('button, [role="tab"], [role="radio"], [role="button"], [role="option"], label') || parentEl;
      if (!btn || (btn.textContent || '').trim().length > 6) continue;

      const rowContainer = findBatchRowContainer(btn);
      if (!rowContainer) continue;
      if (!batchGroups.has(rowContainer)) {
        batchGroups.set(rowContainer, []);
      }
      if (!batchGroups.get(rowContainer).some(it => it.num === num)) {
        batchGroups.get(rowContainer).push({ el: btn, num });
      }
    }

    for (const [rowContainer, items] of batchGroups.entries()) {
      if (items.length < 2 && !items.some(it => it.num === 1)) continue;

      let forbiddenSelected = false;
      let targetAllowedBtn = null;
      let x1Btn = null;

      items.sort((a, b) => a.num - b.num);

      for (const item of items) {
        if (item.num === 1) x1Btn = item.el;
        if (item.num <= maxBatch) {
          targetAllowedBtn = item.el;
        }
      }

      for (const item of items) {
        if (item.num > maxBatch) {
          if (isBatchButtonActive(item.el)) {
            forbiddenSelected = true;
          }
          item.el.setAttribute('data-veox-hidden-batch', '1');
          item.el.style.setProperty('display', 'none', 'important');
          let w = item.el.parentElement;
          while (w && w !== rowContainer) {
            if (/^(?:x\s*[1-4]|[1-4]\s*x)$/i.test((w.textContent || '').trim())) {
              w.setAttribute('data-veox-hidden-batch', '1');
              w.style.setProperty('display', 'none', 'important');
            }
            w = w.parentElement;
          }
        } else {
          item.el.removeAttribute('data-veox-hidden-batch');
          item.el.style.removeProperty('display');
          item.el.style.setProperty('flex', '1 1 0%', 'important');
          let w = item.el.parentElement;
          while (w && w !== rowContainer) {
            if (/^(?:x\s*[1-4]|[1-4]\s*x)$/i.test((w.textContent || '').trim())) {
              w.removeAttribute('data-veox-hidden-batch');
              w.style.removeProperty('display');
              w.style.setProperty('flex', '1 1 0%', 'important');
            }
            w = w.parentElement;
          }
        }
      }

      const now = Date.now();
      const groupAlreadySynced = rowContainer.getAttribute('data-veox-batch-synced') === String(maxBatch);
      rowContainer.setAttribute('data-veox-batch-synced', String(maxBatch));
      if (forbiddenSelected && !groupAlreadySynced && (now - lastBatchAutoClickTs > 500)) {
        const btnToClick = (maxBatch === 1 ? x1Btn : (targetAllowedBtn || x1Btn));
        if (btnToClick) {
          lastBatchAutoClickTs = now;
          try { btnToClick.click(); } catch (_) {}
        }
      }

      // Show locked x2 upgrade pill on Free Plan & Plus Plan (maxBatch === 1)
      let lockedBatchBtn = rowContainer.querySelector('[data-veox-locked-batch="1"]');
      if (maxBatch === 1) {
        if (!lockedBatchBtn) {
          lockedBatchBtn = document.createElement('div');
          lockedBatchBtn.setAttribute('data-veox-locked-batch', '1');
          lockedBatchBtn.style.cssText = 'display:inline-flex!important;align-items:center!important;justify-content:center!important;gap:6px!important;flex:1 1 auto!important;padding:6px 10px!important;margin-left:6px!important;border-radius:99px!important;background:rgba(168,85,247,0.14)!important;border:1px dashed rgba(168,85,247,0.45)!important;color:#e9d5ff!important;font-size:11.5px!important;font-weight:700!important;text-decoration:none!important;white-space:nowrap!important;cursor:default!important;pointer-events:auto!important;';
          lockedBatchBtn.innerHTML = '<span>🔒 x2 &amp; x3</span><span data-veox-upgrade-trigger="1" style="padding:2px 8px;border-radius:99px;background:linear-gradient(135deg,#a855f7,#ec4899);color:#fff;font-size:10px;font-weight:800;cursor:pointer;">Upgrade →</span>';
          const upgSpan = lockedBatchBtn.querySelector('[data-veox-upgrade-trigger="1"]');
          if (upgSpan) {
            upgSpan.addEventListener('click', (e) => {
              if (!e || !e.isTrusted) return;
              e.preventDefault();
              e.stopPropagation();
              window.open('https://flow.toolsbydcx.com/pricing', '_blank');
            }, true);
          }
          rowContainer.appendChild(lockedBatchBtn);
        }
      } else if (lockedBatchBtn) {
        lockedBatchBtn.remove();
      }
    }

    // Check the bottom Summary Pill (e.g. "Video · 720p · 8s ▯ x4")
    const allBtns = document.querySelectorAll('button, [role="button"]');
    for (let i = 0; i < allBtns.length; i++) {
      const b = allBtns[i];
      const txt = (b.textContent || '').trim();
      if (txt.length > 60) continue;
      if (!/(?:720p|1080p|4s|6s|8s|video)/i.test(txt)) continue;

      const batchMatch = txt.match(/x([2-4])(?:\s|$)/i);
      if (batchMatch) {
        const currentPillX = Number(batchMatch[1]);
        if (currentPillX > maxBatch) {
          const walker2 = document.createTreeWalker(b, NodeFilter.SHOW_TEXT, null, false);
          while (walker2.nextNode()) {
            const tNode = walker2.currentNode;
            if (/x[2-4]/i.test(tNode.textContent || '')) {
              tNode.textContent = (tNode.textContent || '').replace(/x[2-4]/ig, `x${maxBatch}`);
            }
          }

          if (location.pathname !== lastBatchSyncPath || pageBatchSyncedForMax !== maxBatch) {
            lastBatchSyncPath = location.pathname;
            pageBatchSyncedForMax = maxBatch;
            if (!isFixingModel && b.getAttribute('data-state') !== 'open' && b.getAttribute('aria-expanded') !== 'true') {
              try {
                firePointerSeq(b);
                let tries = 0;
                const iv = setInterval(() => {
                  tries++;
                  const popovers = document.querySelectorAll('[role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]');
                  popovers.forEach(p => p.style.setProperty('opacity', '0', 'important'));
                  enforcePlanBatchLimit();
                  if (tries >= 5) {
                    clearInterval(iv);
                    try {
                      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
                    } catch (_) {}
                    setTimeout(() => {
                      const popovers2 = document.querySelectorAll('[role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]');
                      popovers2.forEach(p => p.style.removeProperty('opacity'));
                    }, 150);
                  }
                }, 60);
              } catch (_) {}
            }
          }
        }
      }
    }
  }

  let activeOmniRes = '720p';
  try {
    const savedRes = localStorage.getItem('bunny_omni_res');
    if (savedRes === '360p' || savedRes === '720p') activeOmniRes = savedRes;
  } catch (_) {}

  function findDurationRowContainer() {
    if (!document.body) return null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    while (walker.nextNode()) {
      const tNode = walker.currentNode;
      const t = (tNode.textContent || '').trim();
      if (!/^4\s*s$/i.test(t)) continue;
      const parentEl = tNode.parentElement;
      if (!parentEl) continue;
      const btn = parentEl.closest('button, [role="tab"], [role="radio"], [role="button"], [role="option"], label') || parentEl;
      if (!btn || (btn.textContent || '').trim().length > 6) continue;
      let curr = btn.parentElement;
      for (let depth = 0; depth < 4 && curr && curr !== document.body; depth++) {
        const txt = normText(curr.textContent);
        if (/4\s*s/i.test(txt) && /8\s*s/i.test(txt) && !/x\s*1/i.test(txt) && !/generating/i.test(txt)) {
          const r = curr.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return curr;
        }
        curr = curr.parentElement;
      }
    }
    return null;
  }

  function hasNative360pRow() {
    if (!document.body) return false;
    const els = document.querySelectorAll('button, [role="tab"], [role="radio"], [role="button"], span');
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (el.closest('#bunny-omni-res-row')) continue;
      const txt = (el.textContent || '').trim().toLowerCase();
      if (txt === '360p') {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
      }
    }
    return false;
  }

  function syncSummaryPillResolution(targetRes) {
    const allBtns = document.querySelectorAll('button, [role="button"]');
    for (let i = 0; i < allBtns.length; i++) {
      const b = allBtns[i];
      const txt = (b.textContent || '').trim();
      if (txt.length > 60) continue;
      if (!/(?:360p|720p|1080p)/i.test(txt) || !/(?:4s|6s|8s|10s|video)/i.test(txt)) continue;
      const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT, null, false);
      while (walker.nextNode()) {
        const tNode = walker.currentNode;
        if (/(?:360p|720p)/i.test(tNode.textContent || '')) {
          const updated = (tNode.textContent || '').replace(/(?:360p|720p)/ig, targetRes);
          if (tNode.textContent !== updated) tNode.textContent = updated;
        }
      }
    }
  }

  function enforceOmniResolutionRow() {
    if (!document.body) return;
    const isOmniSelected = (activeModelChoice === 'Omni 1.1 Flash');
    const existingRow = document.getElementById('bunny-omni-res-row');

    if (!isOmniSelected) {
      if (existingRow) existingRow.remove();
      syncSummaryPillResolution('720p');
      return;
    }

    syncSummaryPillResolution(activeOmniRes);

    // If native 360p/720p is already visible on screen, don't duplicate
    if (hasNative360pRow()) {
      if (existingRow) existingRow.remove();
      return;
    }

    const durationRow = findDurationRowContainer();
    if (!durationRow || !durationRow.parentElement) {
      if (existingRow) existingRow.remove();
      return;
    }

    // Match native durationRow container & button styling
    let rowBg = '#202124';
    let rowRadius = '12px';
    let rowHeight = '38px';
    let activeBtnBg = '#3c4043';
    try {
      const cs = window.getComputedStyle(durationRow);
      if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') {
        rowBg = cs.backgroundColor;
      }
      if (cs.borderRadius && cs.borderRadius !== '0px') {
        rowRadius = cs.borderRadius;
      }
      if (cs.height && parseFloat(cs.height) >= 28) {
        rowHeight = cs.height;
      }
      const durBtns = durationRow.querySelectorAll('button, [role="tab"], [role="radio"], [role="button"]');
      for (const db of durBtns) {
        if (isBatchButtonActive(db)) {
          const bcs = window.getComputedStyle(db);
          if (bcs.backgroundColor && bcs.backgroundColor !== 'rgba(0, 0, 0, 0)' && bcs.backgroundColor !== 'transparent') {
            activeBtnBg = bcs.backgroundColor;
            break;
          }
        }
      }
    } catch (_) {}

    let resRow = existingRow;
    if (!resRow || resRow.parentElement !== durationRow.parentElement) {
      if (resRow) resRow.remove();
      resRow = document.createElement('div');
      resRow.id = 'bunny-omni-res-row';
      resRow.setAttribute('data-veox-keep', '1');
      resRow.innerHTML = `
        <button type="button" data-omni-res="360p" style="flex:1 1 0%!important;height:100%!important;border:none!important;outline:none!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;gap:5px!important;font-family:inherit!important;font-size:13px!important;font-weight:600!important;color:#e8eaed!important;cursor:pointer!important;transition:background 0.15s ease!important;padding:0 10px!important;">
          <span>360p</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.75;flex-shrink:0;">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
          </svg>
        </button>
        <button type="button" data-omni-res="720p" style="flex:1 1 0%!important;height:100%!important;border:none!important;outline:none!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;font-family:inherit!important;font-size:13px!important;font-weight:600!important;color:#e8eaed!important;cursor:pointer!important;transition:background 0.15s ease!important;padding:0 10px!important;">
          <span>720p</span>
        </button>
      `;

      resRow.querySelectorAll('button[data-omni-res]').forEach((btn) => {
        const onPick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          const picked = btn.getAttribute('data-omni-res') || '720p';
          activeOmniRes = picked;
          try { localStorage.setItem('bunny_omni_res', picked); } catch (_) {}
          enforceOmniResolutionRow();
        };
        btn.addEventListener('click', onPick, true);
        btn.addEventListener('pointerdown', onPick, true);
      });

      durationRow.parentElement.insertBefore(resRow, durationRow);
    }

    resRow.style.cssText = `display:flex!important;align-items:center!important;justify-content:stretch!important;width:100%!important;height:${rowHeight}!important;min-height:36px!important;background:${rowBg}!important;border-radius:${rowRadius}!important;padding:2px!important;margin:0 0 6px 0!important;box-sizing:border-box!important;gap:2px!important;`;

    resRow.querySelectorAll('button[data-omni-res]').forEach((btn) => {
      const val = btn.getAttribute('data-omni-res');
      const isAct = (val === activeOmniRes);
      btn.style.setProperty('background', isAct ? activeBtnBg : 'transparent', 'important');
      btn.style.setProperty('border-radius', rowRadius, 'important');
      btn.style.setProperty('color', isAct ? '#ffffff' : 'rgba(232,234,237,0.82)', 'important');
      btn.setAttribute('aria-selected', isAct ? 'true' : 'false');
    });
  }

  const BUNNY_LOGO_URL = (function () {
    try {
      return chrome.runtime.getURL('logo.png');
    } catch (_) {
      return '';
    }
  })();

  function findOpenGoogleAccountMenuPopup() {
    if (!document.body) return null;
    const candidates = document.querySelectorAll('a, button, [role="button"], [role="menuitem"], span, div, p');
    let trigger = null;
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (el.children.length > 4) continue;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (t === 'sign out of all accounts' || t === 'visible watermarking') {
        trigger = el;
        break;
      }
    }
    if (!trigger) {
      for (let i = 0; i < candidates.length; i++) {
        const el = candidates[i];
        if (el.children.length > 5) continue;
        const t = (el.textContent || '').toLowerCase();
        if (t.includes('sign out of all accounts') || t.includes('visible watermarking')) {
          trigger = el;
          break;
        }
      }
    }
    if (!trigger) return null;

    let curr = trigger.parentElement;
    for (let d = 0; d < 12 && curr && curr !== document.body && curr.tagName !== 'MAIN'; d++) {
      const t = (curr.textContent || '').toLowerCase();
      const r = curr.getBoundingClientRect();
      if (
        t.includes('switch account') &&
        (t.includes('create avatar') || t.includes('manage subscription') || t.includes('sign out of all accounts')) &&
        r.width >= 200 && r.width <= 560 && r.height >= 180
      ) {
        return curr;
      }
      curr = curr.parentElement;
    }
    return null;
  }

  function customizeGoogleAccountMenu() {
    if (!document.body) return;
    const tier = getPlanTier();
    try { document.documentElement.setAttribute('data-veox-plan-tier', tier); } catch (_) {}
    const creditsTarget = getPlanCreditsText(); // e.g. "45,000 Google Flow credits", "25,000...", "1,000..."
    const displayEmail = currentUserEmail || 'user@flow.toolsbydcx.com';
    const displayName = 'Tools By DCX';
    const accountPopup = findOpenGoogleAccountMenuPopup();

    // 1. Update any raw text nodes matching credits or email across document
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    while (walker.nextNode()) {
      const tNode = walker.currentNode;
      if (tNode.parentElement && tNode.parentElement.closest('#bunny-injected-credits-card')) continue;
      const raw = tNode.textContent || '';
      const trimmed = raw.trim();
      if (!trimmed) continue;

      if (/^\d[\d,.]*\s+Google\s+Flow\s+credits?$/i.test(trimmed)) {
        if (trimmed !== creditsTarget) {
          tNode.textContent = creditsTarget;
        }
      } else if (/^Resets\b/i.test(trimmed) && trimmed.length < 70) {
        tNode.textContent = '';
      } else if (/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(trimmed) && displayEmail) {
        const p = tNode.parentElement;
        if (!p || !p.closest('#bunny-user-projects-history, #bunny-onscreen-projects-modal, textarea, input')) {
          if (trimmed.toLowerCase() !== displayEmail.toLowerCase()) {
            tNode.textContent = displayEmail;
          }
          const prevEl = p?.previousElementSibling || p?.parentElement?.previousElementSibling;
          if (prevEl && prevEl.children.length <= 1) {
            const prevTxt = (prevEl.textContent || '').trim();
            if (prevTxt && prevTxt.length <= 40 && !prevTxt.includes('@') && prevTxt !== displayName) {
              prevEl.textContent = displayName;
            }
          }
        }
      }
    }

    // 2. Intercept account action links to ToolsByDcx routes
    const elements = document.querySelectorAll('a, button, [role="button"], [role="menuitem"], span, div, p, img');
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      if (el.closest('#bunny-user-projects-history, #bunny-onscreen-projects-modal, #bunny-onscreen-projects-btn, #bunny-injected-credits-card, #bunnyflow-free-ticker, #bunnyflow-floating-upgrade, #bunny-locked-mode-toast')) continue;

      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const lower = txt.toLowerCase();

      if (el.tagName === 'A') {
        const href = String(el.getAttribute('href') || '');
        if (
          lower === 'sign out of all accounts' ||
          lower === 'sign out' ||
          lower === 'switch account' ||
          href.includes('accounts.google.com/Logout') ||
          href.includes('accounts.google.com/signout') ||
          href.includes('accounts.google.com/AddSession')
        ) {
          el.setAttribute('href', 'https://flow.toolsbydcx.com/');
          el.removeAttribute('target');
        } else if (
          lower === 'upgrade' ||
          lower === 'manage subscription' ||
          /^\d[\d,.]*\s+google\s+flow\s+credits?$/i.test(lower)
        ) {
          el.setAttribute('href', 'https://flow.toolsbydcx.com/pricing');
          el.setAttribute('target', '_blank');
        }
      }
    }

    // 3. Customize Google Account Menu popup
    if (accountPopup) {
      // A. Replace avatar with Tools By DCX logo
      if (BUNNY_LOGO_URL) {
        const popupImgs = accountPopup.querySelectorAll('img');
        for (const img of popupImgs) {
          if (img.closest('#bunny-injected-credits-card')) continue;
          const src = img.getAttribute('src') || '';
          if (
            src.includes('googleusercontent.com') ||
            src.includes('lh3.google.com') ||
            /avatar|profile/i.test(img.getAttribute('alt') || '')
          ) {
            if (img.src !== BUNNY_LOGO_URL) {
              img.src = BUNNY_LOGO_URL;
              img.removeAttribute('srcset');
            }
          }
        }
        const roundLetterEls = accountPopup.querySelectorAll('div, span, button');
        for (const rel of roundLetterEls) {
          if (rel.closest('#bunny-injected-credits-card')) continue;
          if (rel.querySelector('img')) continue;
          const lt = (rel.textContent || '').trim();
          if (/^[A-Za-z]$/.test(lt)) {
            const rr = rel.getBoundingClientRect();
            if (rr.width >= 24 && rr.width <= 56 && rr.height >= 24 && rr.height <= 56) {
              rel.innerHTML = `<img src="${BUNNY_LOGO_URL}" style="width:100%!important;height:100%!important;border-radius:50%!important;object-fit:cover!important;display:block!important;" />`;
              rel.style.setProperty('background', 'transparent', 'important');
              rel.style.setProperty('padding', '0', 'important');
              break;
            }
          }
        }
      }

      // B. Replace user display name with "Tools By DCX"
      const nameEls = accountPopup.querySelectorAll('div, span, p');
      for (const nel of nameEls) {
        if (nel.closest('#bunny-injected-credits-card')) continue;
        if (nel.children.length === 0) {
          const nt = (nel.textContent || '').trim();
          if (
            nt.toLowerCase() === 'muhammadusman' ||
            (nt.length >= 2 &&
              nt.length <= 40 &&
              !nt.includes('@') &&
              !nt.includes('Google') &&
              !nt.includes('Switch') &&
              !nt.includes('avatar') &&
              !nt.includes('subscription') &&
              !nt.includes('Sign out') &&
              !nt.includes('watermarking') &&
              !nt.includes('credits') &&
              !nt.includes('Upgrade') &&
              !nt.includes('Privacy') &&
              !nt.includes('Terms') &&
              !nt.includes('Licenses') &&
              !nt.includes('reCAPTCHA') &&
              ((nel.parentElement?.textContent || '').includes('@') || (nel.nextElementSibling?.textContent || '').includes('@')))
          ) {
            if (nel.textContent !== displayName) {
              nel.textContent = displayName;
            }
          }
        }
      }

      // C. Hide any native Google credit boxes or "0 AI credits" boxes to avoid clashing
      const nativeCards = accountPopup.querySelectorAll('div, section');
      for (const nc of nativeCards) {
        if (nc.id === 'bunny-injected-credits-card' || nc.closest('#bunny-injected-credits-card')) continue;
        const nct = (nc.textContent || '').replace(/\s+/g, ' ').trim();
        if (
          (/Google\s+Flow\s+credits?/i.test(nct) || /AI\s+credits/i.test(nct)) &&
          (nct.includes('Upgrade') || nct.includes('Get AI credits') || /^\d[\d,.]*\s+Google\s+Flow\s+credits?$/i.test(nct)) &&
          !nct.includes('Sign out') && !nct.includes('Create avatar') && !nct.includes('Manage subscription')
        ) {
          nc.style.setProperty('display', 'none', 'important');
          nc.setAttribute('data-veox-hide', 'true');
        }
      }

      // D. Find "Create avatar" row to place our credits card directly above it
      let createAvatarBtn = null;
      const allButtons = accountPopup.querySelectorAll('button, a, [role="button"], div');
      for (let i = 0; i < allButtons.length; i++) {
        const b = allButtons[i];
        if (b.children.length > 4) continue;
        const bt = (b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (bt === 'create avatar' || bt.includes('create avatar')) {
          createAvatarBtn = b;
          break;
        }
      }

      let injectedCard = accountPopup.querySelector('#bunny-injected-credits-card');
      if (!injectedCard) {
        injectedCard = document.createElement('div');
        injectedCard.id = 'bunny-injected-credits-card';
        injectedCard.style.cssText =
          'display:flex!important;flex-direction:column!important;width:100%!important;padding:14px 16px!important;margin:8px 0 10px 0!important;border-radius:18px!important;background:#282a2c!important;box-sizing:border-box!important;position:relative!important;z-index:99!important;';
        injectedCard.innerHTML =
          '<div style="display:flex!important;align-items:center!important;gap:10px!important;margin-bottom:12px!important;">' +
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="#e3e3e3" style="flex-shrink:0!important;">' +
              '<path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4zm2 14H4V10h16v8z"/>' +
            '</svg>' +
            '<a data-bunny-menu-credits-text="1" href="https://flow.toolsbydcx.com/pricing" target="_blank" style="color:#e3e3e3!important;font-size:15px!important;font-weight:500!important;text-decoration:underline!important;text-underline-offset:3px!important;font-family:\'Google Sans\',Roboto,Arial,sans-serif!important;line-height:20px!important;cursor:pointer!important;">' + creditsTarget + '</a>' +
          '</div>' +
          '<a href="https://flow.toolsbydcx.com/pricing" target="_blank" style="display:flex!important;align-items:center!important;justify-content:center!important;width:100%!important;height:38px!important;border-radius:999px!important;background:#c4c7c5!important;color:#1f1f1f!important;font-size:14px!important;font-weight:600!important;text-decoration:none!important;font-family:\'Google Sans\',Roboto,Arial,sans-serif!important;box-sizing:border-box!important;cursor:pointer!important;">Upgrade</a>';

        if (createAvatarBtn) {
          let targetRow = createAvatarBtn;
          while (targetRow.parentElement && targetRow.parentElement !== accountPopup) {
            const pr = targetRow.parentElement.getBoundingClientRect();
            const rr = targetRow.getBoundingClientRect();
            if (pr.height > rr.height + 40) break;
            targetRow = targetRow.parentElement;
          }
          targetRow.parentElement.insertBefore(injectedCard, targetRow);
        } else {
          const profileRow = accountPopup.querySelector('div:has(> a[href*="accounts.google"])') || accountPopup.children[1];
          if (profileRow && profileRow.nextSibling) {
            profileRow.parentElement.insertBefore(injectedCard, profileRow.nextSibling);
          } else {
            accountPopup.appendChild(injectedCard);
          }
        }
      }

      if (injectedCard) {
        const textEl = injectedCard.querySelector('[data-bunny-menu-credits-text="1"]');
        if (textEl && textEl.textContent !== creditsTarget) {
          textEl.textContent = creditsTarget;
        }
      }
    }
  }

  // Intercept clicks on Locked Media Mode tabs AND Account Menu actions ("Sign out of all accounts", "Upgrade", "Manage subscription", "Switch account")
  const ACCOUNT_INTERCEPT_EVENTS = ['pointerdown', 'mousedown', 'mouseup', 'click'];
  for (const evType of ACCOUNT_INTERCEPT_EVENTS) {
    window.addEventListener(evType, (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;

      if (target.closest('[data-veox-agent-close="1"]')) return;

      // Block trusted user clicks on locked Image/Video mode tab or blocked Flow Agent controls
      const lockedModeTab = target.closest('[data-veox-locked-mode="1"], [data-veox-agent-blocked="1"]');
      if (lockedModeTab && e.isTrusted) {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
      }

      const actionable = target.closest('a, button, [role="button"], [role="menuitem"], [role="option"], [role="tab"], [role="link"]') || target;
      const txt = (actionable.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const ariaLabel = ((actionable.getAttribute?.('aria-label') || '') + ' ' + (actionable.getAttribute?.('title') || '')).replace(/\s+/g, ' ').trim().toLowerCase();
      const href = String(actionable.getAttribute?.('href') || '');

      if (
        e.isTrusted &&
        isFlowHost &&
        !actionable.closest('#bunny-user-projects-history, #bunny-onscreen-projects-modal, #bunny-onscreen-projects-btn') &&
        (/^(?:use\s+|flow\s+)?agent$/.test(txt) || /^(?:use\s+|flow\s+)?agent(?:\s+mode)?$/.test(ariaLabel))
      ) {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
      }

      const isSignOutOrSwitch =
        txt === 'sign out of all accounts' ||
        txt === 'sign out' ||
        txt === 'log out' ||
        txt === 'switch account' ||
        txt === 'add another account' ||
        txt === 'manage your google account' ||
        href.includes('accounts.google.com/Logout') ||
        href.includes('accounts.google.com/signout') ||
        href.includes('accounts.google.com/AddSession');

      const isUpgradeOrManage =
        txt === 'upgrade' ||
        txt === 'manage subscription' ||
        /^\d[\d,]*\s+google\s+flow\s+credits?$/i.test(txt);

      if (isSignOutOrSwitch) {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (evType === 'click' || evType === 'mouseup') {
          try {
            window.top.location.href = 'https://flow.toolsbydcx.com/';
          } catch (_) {
            window.location.href = 'https://flow.toolsbydcx.com/';
          }
        }
        return;
      }

      if (isUpgradeOrManage) {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (evType === 'click') {
          window.open('https://flow.toolsbydcx.com/pricing', '_blank');
        }
      }
    }, true);
  }

  function hideVideoExtendPromptBox() {
    if (!document.body || !isFlowHost) return;

    // 1. Hide any prompt container explicitly carrying "Describe how to edit..." placeholder/label
    const editInputs = document.querySelectorAll(
      '[placeholder*="Describe how to edit" i], [data-placeholder*="Describe how to edit" i], [aria-placeholder*="Describe how to edit" i], [aria-label*="Describe how to edit" i], [placeholder*="edit this video" i], [data-placeholder*="edit this video" i]'
    );
    for (let i = 0; i < editInputs.length; i++) {
      let box = editInputs[i];
      let target = box;
      for (let d = 0; d < 7 && box && box !== document.body && box.tagName !== 'MAIN'; d++) {
        if (box.querySelector && box.querySelector('video')) break;
        const r = box.getBoundingClientRect();
        if (r.height > 0 && r.height <= 220 && r.width <= 1000) {
          target = box;
        }
        box = box.parentElement;
      }
      target.setAttribute('data-veox-hide', 'true');
    }

    // 2. Detect Video Click / Extend Editor mode via top-bar ("Done" + "Hide history" / "Show history")
    let hasDoneBtn = false;
    let hasHistoryToggle = false;
    const btns = document.querySelectorAll('button, [role="button"]');
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      const t = (b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const aria = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')).toLowerCase();
      if (t === 'done') hasDoneBtn = true;
      if (t.includes('hide history') || t.includes('show history') || aria.includes('hide history') || aria.includes('show history')) {
        hasHistoryToggle = true;
      }
      if (/\bextend\b/i.test(aria)) {
        b.setAttribute('data-veox-hide', 'true');
      }
    }

    if (hasDoneBtn && hasHistoryToggle) {
      const promptCandidates = document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]');
      for (let i = 0; i < promptCandidates.length; i++) {
        let curr = promptCandidates[i];
        let best = curr;
        for (let d = 0; d < 7 && curr && curr !== document.body && curr.tagName !== 'MAIN'; d++) {
          if (curr.querySelector && curr.querySelector('video')) break;
          const r = curr.getBoundingClientRect();
          if (r.height > 0 && r.height <= 220 && r.top >= window.innerHeight * 0.55) {
            best = curr;
          }
          curr = curr.parentElement;
        }
        best.setAttribute('data-veox-hide', 'true');
      }
    }
  }

  let lastAgentCloseClickTs = 0;
  let agentCloseAttemptCount = 0;

  function findRightSideAgentPanels() {
    const found = [];
    if (!document.body || !isFlowHost || window !== window.top) return found;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    if (vw < 560 || vh < 320) return found;

    // Strategy A (Universal): Any prompt input ("What do you want to create?" / textarea / contenteditable / textbox)
    // docked inside the right-hand side column (catches BOTH "Untitled session" AND any existing chat history!)
    const inputs = document.querySelectorAll(
      'textarea, [contenteditable="true"], [role="textbox"], [placeholder*="What do you want to create" i], [data-placeholder*="What do you want to create" i], [aria-placeholder*="What do you want to create" i], [aria-label*="What do you want to create" i]'
    );
    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i];
      if (inp.closest('#bunny-user-projects-history, #bunny-onscreen-projects-modal, #bunny-onscreen-projects-btn')) continue;
      const ir = inp.getBoundingClientRect();
      if (ir.width < 90 || ir.width > 580 || ir.height <= 0) continue;
      const centerX = ir.left + ir.width / 2;
      if (ir.left < vw * 0.52 || centerX < vw * 0.64) continue;

      let curr = inp.parentElement;
      let outerPanel = null;
      for (let d = 0; d < 16 && curr && curr !== document.body && curr.tagName !== 'MAIN'; d++) {
        const cr = curr.getBoundingClientRect();
        if (cr.left < vw * 0.45 || cr.width > 650) break;
        if (cr.left >= vw * 0.50 && cr.width >= 210 && cr.width <= 630 && cr.height >= 240) {
          outerPanel = curr;
        }
        curr = curr.parentElement;
      }
      if (outerPanel && !found.includes(outerPanel)) {
        found.push(outerPanel);
      }
    }

    // Strategy B (Fallback if Agent panel rendered before input mounted)
    const candidates = document.querySelectorAll('aside, [role="complementary"], section, div');
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (found.includes(el) || (el.id && el.id.startsWith('bunny-'))) continue;
      const r = el.getBoundingClientRect();
      if (r.left < vw * 0.50 || r.width < 210 || r.width > 630 || r.height < 260) continue;
      const lower = (el.textContent || '').toLowerCase();
      if (
        lower.includes('what would you like to create?') ||
        lower.includes('teach me about what you can do') ||
        lower.includes('build a visual moodboard') ||
        lower.includes('untitled session') ||
        lower.includes('show thinking')
      ) {
        let topEl = el;
        let p = el.parentElement;
        for (let d = 0; d < 10 && p && p !== document.body && p.tagName !== 'MAIN'; d++) {
          const pr = p.getBoundingClientRect();
          if (pr.left < vw * 0.45 || pr.width > 650) break;
          if (pr.left >= vw * 0.50 && pr.width >= 210 && pr.width <= 630 && pr.height >= 260) {
            topEl = p;
          }
          p = p.parentElement;
        }
        if (!found.includes(topEl)) found.push(topEl);
      }
    }

    return found;
  }

  function disableAndCloseFlowAgent() {
    if (!document.body || !isFlowHost) return;

    // 1. If Google Flow's Agent Mode toggle chip is ON (aria-pressed="true"), click it OFF first, then hide & disable it
    const controls = document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], [role="tab"]');
    for (let i = 0; i < controls.length; i++) {
      const el = controls[i];
      if (el.closest('#bunny-user-projects-history, #bunny-onscreen-projects-modal, #bunny-onscreen-projects-btn, #bunny-injected-credits-card, #bunnyflow-free-ticker, #bunnyflow-floating-upgrade, #bunny-locked-mode-toast')) continue;
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const aria = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '')).replace(/\s+/g, ' ').trim();
      if (el.classList?.contains('agent-mode-chip') || /^(?:use\s+|flow\s+)?agent$/i.test(txt) || /^(?:use\s+|flow\s+)?agent(?:\s+mode)?$/i.test(aria)) {
        const isChipActive = el.getAttribute('aria-pressed') === 'true' || el.classList?.contains('agent-mode-chip-checked');
        if (isChipActive) {
          el.removeAttribute('data-veox-agent-blocked');
          el.removeAttribute('data-veox-hide');
          el.removeAttribute('aria-disabled');
          if ('disabled' in el && el.disabled) {
            try { el.disabled = false; } catch (_) {}
          }
          const nowTs = Date.now();
          if (nowTs - lastAgentCloseClickTs > 450) {
            lastAgentCloseClickTs = nowTs;
            try { el.click(); } catch (_) {}
            try { firePointerSeq(el); } catch (_) {}
          }
          continue;
        }
        el.setAttribute('data-veox-agent-blocked', '1');
        el.setAttribute('data-veox-hide', 'true');
        el.setAttribute('aria-disabled', 'true');
        if ('disabled' in el && !el.disabled) {
          try { el.disabled = true; } catch (_) {}
        }
      }
    }

    // 2. Detect ANY open right-hand Agent side panel (empty session OR existing chat history), hide it, and auto-click [ X ]
    const agentPanels = findRightSideAgentPanels();
    for (let i = 0; i < agentPanels.length; i++) {
      const panel = agentPanels[i];
      const r = panel.getBoundingClientRect();

      // Find top-right [ X ] Close control BEFORE mutating styles
      let closeBtn = null;
      let rightmostHeaderBtn = null;
      let rightmostRight = -1;
      const panelBtns = panel.querySelectorAll('button, [role="button"], a');
      for (let k = 0; k < panelBtns.length; k++) {
        const b = panelBtns[k];
        const br = b.getBoundingClientRect();
        if (br.width < 10 || br.width > 68 || br.height < 10 || br.height > 68) continue;
        if (br.top < r.top - 10 || br.top > r.top + 96) continue;
        if (br.left < r.left + r.width * 0.5) continue;

        const bTxt = (b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const bAria = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')).toLowerCase();
        if (/new\s+session|history|menu|edit|add/i.test(bAria) || bTxt === 'edit_square' || bTxt === 'add') continue;

        if (/close|dismiss/i.test(bAria) || bTxt === 'close' || bTxt === 'x' || bTxt === '×' || bTxt === '✕') {
          closeBtn = b;
          break;
        }
        if (br.right > rightmostRight) {
          rightmostRight = br.right;
          rightmostHeaderBtn = b;
        }
      }

      let targetClose = closeBtn || rightmostHeaderBtn;
      if (!targetClose) {
        const fallbackEls = panel.querySelectorAll('div, span, i, svg');
        for (let k = 0; k < fallbackEls.length; k++) {
          const el = fallbackEls[k];
          const br = el.getBoundingClientRect();
          if (br.width < 12 || br.width > 48 || br.height < 12 || br.height > 48) continue;
          if (br.top < r.top || br.top > r.top + 76 || br.right < r.right - 52) continue;
          if (br.right > rightmostRight) {
            rightmostRight = br.right;
            targetClose = (el.tagName === 'SVG' || el.tagName === 'I') && el.parentElement && el.parentElement !== panel
              ? el.parentElement
              : el;
          }
        }
      }

      // Immediately make the entire Agent panel invisible & non-interactive (keeping layout bounds until React unmounts it)
      panel.style.setProperty('opacity', '0', 'important');
      panel.style.setProperty('pointer-events', 'none', 'important');

      const agentInputs = panel.querySelectorAll('form, textarea, [contenteditable="true"], [role="textbox"]');
      for (let j = 0; j < agentInputs.length; j++) {
        agentInputs[j].setAttribute('data-veox-agent-blocked', '1');
      }

      // Auto-click [ X ] Close button so Google Flow closes the Agent panel and restores the centered bottom prompt bar
      const now = Date.now();
      if (targetClose && now - lastAgentCloseClickTs > 350) {
        lastAgentCloseClickTs = now;
        agentCloseAttemptCount++;
        targetClose.setAttribute('data-veox-agent-close', '1');
        try {
          if (agentCloseAttemptCount % 2 === 1 && typeof targetClose.click === 'function') {
            targetClose.click();
          } else {
            firePointerSeq(targetClose);
          }
        } catch (_) {
          try { firePointerSeq(targetClose); } catch (__) {}
        }
        break;
      }
    }
  }

  function applyDomShield() {
    injectStyle();
    updatePageModeAttribute();
    updateFloatingProjectsButton();

    if (isFlowHost) {
      hideVideoExtendPromptBox();
      disableAndCloseFlowAgent();
      enforceFlowMediaMode();
      const { imageRadio: curImgTab } = findMediaModeTabs();
      const userSelectedImg = Boolean(curImgTab && isModeTabActive(curImgTab));
      if (currentFlowMode !== 'image' && !userSelectedImg) {
        handleModelMenus();
        autoSelectAllowedModel();
        updateTriggerLabel();
        enforceOmniResolutionRow();
      } else if (userSelectedImg) {
        document.querySelectorAll('[data-veox-custom-row="true"], [data-veox-locked-model="1"]').forEach(el => el.remove());
        document.querySelectorAll('[data-veox-hidden-native="1"]').forEach(el => {
          el.removeAttribute('data-veox-hidden-native');
          el.style.removeProperty('display');
          el.style.removeProperty('visibility');
          el.style.removeProperty('height');
          el.style.removeProperty('min-height');
          el.style.removeProperty('margin');
          el.style.removeProperty('padding');
          el.style.removeProperty('overflow');
        });
      }
      sanitizeCreditFooter();
      enforcePlanBatchLimit();
      enforceFreePlanBanners();
      checkFailedVideoRefunds();
      customizeGoogleAccountMenu();
    }

    const openAccountPopup = isFlowHost ? findOpenGoogleAccountMenuPopup() : null;
    const clickableEls = document.querySelectorAll('a, button, [role="button"], [role="menuitem"], [role="link"], li, div');
    for (const el of clickableEls) {
      if (el.closest('#bunny-user-projects-history, #bunny-onscreen-projects-modal, #bunny-onscreen-projects-btn, #bunny-injected-credits-card, #bunnyflow-free-ticker, #bunnyflow-floating-upgrade, #bunny-locked-mode-toast')) continue;
      if (el.getAttribute('data-veox-hide') === 'true') continue;

      const txt = (el.textContent || '').trim();
      const lower = txt.toLowerCase();

      // B. On flow.google.com: Hide "You're running low on Google Flow credits" & "You're out of Google Flow credits" banners
      if (isFlowHost) {
        // Never hide anything inside the Google Account Menu popup (handled by customizeGoogleAccountMenu)
        if (openAccountPopup && openAccountPopup.contains(el)) continue;
        const inAccountMenu = el.closest('[role="dialog"], [data-radix-popper-content-wrapper]') ||
                              (el.parentElement && (el.parentElement.textContent || '').includes('Sign out of all accounts'));
        if (inAccountMenu) continue;

        const matchesCreditBanner =
          lower.includes('out of google flow credits') ||
          lower.includes('running low on google flow credits') ||
          lower.includes('wait until they refresh or top up') ||
          lower.includes('top up to get more google flow credits') ||
          lower.includes('credits will reset monthly') ||
          lower.includes('top up to get more now') ||
          remoteHidePhrases.some(p => p && lower.includes(p));

        if (matchesCreditBanner) {
          if (
            el.tagName !== 'BODY' &&
            el.tagName !== 'HTML' &&
            el.tagName !== 'MAIN' &&
            txt.length < 340 &&
            el.offsetHeight < 160
          ) {
            el.setAttribute('data-veox-hide', 'true');
          }
        }

        if (lower === 'add ai credits') {
          const openMenu = findOpenGoogleAccountMenuPopup();
          if (!openMenu || !openMenu.contains(el)) {
            el.setAttribute('data-veox-hide', 'true');
            let curr = el.parentElement;
            while (curr && curr !== document.body && curr.tagName !== 'MAIN') {
              const cText = (curr.textContent || '').trim();
              if (cText.length < 340 && curr.offsetHeight > 0 && curr.offsetHeight < 160) {
                curr.setAttribute('data-veox-hide', 'true');
              }
              curr = curr.parentElement;
            }
          }
        }
      }
    }

    // C. On flow.google.com Home Page: Extract thumbnail for user's own projects if native card has one, then hide global project cards
    if (isFlowHomePage()) {
      const projectLinks = document.querySelectorAll('a[href*="/project/"]');
      for (const link of projectLinks) {
        if (link.closest('#bunny-user-projects-history')) continue;
        const pid = extractProjectId(link.getAttribute('href') || link.href || '');
        const card = link.closest('[role="listitem"], [role="gridcell"], article, li') || link.parentElement;

        // If this native card belongs to the current user and we don't have its thumbnail yet, grab its real image!
        if (pid && userProjectMap.has(pid)) {
          const existing = userProjectMap.get(pid);
          if (!existing.thumbnail) {
            const scope = card || link;
            const img = scope.querySelector('img');
            const vid = scope.querySelector('video');
            const harvestedThumb = (img && (img.currentSrc || img.src)) || (vid && vid.poster) || null;
            if (harvestedThumb && harvestedThumb.startsWith('http')) {
              existing.thumbnail = harvestedThumb;
              chrome.runtime.sendMessage({
                type: 'SAVE_USER_PROJECT',
                projectId: pid,
                projectUrl: existing.projectUrl || link.href,
                title: existing.title,
                thumbnail: harvestedThumb
              }, (res) => {
                if (res?.projects) setUserProjects(res.projects);
              });
            }
          }
        }

        link.setAttribute('data-veox-project-card', 'true');
        if (card && card !== document.body && !card.textContent?.toLowerCase().includes('new project')) {
          card.setAttribute('data-veox-project-card', 'true');
        }
      }

      const dateRegex = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s*-\s*\d{1,2}:\d{2}$/i;
      const allNodes = document.querySelectorAll('span, div, p, time');
      for (const node of allNodes) {
        if (node.closest('#bunny-user-projects-history, #bunny-onscreen-projects-modal, #bunny-onscreen-projects-btn')) continue;
        const t = (node.textContent || '').trim();
        if (dateRegex.test(t)) {
          let curr = node.parentElement;
          let tile = node;
          while (curr && curr !== document.body && curr.tagName !== 'MAIN') {
            const rect = curr.getBoundingClientRect();
            if (rect.width > 120 && rect.width < 650 && rect.height > 80 && rect.height < 500) {
              if (!curr.textContent?.toLowerCase().includes('new project') && !curr.querySelector('#bunny-user-projects-history')) {
                tile = curr;
              }
            }
            curr = curr.parentElement;
          }
          if (tile && !tile.textContent?.toLowerCase().includes('new project') && !tile.closest('#bunny-user-projects-history')) {
            tile.setAttribute('data-veox-project-card', 'true');
          }
        }
      }

      renderHomeProjectHistory();
    } else {
      const old = document.getElementById('bunny-user-projects-history');
      if (old) old.remove();
      lastRenderedHistorySig = '';
      monitorActiveProjectPage();
    }
  }

  let scheduled = false;
  function scheduleShield() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      applyDomShield();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      refreshUserProjects();
      scheduleShield();
    }, { once: true });
  } else {
    refreshUserProjects();
    scheduleShield();
  }

  const observer = new MutationObserver(scheduleShield);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', () => {
    refreshUserProjects();
    scheduleShield();
  });
  setInterval(scheduleShield, 600);
  setInterval(monitorActiveProjectPage, 1800);
  setInterval(refreshUserProjects, 5000);

  // Smart Server Switch Quick Recovery Pill on Google Flow Error Alerts
  if (isFlowHost && window === window.top) {
    let lastErrorToastDismissedAt = 0;
    const FLOW_ERROR_RE = /unusual\s+activity|failed\s+to\s+load|upgrade\s+plan\s+to\s+use\s+flow|something\s+went\s+wrong/i;

    function showSmartSwitchToast() {
      if (currentFlowMode === 'image') return;
      if (!document.body || document.getElementById('bunny-smart-switch-toast')) return;
      if (Date.now() - lastErrorToastDismissedAt < 60000) return;

      const isFreeTier = getPlanTier() === 'free';
      const box = document.createElement('div');
      box.id = 'bunny-smart-switch-toast';
      box.style.cssText = `position:fixed;bottom:${isFreeTier ? '58px' : '20px'};right:20px;z-index:2147483646;display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:12px;background:#11131f;border:1px solid ${isFreeTier ? 'rgba(168,85,247,0.6)' : 'rgba(56,189,248,0.55)'};box-shadow:0 10px 28px rgba(0,0,0,0.55);color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:12.5px;font-weight:600;`;
      if (isFreeTier) {
        box.innerHTML = `
          <span style="color:#f3e8ff;">⚡ Free Trial Slow Queue — errors are normal</span>
          <a href="https://flow.toolsbydcx.com/pricing" target="_blank" style="padding:6px 11px;border-radius:8px;background:linear-gradient(135deg,#a855f7,#ec4899);color:#fff;font-size:12px;font-weight:700;text-decoration:none;">Upgrade Plan →</a>
          <button type="button" id="bunny-toast-close-btn" style="padding:2px 5px;border:none;background:transparent;color:#94a3b8;font-size:14px;cursor:pointer;line-height:1;">✕</button>
        `;
      } else {
        box.innerHTML = `
          <span style="color:#fde68a;">⚡ Server busy?</span>
          <button type="button" id="bunny-toast-switch-btn" style="padding:6px 11px;border-radius:8px;border:none;background:linear-gradient(135deg,#0284c7,#4f46e5);color:#fff;font-size:12px;font-weight:700;cursor:pointer;">🔀 Switch Server</button>
          <button type="button" id="bunny-toast-close-btn" style="padding:2px 5px;border:none;background:transparent;color:#94a3b8;font-size:14px;cursor:pointer;line-height:1;">✕</button>
        `;
      }
      document.body.appendChild(box);

      box.querySelector('#bunny-toast-close-btn')?.addEventListener('click', () => {
        lastErrorToastDismissedAt = Date.now();
        box.remove();
      });

      const swBtn = box.querySelector('#bunny-toast-switch-btn');
      swBtn?.addEventListener('click', () => {
        swBtn.disabled = true;
        swBtn.textContent = 'Switching...';
        try {
          chrome.runtime.sendMessage({ type: 'SWITCH_SERVER', reason: 'flow_error_toast' }, (res) => {
            if (res?.success) {
              swBtn.textContent = `✅ Server ${res.serverNumber || ''} Ready!`;
              setTimeout(() => { location.reload(); }, 350);
            } else {
              swBtn.disabled = false;
              swBtn.textContent = '🔀 Switch Server';
            }
          });
        } catch (_) {
          box.remove();
        }
      });
    }

    setInterval(() => {
      if (currentFlowMode === 'image') {
        document.getElementById('bunny-smart-switch-toast')?.remove();
        return;
      }
      if (!document.body || document.getElementById('bunny-smart-switch-toast')) return;
      if (Date.now() - lastErrorToastDismissedAt < 60000) return;
      const alerts = document.querySelectorAll('[role="alert"], [role="status"], snack-bar-container, mat-snack-bar-container, [class*="snackbar" i], [class*="toast" i], [class*="error" i]');
      for (const el of alerts) {
        if (el.id === 'bunny-smart-switch-toast') continue;
        const txt = (el.textContent || '').trim();
        if (txt && txt.length < 260 && FLOW_ERROR_RE.test(txt)) {
          showSmartSwitchToast();
          break;
        }
      }
    }, 2500);
  }
})();
