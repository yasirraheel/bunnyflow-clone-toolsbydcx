// Tools By DCX v2.4.8 — Sticky Multi-Server Pool + Direct Website Auto-Sync + Maintenance Screen Engine
// 1. Direct Website Auto-Sync (connects automatically when logged in on flow.toolsbydcx.com; disconnects automatically on website sign-out)
// 2. Strictly scopes cookies in memory to flow.google.com, aisandbox-pa.googleapis.com, and labs.google
// 3. Strips Set-Cookie response headers & blocks RotateCookies/Logout so Master Google Accounts stay healthy
// 4. Deterministic Sticky Multi-Server Switch + Zero-Refresh Sync + Clean Image Mode + Maintenance Screen
"use strict";

importScripts("cookie-core.js");

const DEFAULT_BACKEND_URLS = [
  "https://flow.toolsbydcx.com/api"
];

const EXT_V2_HEADER = "manual-2.0";
const EXT_VERSION = (typeof chrome !== "undefined" && chrome.runtime?.getManifest)
  ? (chrome.runtime.getManifest().version || "2.4.8")
  : "2.4.8";
const EXT_EDITION = `Tools By DCX v${EXT_VERSION}`;
const EXT_SECURE_TOKEN = "abb8bac894eb9a7cf987c2da45bae4d3";
const FLOW_HOME = "https://flow.google.com/";
const FLOW_ABOUT = "https://flow.google.com/about";
const SESSION_RULE_IDS = [9901, 9902, 9903, 9904];
const COOKIE_SCOPES = [
  { id: 9901, cookieRoot: "google.com", requestDomains: ["flow.google.com", "aisandbox-pa.googleapis.com"] },
  { id: 9902, cookieRoot: "labs.google", requestDomains: ["labs.google"] }
];
const ALL_RESOURCE_TYPES = [
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object",
  "xmlhttprequest", "ping", "csp_report", "media", "websocket", "other"
];

let isSyncing = false;
let activeSyncPromise = null;
let dnrQueue = Promise.resolve();
let isSwitchingServer = false;
let manualSwitchLockUntil = 0;
let lastBgPortalSyncAt = 0;
let isLoggingOut = false;
let webSsoPromise = null;
let preferredBackendBase = DEFAULT_BACKEND_URLS[0];
const tabFailoverCooldown = new Map();
const tabSameSlotRetryMap = new Map();
const tabAboutRedirectCooldown = new Map();
const knownFlowTabIds = new Set();

function safeRedirectAboutTabToHome(tabId) {
  if (!Number.isInteger(tabId)) return;
  const nowMs = Date.now();
  const prev = tabAboutRedirectCooldown.get(tabId) || { ts: 0, count: 0 };
  if (nowMs - prev.ts < 15000) {
    // Ignore duplicate /about events within 2.5s of the first redirect; if it bounces again after 2.5s, heal/failover once.
    if (nowMs - prev.ts >= 2500 && prev.count === 1) {
      tabAboutRedirectCooldown.set(tabId, { ts: nowMs, count: 2 });
      handleFlowTabAuthDrop(tabId, FLOW_ABOUT).catch(() => {});
    }
    return;
  }
  tabAboutRedirectCooldown.set(tabId, { ts: nowMs, count: 1 });
  chrome.tabs.update(tabId, { url: FLOW_HOME }).catch(() => {});
}

function getMaintenanceUrl(mode = "video") {
  return mode === "image"
    ? "https://flow.toolsbydcx.com/google-flow-maintenance?tool=nano-banana"
    : "https://flow.toolsbydcx.com/google-flow-maintenance?tool=google-flow";
}

function compareSemver(a, b) {
  const pa = String(a || "0.0.0").trim().replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0.0.0").trim().replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function updateExtensionVersionBadge(cfg) {
  try {
    if (!chrome.action?.setBadgeText) return;
    const remoteLatest = String(cfg?.latestVersion || cfg?.version || "").trim();
    const minReq = String(cfg?.minRequiredVersion || "").trim();
    if (remoteLatest && compareSemver(remoteLatest, EXT_VERSION) > 0) {
      const isUrgent = Boolean(minReq && compareSemver(minReq, EXT_VERSION) > 0);
      chrome.action.setBadgeText({ text: "UPD" });
      chrome.action.setBadgeBackgroundColor({ color: isUrgent ? "#ef4444" : "#f59e0b" });
      chrome.action.setTitle({
        title: `Tools By DCX — New Update v${remoteLatest} Available! Click to download.`
      });
    } else {
      chrome.action.setBadgeText({ text: "" });
      chrome.action.setTitle({ title: EXT_EDITION });
    }
  } catch (_) {}
}


// ToolsByDcx: only the session + web-sso + logout endpoints exist on our backend.
// The remaining ToolsByDcx v2 endpoints (credits, projects, switch-server, live-config,
// report-slot-issue) are answered locally with a safe empty success so every
// caller in this file keeps working until those features are added server-side.
const TBD_STUB_ENDPOINTS = new Set([
  "/extension/switch-server",
  "/extension/report-slot-issue",
  "/extension/credits",
  "/extension/projects",
  "/extension/live-config",
]);
const TBD_STUB_PAYLOADS = {
  "/extension/projects": { success: true, projects: [] },
  "/extension/credits": { success: true },
  "/extension/live-config": { success: true },
};

async function fetchBackend(endpoint, options = {}, token = null) {
  const stubPath = String(endpoint || "").split("?")[0];
  if (TBD_STUB_ENDPOINTS.has(stubPath)) {
    return { res: { ok: true, status: 200 }, data: TBD_STUB_PAYLOADS[stubPath] || { success: true } };
  }
  const headers = {
    "Accept": "application/json",
    "x-tbd-ext-v2": EXT_V2_HEADER,
    "x-tbd-ext-version": EXT_VERSION,
    "x-tbd-ext-token": EXT_SECURE_TOKEN,
    ...(options.headers || {})
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 15000;
  const maxAttempts = options.noRetry ? 1 : 2;
  let lastErr = null;
  const orderedUrls = [
    preferredBackendBase,
    ...DEFAULT_BACKEND_URLS.filter((u) => u !== preferredBackendBase)
  ].filter(Boolean);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    for (const baseUrl of orderedUrls) {
      try {
        const res = await fetch(`${baseUrl}${endpoint}`, {
          ...options,
          headers,
          cache: "no-store",
          signal: options.signal || AbortSignal.timeout(timeoutMs)
        });
        const ct = res.headers.get("content-type") || "";
        if (!ct.toLowerCase().includes("application/json")) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!data || typeof data !== "object" || (!("success" in data) && !("ok" in data))) {
          throw new Error(`Invalid backend payload (${res.status})`);
        }
        preferredBackendBase = baseUrl;
        return { res, data, baseUrl };
      } catch (e) {
        lastErr = e;
      }
    }
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (lastErr && (lastErr.name === "AbortError" || lastErr.name === "TimeoutError" || /aborted/i.test(String(lastErr.message || "")))) {
    throw new Error("Server busy — please try again in 2 seconds.");
  }
  throw lastErr || new Error("Backend unreachable");
}

function isFlowUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "flow.google.com" ||
      ((url.hostname === "labs.google" || url.hostname.endsWith(".labs.google")) &&
        /^\/fx\/(?:[a-z]{2,3}(?:-[a-z0-9]{2,8})*\/)?tools\/flow(?:\/|$)/i.test(url.pathname)));
  } catch (_) { return false; }
}

function isGoogleAuthDropUrl(value) {
  const u = String(value || "").toLowerCase();
  if (!u.includes("accounts.google.com/")) return false;
  return (
    u.includes("/servicelogin") ||
    u.includes("/interactivelogin") ||
    u.includes("/signin") ||
    u.includes("/accountchooser") ||
    u.includes("/cookiemismatch") ||
    u.includes("/logout") ||
    u.includes("/signout")
  );
}

async function captureFlowTabs() {
  const tabs = await chrome.tabs.query({});
  const captured = [];
  for (const tab of tabs) {
    if (!Number.isInteger(tab.id)) continue;
    const url = tab.pendingUrl || tab.url || "";
    if (isFlowUrl(url)) {
      captured.push({ id: tab.id, url });
    }
  }
  return captured;
}

function cookieHeaderFor(prepared, root) {
  const byName = new Map();
  for (const p of prepared) {
    if (p.expected.domain === root || p.expected.domain.endsWith("." + root)) {
      byName.set(p.details.name, p.details.value);
    }
  }
  return [...byName.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function clearConflictingFlowCookies() {
  try {
    if (!chrome.cookies?.getAll) return;
    const flowCookies = await chrome.cookies.getAll({ domain: "flow.google.com" }).catch(() => []);
    for (const c of flowCookies) {
      const d = String(c.domain || "").replace(/^\.+/, "");
      if (d === "flow.google.com") {
        await chrome.cookies.remove({
          url: `https://flow.google.com${c.path || "/"}`,
          name: c.name,
          storeId: c.storeId
        }).catch(() => {});
      }
    }
  } catch (_) {}
}


// ToolsByDcx: also write the session cookies into the browser cookie jar,
// WeMate-style. DNR header injection alone leaves accounts.google.com checks
// seeing an empty jar, so Flow redirects to the sign-in page. Writing the jar
// makes every Google domain see the shared session.
const JAR_AUTH_COOKIE_NAMES = new Set([
  "__Secure-1PSID", "__Secure-3PSID", "__Secure-1PSIDTS", "__Secure-3PSIDTS",
  "__Secure-1PAPISID", "__Secure-3PAPISID", "__Secure-1PSIDCC", "__Secure-3PSIDCC",
  "SID", "SAPISID", "APISID", "HSID", "SSID", "LSID",
  "__Host-GAPS", "NID", "OSID", "__Secure-OSID", "SIDCC"
]);

async function clearSharedAuthCookiesFromJar() {
  try {
    if (!chrome.cookies?.getAll) return;
    for (const domain of ["google.com", "accounts.google.com", "labs.google", "flow.google.com"]) {
      const cookies = await chrome.cookies.getAll({ domain }).catch(() => []);
      for (const c of cookies || []) {
        if (!JAR_AUTH_COOKIE_NAMES.has(c.name)) continue;
        const protocol = c.secure ? "https://" : "http://";
        const host = (c.domain && c.domain.startsWith(".")) ? c.domain.slice(1) : (c.domain || domain);
        await chrome.cookies.remove({ url: protocol + host + (c.path || "/"), name: c.name, storeId: c.storeId }).catch(() => {});
      }
    }
  } catch (_) {}
}

function jarSetCookieAttempt(initialOpts, targetUrl) {
  return new Promise((resolve) => {
    function runAttempt(attemptOpts, attemptNum) {
      chrome.cookies.set(attemptOpts, (res) => {
        if (chrome.runtime.lastError && attemptNum < 4) {
          const next = { ...attemptOpts };
          if (attemptNum === 0) {
            if (targetUrl) next.url = targetUrl;
            delete next.domain;
          } else if (attemptNum === 1) {
            next.sameSite = "lax";
          } else if (attemptNum === 2) {
            next.sameSite = "unspecified";
          } else {
            next.value = encodeURIComponent(String(next.value || "")).replace(/[!'()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
          }
          if ((attemptOpts.name.startsWith("__Secure-") || attemptOpts.name.startsWith("__Host-")) && !next.secure) {
            next.secure = true;
          }
          runAttempt(next, attemptNum + 1);
        } else {
          resolve(!!res);
        }
      });
    }
    runAttempt(initialOpts, 0);
  });
}

async function writePreparedCookiesToJar(prepared) {
  if (!Array.isArray(prepared) || !prepared.length) return { applied: 0, failed: 0 };
  if (!chrome.cookies?.set) return { applied: 0, failed: prepared.length };
  await clearSharedAuthCookiesFromJar();
  let applied = 0, failed = 0;
  for (const item of prepared) {
    try {
      const d = item?.details;
      if (!d || !d.name) { failed++; continue; }
      const opts = {
        url: d.url,
        name: d.name,
        value: String(d.value ?? ""),
        path: d.path || "/",
        secure: Boolean(d.secure),
        httpOnly: Boolean(d.httpOnly)
      };
      if (d.domain) opts.domain = d.domain;
      if (d.sameSite) opts.sameSite = d.sameSite;
      if (typeof d.expirationDate === "number" && Number.isFinite(d.expirationDate)) opts.expirationDate = d.expirationDate;
      if (d.partitionKey) opts.partitionKey = d.partitionKey;
      try { await chrome.cookies.remove({ url: opts.url, name: opts.name }); } catch (_) {}
      const ok = await jarSetCookieAttempt(opts, FLOW_HOME);
      if (ok) applied++; else failed++;
    } catch (_) { failed++; }
  }
  return { applied, failed };
}

async function applyDeclarativeSession(prepared) {
  if (!chrome.declarativeNetRequest?.updateSessionRules || !Array.isArray(prepared)) {
    throw new Error("This Chrome version cannot hold session rules in memory.");
  }
  const addRules = [];
  let googleCookieHeader = "";
  for (const scope of COOKIE_SCOPES) {
    const value = cookieHeaderFor(prepared, scope.cookieRoot);
    if (!value) continue;
    if (scope.id === 9901) googleCookieHeader = value;
    addRules.push({
      id: scope.id,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "Cookie", operation: "set", value }],
        responseHeaders: [{ header: "set-cookie", operation: "remove" }]
      },
      condition: { requestDomains: scope.requestDomains, resourceTypes: ALL_RESOURCE_TYPES }
    });
  }
  if (!addRules.length) throw new Error("The session has no cookies for flow.google.com or labs.google.");

  try {
    const existingRules = await chrome.declarativeNetRequest.getSessionRules();
    const existing9901 = existingRules.find((r) => r.id === 9901);
    const existingVal = existing9901?.action?.requestHeaders?.[0]?.value || "";
    if (googleCookieHeader && existingVal === googleCookieHeader && existingRules.some((r) => r.id === 9903)) {
      return;
    }
  } catch (_) {}

  await clearConflictingFlowCookies();

  addRules.push({
    id: 9903,
    priority: 2,
    action: { type: "block" },
    condition: {
      urlFilter: "||accounts.google.com/*RotateCookies*",
      initiatorDomains: ["flow.google.com", "labs.google"],
      resourceTypes: ["sub_frame", "xmlhttprequest", "ping", "script", "other"]
    }
  });
  addRules.push({
    id: 9904,
    priority: 2,
    action: { type: "block" },
    condition: {
      urlFilter: "||accounts.google.com/*Logout*",
      resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest", "ping", "other"]
    }
  });

  const runDnr = async () => {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: SESSION_RULE_IDS, addRules });
    try {
      const old = await chrome.declarativeNetRequest.getDynamicRules();
      if (old.length) await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old.map((r) => r.id) });
    } catch (_) {}
  };
  dnrQueue = dnrQueue.then(runDnr, runDnr);
  await dnrQueue;
  // Also write the cookies into the browser cookie jar so accounts.google.com
  // and every other Google domain see the shared session. Never fail the
  // DNR apply because of a jar write problem. The result is returned so the
  // popup can show whether the jar write worked.
  let jarWrite = null;
  try { jarWrite = await writePreparedCookiesToJar(prepared); } catch (_) {}
  return jarWrite;
}

async function sessionRulesActive() {
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    return rules.some((rule) => rule.id === 9901 || rule.id === 9902);
  } catch (_) { return false; }
}

async function clearDeclarativeSession() {
  const runClear = async () => {
    try {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: SESSION_RULE_IDS });
      const old = await chrome.declarativeNetRequest.getDynamicRules();
      if (old.length) await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old.map((r) => r.id) });
    } catch (_) {}
  };
  dnrQueue = dnrQueue.then(runClear, runClear);
  await dnrQueue;
}

async function performFullLogout(opts = {}) {
  if (isLoggingOut) return;
  isLoggingOut = true;
  try {
    const prev = await chrome.storage.local.get(["userToken"]);
    if (prev.userToken && !opts.skipServerRevoke) {
      fetchBackend(opts.fromWebLogout ? "/auth/logout" : "/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flowToken: opts.flowToken || "" })
      }, prev.userToken).catch(() => {});
    }
    const capturedTabs = await captureFlowTabs();
    await clearDeclarativeSession();
    await Promise.allSettled(capturedTabs.map((tab) =>
      chrome.tabs.update(tab.id, { url: FLOW_ABOUT })
    ));
    await chrome.storage.local.remove([
      "isLoggedIn",
      "userToken",
      "userEmail",
      "userName",
      "userPlan",
      "daysLeft",
      "expiresAt",
      "flowToken",
      "lastWebFlowToken",
      "activeSession",
      "poolInfo",
      "poolCookiesBySlot",
      "lastSyncSignature",
      "lastCookieSig",
      "selectedSessionId",
      "manualExtensionSignout"
    ]);
  } catch (e) {
    console.warn("Logout cleanup error:", e);
  } finally {
    isLoggingOut = false;
  }
}

async function syncServerCreditsState(userObj, cfgObj = null) {
  try {
    const epoch = String(userObj?.creditResetEpoch || cfgObj?.creditResetEpoch || "").trim();
    const st = await chrome.storage.local.get(["creditResetEpoch", "tbdSpentByTier"]);
    const updates = {};
    if (epoch && st.creditResetEpoch !== epoch) {
      updates.creditResetEpoch = epoch;
      updates.tbdSpentByTier = { free: 0, plus: 0, max: 0 };
    } else if (userObj?.spentCredits && typeof userObj.spentCredits === "object") {
      updates.tbdSpentByTier = {
        free: Math.max(0, Number(userObj.spentCredits.free || 0)),
        plus: Math.max(0, Number(userObj.spentCredits.plus || 0)),
        max: Math.max(0, Number(userObj.spentCredits.max || 0))
      };
    }
    if (Object.keys(updates).length > 0) {
      await chrome.storage.local.set(updates);
    }
  } catch (_) {}
}

async function applyLoginBundle(data, requestedMode = "video") {
  const flowMode = requestedMode === "image" ? "image" : "video";
  const u = data.user || {};
  const baseStore = {
    isLoggedIn: "true",
    userToken: data.token,
    userEmail: u.email || "",
    userName: u.username || (u.email || "").split("@")[0] || "Tools By DCX User",
    userPlan: u.plan || "Active Plan",
    daysLeft: u.daysLeft !== undefined ? u.daysLeft : 0,
    expiresAt: u.expiresAt || null,
    flowMode
  };

  await syncServerCreditsState(u, null);

  const slotObj = data.session || (Array.isArray(data.sessions) ? data.sessions[0] : null);
  const pool = data.pool || null;
  const rawCookies = Array.isArray(data.data) ? data.data : null;

  if (slotObj && rawCookies && rawCookies.length > 0) {
    const parsedCookies = self.CookieCore.parseCookieInput(JSON.stringify(rawCookies));
    const prepared = self.CookieCore.prepareImport(parsedCookies).prepared;
    const jarWrite = await applyDeclarativeSession(prepared);

    const slotId = slotObj.id;
    const slotNum = slotObj.slot || data.assignedSlot || (flowMode === "image" ? 2 : 1);
    const serverNumber = Number(slotObj.serverNumber || pool?.serverNumber || 1);
    const totalServers = Number(slotObj.totalServers || pool?.totalServers || 1);
    const cookieSig = String(data.cookieSig || slotObj.cookieSig || `${slotId}:${slotObj.actual_uploaded_at || slotObj.updated_at || ""}:${prepared.length}`);
    const newSig = `ACTIVE:${flowMode}:${cookieSig}`;
    const finalSchedule = slotObj.syncSchedule || data.syncSchedule || null;

    const sessionMeta = {
      slotId,
      slot: slotNum,
      slotName: slotObj.name || (flowMode === "image" ? "Session 2 - Image (Nano Banana)" : `Server ${serverNumber}`),
      flowMode,
      serverNumber,
      totalServers,
      pool,
      cookieCount: prepared.length,
      injectedCount: prepared.length,
      lastJarWrite: jarWrite || null,
      updatedAt: slotObj.actual_uploaded_at || slotObj.updated_at || new Date().toISOString(),
      syncedAt: Date.now(),
      status: "active",
      maintenance: false,
      maintenanceUrl: data.maintenanceUrl || getMaintenanceUrl(flowMode),
      limitReached: false,
      cookieSig,
      syncSchedule: finalSchedule
    };

    await chrome.storage.local.set({
      ...baseStore,
      selectedSessionId: slotId,
      sessionsList: Array.isArray(data.sessions) ? data.sessions : [slotObj],
      activeSession: sessionMeta,
      ...(pool ? { poolInfo: pool } : {}),
      ...(data.poolCookies && typeof data.poolCookies === "object" ? { poolCookiesBySlot: data.poolCookies } : {}),
      lastSyncSignature: newSig,
      lastCookieSig: cookieSig,
      lastAutoInjectedAt: Date.now(),
      lastAutoInjectedSession: sessionMeta.slotName,
      lastAutoInjectedCount: prepared.length,
      ...(finalSchedule ? { syncSchedule: finalSchedule } : {})
    });

    const capturedTabs = await captureFlowTabs();
    for (const tab of capturedTabs) {
      if (/^https:\/\/flow\.google\.com\/about(?:\/|\?|$)/i.test(tab.url || "")) {
        chrome.tabs.update(tab.id, { url: FLOW_HOME }).catch(() => {});
      }
    }

    return sessionMeta;
  }

  await chrome.storage.local.set({
    ...baseStore,
    ...(pool ? { poolInfo: pool } : {})
  });
  return await syncSessionsFromPortal(true);
}

// Sync Google Flow cookies for the logged-in user (Single-Roundtrip Fast Sync)
async function syncSessionsFromPortal(force = false, preferredSlotId = null) {
  if (!force && (isSwitchingServer || Date.now() < manualSwitchLockUntil)) {
    const st = await chrome.storage.local.get(["activeSession"]);
    return st.activeSession || null;
  }
  lastBgPortalSyncAt = Date.now();
  if (activeSyncPromise && !force && !preferredSlotId) {
    return await activeSyncPromise;
  }
  isSyncing = true;
  const runPromise = syncSessionsFromPortalInner(force, preferredSlotId);
  activeSyncPromise = runPromise;
  try {
    return await runPromise;
  } finally {
    if (activeSyncPromise === runPromise) {
      activeSyncPromise = null;
    }
    isSyncing = false;
  }
}

async function syncSessionsFromPortalInner(force = false, preferredSlotId = null) {
  try {
    const stored = await chrome.storage.local.get([
      "isLoggedIn",
      "userToken",
      "flowMode",
      "selectedSessionId",
      "lastSyncSignature",
      "lastCookieSig",
      "activeSession",
      "poolInfo",
      "lastAutoInjectedAt"
    ]);

    const token = stored.userToken;
    const flowMode = stored.flowMode === "image" ? "image" : "video";

    if (!token || stored.isLoggedIn !== "true") {
      if (await sessionRulesActive()) {
        await clearDeclarativeSession();
      }
      return null;
    }

    const rulesActive = await sessionRulesActive();
    const canReuseSig = !force && rulesActive && stored.activeSession?.flowMode === flowMode && Number(stored.activeSession?.cookieCount || 0) > 0;
    const sigParam = (canReuseSig && stored.lastCookieSig) ? `&sig=${encodeURIComponent(stored.lastCookieSig)}` : "";
    const activeVideoSlotPref = (
      !preferredSlotId &&
      flowMode === "video" &&
      stored.activeSession?.flowMode === "video" &&
      Number(stored.activeSession?.slot) >= 1
    ) ? Number(stored.activeSession.slot) : 0;
    const prefSlotParam = activeVideoSlotPref ? `&preferredSlot=${activeVideoSlotPref}` : "";

    let sessions = null;
    let syncSchedule = null;
    let pool = stored.poolInfo || null;
    let poolCookies = null;
    let inlineCookies = undefined;
    let cookiesUnchanged = false;
    let respCookieSig = null;
    let isMaintenance = false;
    let noAccount = false;
    let noValidCookies = false;
    let maintenanceUrl = getMaintenanceUrl(flowMode);
    let isLimitReached = false;

    try {
      const { res, data } = await fetchBackend(`/extension/session?mode=${flowMode}&includeCookies=1${prefSlotParam}${sigParam}&t=${Date.now()}`, {}, token);
      if (res.status === 403 && data?.upgrade_required) {
        const upgCfg = {
          latestVersion: data.latest_version || "9.9.9",
          minRequiredVersion: data.latest_version || "9.9.9",
          downloadUrl: data.download_url || "https://flow.toolsbydcx.com/extension",
          updateTitle: `Update Required (v${data.latest_version || "Latest"})`,
          updateMessage: data.error || "Please update your extension to continue."
        };
        await chrome.storage.local.set({ liveExtConfig: upgCfg });
        updateExtensionVersionBadge(upgCfg);
        return { ...(stored.activeSession || {}), upgradeRequired: true, latestVersion: upgCfg.latestVersion, error: upgCfg.updateMessage };
      }
      if (res.status === 401 || res.status === 403) {
        if (data?.code === "WEB_LOGGED_OUT" || data?.code === "PLAN_EXPIRED") {
          await performFullLogout({
            skipServerRevoke: true,
            fromWebLogout: data?.code === "WEB_LOGGED_OUT"
          });
          return null;
        }
        // If local extension JWT expired while website session is still active, silently re-SSO once instead of flapping!
        const reSso = await syncFromOpenToolsByDcxTabs({ force: true, mode: flowMode });
        if (reSso && reSso.loggedIn) {
          return reSso.session || null;
        }
        if (/Session invalid|suspended/i.test(String(data?.error || ""))) {
          await performFullLogout({ skipServerRevoke: true });
          return null;
        }
        return stored.activeSession || null;
      }
      if (data?.success) {
        sessions = Array.isArray(data.sessions) ? data.sessions : (Array.isArray(data.files) ? data.files : []);
        syncSchedule = data.syncSchedule || sessions?.[0]?.syncSchedule || null;
        respCookieSig = data.cookieSig || sessions?.[0]?.cookieSig || null;
        cookiesUnchanged = Boolean(data.cookiesUnchanged);
        isMaintenance = Boolean(data.maintenance);
        noAccount = Boolean(data.noAccount);
        noValidCookies = Boolean(data.noValidCookies);
        maintenanceUrl = data.maintenanceUrl || getMaintenanceUrl(flowMode);
        isLimitReached = Boolean(data.limitReached);
        if (Array.isArray(data.data)) {
          inlineCookies = data.data;
        }
        if (data.pool && typeof data.pool === "object") {
          pool = data.pool;
        }
        if (data.poolCookies && typeof data.poolCookies === "object") {
          poolCookies = data.poolCookies;
          await chrome.storage.local.set({ poolCookiesBySlot: data.poolCookies });
        }
        if (data.user && typeof data.user === "object") {
          const userUpdates = {};
          if (data.user.plan) userUpdates.userPlan = data.user.plan;
          if (data.user.daysLeft !== undefined) userUpdates.daysLeft = data.user.daysLeft;
          if (data.user.expiresAt !== undefined) userUpdates.expiresAt = data.user.expiresAt;
          if (Object.keys(userUpdates).length > 0) {
            await chrome.storage.local.set(userUpdates);
          }
          await syncServerCreditsState(data.user, null);
        }
      }
    } catch (_) {}

    if (!Array.isArray(sessions)) {
      return stored.activeSession || null;
    }

    await chrome.storage.local.set({
      sessionsList: sessions,
      ...(pool ? { poolInfo: pool } : {}),
      ...(syncSchedule ? { syncSchedule } : {})
    });

    const isImgSlot = (s) => s && (s.slot === 2 || s.mode === "image" || s.id === "session_image_2" || /session\s*2|image|nano/i.test(String(s.name || "")));
    let slot = null;
    if (preferredSlotId) {
      slot = sessions.find((s) => s.id === preferredSlotId) || null;
    }
    if (!slot) {
      if (flowMode === "image") {
        slot = sessions.find((s) => isImgSlot(s)) || null;
      } else {
        slot = sessions.find((s) => !isImgSlot(s) && Number(s.cookie_count || s.cookieCount || 0) > 0) ||
               sessions.find((s) => !isImgSlot(s)) ||
               null;
      }
    }

    const slotId = slot?.id || (flowMode === "image" ? "session_image_2" : "session1");
    const slotNum = slot?.slot || pool?.currentSlot || (flowMode === "image" ? 2 : 1);
    const serverNumber = Number(slot?.serverNumber || pool?.serverNumber || 1);
    const totalServers = Number(slot?.totalServers || pool?.totalServers || (slot ? 1 : 0));
    const slotName = slot?.name || (flowMode === "image" ? "Session 2 - Image (Nano Banana)" : "Session 1 - Video (Veo 3.1)");
    const remoteCount = Number(slot?.cookie_count ?? slot?.cookieCount ?? 0);
    const actualUploaded = String(slot?.actual_uploaded_at || slot?.uploaded_at || slot?.updated_at || "");
    const effectiveCookieSig = String(respCookieSig || slot?.cookieSig || `${slotId}:${actualUploaded}:${remoteCount}`);

    // CASE A: 0 healthy cookies on server for this mode (Maintenance or Capacity)
    if (!slot || remoteCount === 0) {
      const emptySig = `EMPTY:${flowMode}:${slotId}`;
      const needsClear = force || rulesActive || stored.lastSyncSignature !== emptySig || (stored.activeSession && stored.activeSession.cookieCount > 0);

      const emptyMeta = {
        slotId,
        slot: slotNum,
        slotName,
        flowMode,
        serverNumber: 0,
        totalServers: 0,
        pool,
        cookieCount: 0,
        injectedCount: 0,
        updatedAt: actualUploaded || new Date().toISOString(),
        syncedAt: Date.now(),
        status: isMaintenance ? "maintenance" : "empty",
        maintenance: isMaintenance || !isLimitReached,
        maintenanceUrl,
        limitReached: isLimitReached,
        noAccount,
        noValidCookies,
        syncSchedule
      };

      if (needsClear) {
        const capturedTabs = await captureFlowTabs();
        await clearDeclarativeSession();
        await Promise.allSettled(capturedTabs.map((tab) =>
          chrome.tabs.update(tab.id, { url: emptyMeta.maintenance ? maintenanceUrl : FLOW_ABOUT })
        ));
        await chrome.storage.local.set({
          activeSession: emptyMeta,
          lastSyncSignature: emptySig,
          lastCookieSig: ""
        });
      } else {
        await chrome.storage.local.set({ activeSession: emptyMeta });
      }
      return emptyMeta;
    }

    // CASE B: Slot has active healthy cookies on server
    const newSig = `ACTIVE:${flowMode}:${effectiveCookieSig}`;
    const signatureChanged = stored.lastSyncSignature !== newSig;

    if (!force && (cookiesUnchanged || !signatureChanged) && rulesActive && stored.activeSession?.slotId === slotId && stored.activeSession?.flowMode === flowMode && stored.activeSession?.cookieCount > 0) {
      if (isSwitchingServer || Date.now() < manualSwitchLockUntil) {
        return stored.activeSession;
      }
      const metaChanged =
        Number(stored.activeSession?.slot) !== Number(slotNum) ||
        Number(stored.activeSession?.serverNumber) !== Number(serverNumber) ||
        Number(stored.activeSession?.totalServers) !== Number(totalServers) ||
        Boolean(stored.activeSession?.maintenance) !== false ||
        stored.lastCookieSig !== effectiveCookieSig;

      const updatedSession = {
        ...stored.activeSession,
        slot: slotNum,
        flowMode,
        serverNumber,
        totalServers,
        pool,
        status: "active",
        maintenance: false,
        maintenanceUrl,
        limitReached: false,
        cookieSig: effectiveCookieSig,
        ...(syncSchedule ? { syncSchedule } : {})
      };
      if (metaChanged) {
        await chrome.storage.local.set({
          activeSession: updatedSession,
          lastSyncSignature: newSig,
          lastCookieSig: effectiveCookieSig,
          ...(pool ? { poolInfo: pool } : {}),
          ...(syncSchedule ? { syncSchedule } : {})
        });
      } else if (syncSchedule) {
        await chrome.storage.local.set({ syncSchedule });
      }
      return updatedSession;
    }

    let rawCookies = inlineCookies;
    let detailSchedule = null;
    if (!Array.isArray(rawCookies)) {
      const { data: detail } = await fetchBackend(`/extension/session/${encodeURIComponent(slotId)}?t=${Date.now()}`, {}, token);
      rawCookies = detail?.data ?? detail?.cookies ?? [];
      detailSchedule = detail?.syncSchedule || null;
    }
    const parsedCookies = self.CookieCore.parseCookieInput(
      typeof rawCookies === "string" ? rawCookies : JSON.stringify(rawCookies)
    );
    const importResult = self.CookieCore.prepareImport(parsedCookies);
    const prepared = importResult.prepared;

    if (isSwitchingServer || Date.now() < manualSwitchLockUntil) {
      return stored.activeSession || null;
    }
    const jarWrite = await applyDeclarativeSession(prepared);

    // NEVER auto-reload active Google Flow tabs on background sync! Only bounce /about landing tabs.
    const capturedTabs = await captureFlowTabs();
    for (const tab of capturedTabs) {
      if (/^https:\/\/flow\.google\.com\/about(?:\/|\?|$)/i.test(tab.url || "")) {
        safeRedirectAboutTabToHome(tab.id);
      }
    }

    const finalSchedule = detailSchedule || slot?.syncSchedule || syncSchedule || null;
    const sessionMeta = {
      slotId,
      slot: slotNum,
      slotName,
      flowMode,
      serverNumber,
      totalServers,
      pool,
      cookieCount: prepared.length,
      injectedCount: prepared.length,
      lastJarWrite: jarWrite || null,
      updatedAt: actualUploaded || new Date().toISOString(),
      syncedAt: Date.now(),
      status: "active",
      maintenance: false,
      maintenanceUrl,
      limitReached: false,
      cookieSig: effectiveCookieSig,
      syncSchedule: finalSchedule
    };

    await chrome.storage.local.set({
      selectedSessionId: slotId,
      activeSession: sessionMeta,
      ...(pool ? { poolInfo: pool } : {}),
      ...(poolCookies && typeof poolCookies === "object" ? { poolCookiesBySlot: poolCookies } : {}),
      lastSyncSignature: newSig,
      lastCookieSig: effectiveCookieSig,
      lastAutoInjectedAt: Date.now(),
      lastAutoInjectedSession: slotName,
      lastAutoInjectedCount: prepared.length,
      ...(finalSchedule ? { syncSchedule: finalSchedule } : {})
    });

    return sessionMeta;
  } catch (err) {
    console.warn("Tools By DCX sync error:", err);
    const st = await chrome.storage.local.get(["activeSession"]).catch(() => ({}));
    return st?.activeSession || null;
  }
}

// ============ SMART POOL AUTO-SWITCH & AUTO-FAILOVER ENGINE ============
async function applySwitchedServerResponse(data, flowMode = "video") {
  const slotObj = data.session;
  const pool = data.pool || null;
  const rawCookies = data.data ?? [];
  const parsedCookies = self.CookieCore.parseCookieInput(
    typeof rawCookies === "string" ? rawCookies : JSON.stringify(rawCookies)
  );
  const importResult = self.CookieCore.prepareImport(parsedCookies);
  const prepared = importResult.prepared;

  const jarWrite = await applyDeclarativeSession(prepared);

  const slotId = slotObj.id;
  const slotNum = slotObj.slot || data.assignedSlot || 1;
  const serverNumber = Number(slotObj.serverNumber || pool?.serverNumber || 1);
  const totalServers = Number(slotObj.totalServers || pool?.totalServers || 1);
  const remoteCount = Number(slotObj.cookie_count ?? slotObj.cookieCount ?? prepared.length);
  const cookieSig = String(data.cookieSig || slotObj.cookieSig || `${slotId}:${slotObj.actual_uploaded_at || slotObj.updated_at || ""}:${remoteCount}`);
  const newSig = `ACTIVE:${flowMode}:${cookieSig}`;
  const finalSchedule = slotObj.syncSchedule || data.syncSchedule || null;

  const sessionMeta = {
    slotId,
    slot: slotNum,
    slotName: slotObj.name || `Server ${serverNumber}`,
    flowMode,
    serverNumber,
    totalServers,
    pool,
    cookieCount: prepared.length,
    injectedCount: prepared.length,
    lastJarWrite: jarWrite || null,
    updatedAt: slotObj.actual_uploaded_at || slotObj.updated_at || new Date().toISOString(),
    syncedAt: Date.now(),
    status: "active",
    maintenance: false,
    maintenanceUrl: data.maintenanceUrl || getMaintenanceUrl(flowMode),
    limitReached: false,
    cookieSig,
    syncSchedule: finalSchedule
  };

  await chrome.storage.local.set({
    flowMode,
    selectedSessionId: slotId,
    activeSession: sessionMeta,
    ...(pool ? { poolInfo: pool } : {}),
    lastSyncSignature: newSig,
    lastCookieSig: cookieSig,
    lastAutoInjectedAt: Date.now(),
    lastAutoInjectedSession: sessionMeta.slotName,
    lastAutoInjectedCount: prepared.length,
    ...(finalSchedule ? { syncSchedule: finalSchedule } : {})
  });

  return { sessionMeta, serverNumber, totalServers, pool, slotNum };
}

async function reloadFlowTabsAfterServerSwitch(switchedAccount = false) {
  const capturedTabs = await captureFlowTabs();
  for (const tab of capturedTabs) {
    knownFlowTabIds.add(tab.id);
    const u = String(tab.url || "");
    if (
      /^https:\/\/flow\.google\.com\/about(?:\/|\?|$)/i.test(u) ||
      (switchedAccount && /\/project\/[0-9a-fA-F-]{6,}/i.test(u))
    ) {
      chrome.tabs.update(tab.id, { url: FLOW_HOME }).catch(() => {});
    } else {
      chrome.tabs.reload(tab.id, { bypassCache: switchedAccount }).catch(() => {
        chrome.tabs.update(tab.id, { url: FLOW_HOME }).catch(() => {});
      });
    }
  }
}

async function switchServerInPool(options = {}) {
  if (isSwitchingServer) {
    return { success: false, error: "Server switch already in progress..." };
  }
  isSwitchingServer = true;
  manualSwitchLockUntil = Date.now() + 8000;
  try {
    const stored = await chrome.storage.local.get([
      "isLoggedIn",
      "userToken",
      "flowMode",
      "activeSession",
      "poolInfo",
      "poolCookiesBySlot"
    ]);
    if (stored.isLoggedIn !== "true" || !stored.userToken) {
      manualSwitchLockUntil = 0;
      return { success: false, error: "Please sign in on flow.toolsbydcx.com first." };
    }
    const flowMode = "video";

    const payload = {
      mode: flowMode,
      reason: options.reason || "manual"
    };
    if (options.targetSlot) {
      payload.targetSlot = Number(options.targetSlot);
    }
    if (options.excludeSlot) {
      payload.excludeSlot = Number(options.excludeSlot);
    }

    // Confirm pin on backend FIRST (~35ms) so SQLite slot_user_assignments is 100% updated BEFORE Google Flow reloads!
    const { res, data } = await fetchBackend("/extension/switch-server", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }, stored.userToken);

    if (!res.ok || !data?.success || !data.session) {
      manualSwitchLockUntil = 0;
      return {
        success: false,
        maintenance: Boolean(data?.maintenance),
        maintenanceUrl: data?.maintenanceUrl || getMaintenanceUrl(flowMode),
        error: data?.error || "Could not switch server right now."
      };
    }

    const { sessionMeta, serverNumber, totalServers, pool, slotNum } = await applySwitchedServerResponse(data, flowMode);
    manualSwitchLockUntil = Date.now() + 6000;

    await reloadFlowTabsAfterServerSwitch(Boolean(data.switched));

    return {
      success: true,
      switched: Boolean(data.switched),
      previousSlot: data.previousSlot || null,
      assignedSlot: data.assignedSlot || slotNum,
      serverNumber,
      totalServers,
      pool,
      session: sessionMeta
    };
  } catch (err) {
    const rawMsg = String(err?.message || "");
    return {
      success: false,
      error: /aborted|timeout/i.test(rawMsg)
        ? "Server busy — please click Switch Server again."
        : (rawMsg || "Failed to switch server.")
    };
  } finally {
    isSwitchingServer = false;
  }
}

async function handleFlowTabAuthDrop(tabId, badUrl) {
  try {
    const nowMs = Date.now();
    const prevMs = tabFailoverCooldown.get(tabId) || 0;
    if (nowMs - prevMs < 6000) return;
    tabFailoverCooldown.set(tabId, nowMs);

    const stored = await chrome.storage.local.get(["isLoggedIn", "userToken", "flowMode", "activeSession"]);
    if (stored.isLoggedIn !== "true" || !stored.userToken) return;

    const flowMode = stored.flowMode === "image" ? "image" : "video";
    const badSlot = stored.activeSession?.slot || (flowMode === "image" ? 2 : 1);

    await clearConflictingFlowCookies();

    // Strictly keep user on their selected server — NEVER auto-switch servers in the background!
    const refreshedMeta = await syncSessionsFromPortal(true, flowMode === "video" ? badSlot : null).catch(() => null);
    if (refreshedMeta && !refreshedMeta.maintenance && Number(refreshedMeta.cookieCount || 0) >= 5) {
      chrome.tabs.update(tabId, { url: FLOW_HOME }).catch(() => {});
      return;
    }

    const { res, data } = await fetchBackend("/extension/report-slot-issue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slot: badSlot,
        mode: flowMode,
        url: badUrl || "",
        reason: "google_auth_drop"
      })
    }, stored.userToken);

    if (res.ok && data?.success && data.session && Array.isArray(data.data) && data.data.length > 0) {
      await applySwitchedServerResponse(data, flowMode);
      chrome.tabs.update(tabId, { url: FLOW_HOME }).catch(() => {});
      return;
    }

    const maintUrl = data?.maintenanceUrl || getMaintenanceUrl(flowMode);
    await clearDeclarativeSession();
    await chrome.storage.local.set({
      activeSession: {
        ...(stored.activeSession || {}),
        flowMode,
        cookieCount: 0,
        injectedCount: 0,
        status: "maintenance",
        maintenance: true,
        maintenanceUrl: maintUrl,
        syncedAt: Date.now()
      }
    });
    chrome.tabs.update(tabId, { url: maintUrl }).catch(() => {});
  } catch (_) {
    const stored = await chrome.storage.local.get(["flowMode"]).catch(() => ({}));
    const maintUrl = getMaintenanceUrl(stored?.flowMode === "image" ? "image" : "video");
    chrome.tabs.update(tabId, { url: maintUrl }).catch(() => {});
  }
}

// ============ DIRECT WEBSITE AUTO-LOGIN / AUTO-LOGOUT ENGINE ============
async function readWebAuthFromCookie() {
  try {
    if (!chrome.cookies?.get) return { flowToken: "", deviceId: "" };
    const [tokCookie, didCookie] = await Promise.all([
      chrome.cookies.get({ url: "https://flow.toolsbydcx.com/", name: "bf_ext_token" }).catch(() => null),
      chrome.cookies.get({ url: "https://flow.toolsbydcx.com/", name: "bf_ext_did" }).catch(() => null)
    ]);
    const flowToken = tokCookie?.value ? decodeURIComponent(tokCookie.value).trim() : "";
    const deviceId = didCookie?.value ? decodeURIComponent(didCookie.value).trim() : "";
    return { flowToken, deviceId };
  } catch (_) {
    return { flowToken: "", deviceId: "" };
  }
}

async function handleWebAuthSync(opts = {}) {
  const flowToken = String(opts.flowToken || "").trim();
  const deviceId = String(opts.deviceId || "").trim();
  const targetMode = opts.mode === "image" ? "image" : "video";
  if (!flowToken) return { success: false, loggedIn: false };

  const stored = await chrome.storage.local.get([
    "isLoggedIn",
    "userToken",
    "lastWebFlowToken",
    "flowMode"
  ]);

  if (!opts.force && stored.isLoggedIn === "true" && stored.userToken && stored.lastWebFlowToken === flowToken) {
    return { success: true, loggedIn: true, alreadyConnected: true };
  }

  if (webSsoPromise && !opts.force) {
    return await webSsoPromise;
  }

  const runSso = (async () => {
    try {
      const effectiveMode = opts.mode ? targetMode : (stored.flowMode === "image" ? "image" : "video");
      const { res, data } = await fetchBackend("/extension/web-sso", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          flowToken,
          deviceId: deviceId || undefined,
          mode: effectiveMode
        })
      }, flowToken);

      if (!res.ok || !data?.success || !data.token) {
        if ((res.status === 401 && data?.code === "WEB_LOGGED_OUT") || (res.status === 403 && data?.code === "PLAN_EXPIRED")) {
          if (stored.isLoggedIn === "true") {
            await performFullLogout({ skipServerRevoke: true, fromWebLogout: true });
          }
          return { success: false, loggedIn: false, error: data?.error || "Web session expired", code: data?.code || "" };
        }
        return { success: false, loggedIn: Boolean(stored.isLoggedIn === "true"), error: data?.error || "Web SSO failed", code: data?.code || "" };
      }

      const session = await applyLoginBundle(data, effectiveMode);
      await chrome.storage.local.set({ lastWebFlowToken: flowToken });
      fetchUserProjectsFromServer().catch(() => {});
      fetchLiveExtensionConfig().catch(() => {});
      return {
        success: true,
        loggedIn: true,
        sso: true,
        user: data.user || {},
        session,
        pool: data.pool || session?.pool || null
      };
    } catch (e) {
      return { success: false, loggedIn: Boolean(stored.isLoggedIn === "true"), error: e?.message || "Web SSO error" };
    }
  })();

  webSsoPromise = runSso;
  try {
    return await runSso;
  } finally {
    if (webSsoPromise === runSso) webSsoPromise = null;
  }
}

async function syncFromOpenToolsByDcxTabs(opts = {}) {
  try {
    // 1. Instant <1ms first-party cookie check (works even with ZERO open flow.toolsbydcx.com tabs!)
    const cookieAuth = await readWebAuthFromCookie();
    if (cookieAuth.flowToken) {
      const res = await handleWebAuthSync({
        flowToken: cookieAuth.flowToken,
        deviceId: cookieAuth.deviceId,
        force: Boolean(opts.force),
        mode: opts.mode
      });
      if (res && res.loggedIn) return res;
    }

    // 2. Fallback: read localStorage directly from any open flow.toolsbydcx.com tab
    const tabs = await chrome.tabs.query({
      url: ["https://flow.toolsbydcx.com/*", "https://*.flow.toolsbydcx.com/*"]
    });
    if (!tabs || !tabs.length) return { success: false, foundTab: false, loggedIn: false };

    for (const tab of tabs) {
      if (!Number.isInteger(tab.id)) continue;
      let webAuth = null;
      try {
        webAuth = await chrome.tabs.sendMessage(tab.id, { type: "READ_WEB_AUTH" });
      } catch (_) {
        webAuth = null;
      }
      if ((!webAuth || !webAuth.flowToken) && chrome.scripting?.executeScript) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              try {
                return {
                  flowToken: String(localStorage.getItem("flow_token") || "").trim(),
                  deviceId: String(localStorage.getItem("bf_device_id") || "").trim()
                };
              } catch {
                return { flowToken: "", deviceId: "" };
              }
            }
          });
          webAuth = results?.[0]?.result || null;
        } catch (_) {}
      }
      if (webAuth && webAuth.flowToken) {
        return await handleWebAuthSync({
          flowToken: webAuth.flowToken,
          deviceId: webAuth.deviceId,
          force: Boolean(opts.force),
          mode: opts.mode
        });
      }
    }
    return { success: false, foundTab: true, loggedIn: false, loggedInOnWeb: false };
  } catch (e) {
    return { success: false, loggedIn: false, error: e?.message };
  }
}

try {
  if (chrome.cookies?.onChanged) {
    chrome.cookies.onChanged.addListener((changeInfo) => {
      const c = changeInfo?.cookie;
      if (!c || c.name !== "bf_ext_token") return;
      const dom = String(c.domain || "").replace(/^\.+/, "").toLowerCase();
      if (dom !== "flow.toolsbydcx.com" && !dom.endsWith(".flow.toolsbydcx.com")) return;

      if (changeInfo.removed) {
        if (changeInfo.cause === "overwrite") return;
        setTimeout(async () => {
          const recheck = await readWebAuthFromCookie();
          if (!recheck.flowToken) {
            await performFullLogout({ fromWebLogout: true });
          }
        }, 150);
      } else if (c.value) {
        const flowToken = decodeURIComponent(c.value).trim();
        if (flowToken) {
          readWebAuthFromCookie().then(({ deviceId }) => {
            handleWebAuthSync({ flowToken, deviceId }).catch(() => {});
          });
        }
      }
    });
  }
} catch (_) {}

// ============ 1. SERVER-DRIVEN LIVE EXTENSION REMOTE UPDATE ENGINE ============
async function fetchLiveExtensionConfig() {
  try {
    const { res, data } = await fetchBackend(`/extension/live-config?t=${Date.now()}`);
    if (res.ok && data?.success && data.config) {
      await chrome.storage.local.set({ liveExtConfig: data.config });
      await syncServerCreditsState(null, data.config);
      updateExtensionVersionBadge(data.config);
      return data.config;
    }
  } catch (_) {}
  const stored = await chrome.storage.local.get(["liveExtConfig"]);
  if (stored.liveExtConfig) {
    updateExtensionVersionBadge(stored.liveExtConfig);
  }
  return stored.liveExtConfig || null;
}

// ============ 2. PER-USER GOOGLE FLOW PROJECT HISTORY SAVING ============
function extractProjectIdFromUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return null;
  const m = urlStr.match(/\/project\/([0-9a-fA-F-]{8,64})(?:\/|\?|$)/i);
  return m ? m[1] : null;
}

async function getLocalUserProjects(userEmail) {
  const key = String(userEmail || "default").toLowerCase().trim();
  const stored = await chrome.storage.local.get(["userProjectsByEmail"]);
  const map = stored.userProjectsByEmail || {};
  return Array.isArray(map[key]) ? map[key] : [];
}

async function setLocalUserProjects(userEmail, list) {
  const key = String(userEmail || "default").toLowerCase().trim();
  const stored = await chrome.storage.local.get(["userProjectsByEmail"]);
  const map = stored.userProjectsByEmail || {};
  map[key] = Array.isArray(list) ? list.slice(0, 100) : [];
  await chrome.storage.local.set({ userProjectsByEmail: map, currentUserProjects: map[key] });
  return map[key];
}

async function fetchUserProjectsFromServer() {
  try {
    const stored = await chrome.storage.local.get(["isLoggedIn", "userToken", "userEmail"]);
    if (stored.isLoggedIn !== "true" || !stored.userToken) return [];
    const localList = await getLocalUserProjects(stored.userEmail);
    const { res, data } = await fetchBackend(`/extension/projects?t=${Date.now()}`, {}, stored.userToken);
    if (res.ok && data?.success && Array.isArray(data.projects)) {
      const byId = new Map();
      for (const p of localList) {
        if (p?.projectId) byId.set(p.projectId, p);
      }
      for (const s of data.projects) {
        if (!s?.projectId) continue;
        const prev = byId.get(s.projectId);
        byId.set(s.projectId, {
          projectId: s.projectId,
          projectUrl: s.projectUrl || prev?.projectUrl || `https://flow.google.com/project/${s.projectId}`,
          title: s.title || prev?.title || "Google Flow Project",
          thumbnail: (s.thumbnail && s.thumbnail.length > 20) ? s.thumbnail : (prev?.thumbnail || null),
          createdAt: s.createdAt || prev?.createdAt || new Date().toISOString(),
          updatedAt: s.updatedAt || prev?.updatedAt || new Date().toISOString()
        });
      }
      const merged = Array.from(byId.values()).sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
      return await setLocalUserProjects(stored.userEmail, merged);
    }
    return localList;
  } catch (_) {
    const stored = await chrome.storage.local.get(["userEmail"]);
    return await getLocalUserProjects(stored.userEmail);
  }
}

async function saveUserProject(payload) {
  const stored = await chrome.storage.local.get(["isLoggedIn", "userToken", "userEmail"]);
  if (stored.isLoggedIn !== "true" || !stored.userToken) return [];
  const projectId = String(payload?.projectId || extractProjectIdFromUrl(payload?.projectUrl) || "").trim();
  if (!projectId) return await getLocalUserProjects(stored.userEmail);
  const projectUrl = String(payload?.projectUrl || `https://flow.google.com/project/${projectId}`).trim();
  const title = String(payload?.title || "").trim() || null;
  const thumbnail = (payload?.thumbnail && String(payload.thumbnail).length > 20) ? String(payload.thumbnail) : null;
  const nowIso = new Date().toISOString();

  const list = await getLocalUserProjects(stored.userEmail);
  const idx = list.findIndex((p) => p.projectId === projectId);
  if (idx >= 0) {
    list[idx] = {
      ...list[idx],
      projectUrl: projectUrl || list[idx].projectUrl,
      title: title || list[idx].title || "Google Flow Project",
      thumbnail: thumbnail || list[idx].thumbnail || null,
      updatedAt: nowIso
    };
  } else {
    list.unshift({
      projectId,
      projectUrl,
      title: title || "Google Flow Project",
      thumbnail: thumbnail || null,
      createdAt: nowIso,
      updatedAt: nowIso
    });
  }
  const updatedLocal = await setLocalUserProjects(stored.userEmail, list);

  try {
    const entry = updatedLocal.find((p) => p.projectId === projectId) || { projectId, projectUrl, title, thumbnail };
    const { res, data } = await fetchBackend("/extension/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: entry.projectId,
        projectUrl: entry.projectUrl,
        title: entry.title,
        thumbnail: entry.thumbnail
      })
    }, stored.userToken);
    if (res.ok && data?.success && Array.isArray(data.projects)) {
      return await setLocalUserProjects(stored.userEmail, data.projects);
    }
  } catch (_) {}
  return updatedLocal;
}

async function deleteUserProject(projectId) {
  const stored = await chrome.storage.local.get(["isLoggedIn", "userToken", "userEmail"]);
  const list = (await getLocalUserProjects(stored.userEmail)).filter((p) => p.projectId !== projectId);
  await setLocalUserProjects(stored.userEmail, list);
  if (stored.isLoggedIn === "true" && stored.userToken) {
    try {
      await fetchBackend(`/extension/projects/${encodeURIComponent(projectId)}`, {
        method: "DELETE"
      }, stored.userToken);
    } catch (_) {}
  }
  return list;
}

async function captureVisibleTabThumbnail() {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "jpeg", quality: 65 });
    return dataUrl || null;
  } catch (_) {
    return null;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  syncFromOpenToolsByDcxTabs({ force: false }).finally(() => {
    syncSessionsFromPortal(true);
    fetchLiveExtensionConfig();
    fetchUserProjectsFromServer();
  });
});

chrome.runtime.onStartup.addListener(() => {
  syncFromOpenToolsByDcxTabs({ force: false }).finally(() => {
    syncSessionsFromPortal(true);
    fetchLiveExtensionConfig();
    fetchUserProjectsFromServer();
  });
});

setInterval(async () => {
  const st = await chrome.storage.local.get(["isLoggedIn"]);
  if (st.isLoggedIn === "true") {
    if (!isSwitchingServer && Date.now() >= manualSwitchLockUntil) {
      syncSessionsFromPortal(false);
    }
  } else {
    syncFromOpenToolsByDcxTabs({ force: false }).catch(() => {});
  }
}, 12000);

setInterval(() => {
  fetchLiveExtensionConfig();
}, 45000);

chrome.alarms.create("toolsbydcx_session_sync", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "toolsbydcx_session_sync") {
    syncSessionsFromPortal(false);
    fetchLiveExtensionConfig();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  knownFlowTabIds.delete(tabId);
  tabFailoverCooldown.delete(tabId);
  tabAboutRedirectCooldown.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  const url = changeInfo.url;
  if (isGoogleAuthDropUrl(url)) {
    // ONLY report auth drop if this specific tab was previously an active Google Flow tab!
    // Never trigger when a user opens personal Gmail/YouTube/Drive login in another tab.
    if (knownFlowTabIds.has(tabId)) {
      knownFlowTabIds.delete(tabId);
      handleFlowTabAuthDrop(tabId, url);
    }
    return;
  }
  if (/^https:\/\/flow\.google\.com\/about(?:\/|\?|$)/i.test(url)) {
    knownFlowTabIds.add(tabId);
    sessionRulesActive().then((active) => {
      if (active) safeRedirectAboutTabToHome(tabId);
    }).catch(() => {});
    return;
  }
  if (url.includes("flow.google.com") || url.includes("labs.google")) {
    knownFlowTabIds.add(tabId);
    const pid = extractProjectIdFromUrl(url);
    if (pid) {
      tabAboutRedirectCooldown.delete(tabId);
      saveUserProject({ projectId: pid, projectUrl: url, title: tab?.title || "Google Flow Project" }).catch(() => {});
    }
  }
});

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (!req || !req.type) return false;

  if (req.type === "CHECK_FLOW_ACCESS") {
    (async () => {
      if (_sender?.tab?.id) knownFlowTabIds.add(_sender.tab.id);
      if (!isSwitchingServer && Date.now() >= manualSwitchLockUntil && (Date.now() - lastBgPortalSyncAt) >= 12000) {
        syncSessionsFromPortal(false).catch(() => {});
      }
      const stored = await chrome.storage.local.get(["isLoggedIn", "userToken", "liveExtConfig", "userPlan", "testPlanOverride", "flowMode", "daysLeft", "userEmail", "userName", "poolInfo", "activeSession", "creditResetEpoch", "tbdSpentByTier"]);
      const allowed = Boolean(stored.isLoggedIn === "true" && stored.userToken);
      const effectivePlan = stored.userPlan || "Free Plan";
      sendResponse({
        allowed,
        flowMode: stored.flowMode === "image" ? "image" : "video",
        liveConfig: stored.liveExtConfig || null,
        userPlan: effectivePlan,
        daysLeft: stored.daysLeft,
        userEmail: stored.userEmail || "",
        userName: stored.userName || "",
        pool: stored.poolInfo || null,
        activeSession: stored.activeSession || null,
        creditResetEpoch: stored.creditResetEpoch || stored.liveExtConfig?.creditResetEpoch || null,
        spentByTier: stored.tbdSpentByTier || null
      });
    })();
    return true;
  }

  if (req.type === "WEB_AUTH_SYNC") {
    handleWebAuthSync({
      flowToken: req.flowToken,
      deviceId: req.deviceId,
      force: Boolean(req.force),
      mode: req.mode
    })
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, loggedIn: false, error: err?.message }));
    return true;
  }

  if (req.type === "WEB_AUTH_LOGOUT") {
    performFullLogout({ fromWebLogout: true, flowToken: req.flowToken || "" })
      .then(() => sendResponse({ success: true, loggedIn: false }))
      .catch((err) => sendResponse({ success: false, error: err?.message }));
    return true;
  }

  if (req.type === "TRY_WEB_SSO") {
    syncFromOpenToolsByDcxTabs({
      force: Boolean(req.force),
      mode: req.mode
    })
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, loggedIn: false, error: err?.message }));
    return true;
  }

  if (req.type === "SYNC_USER_CREDITS") {
    (async () => {
      try {
        const stored = await chrome.storage.local.get(["isLoggedIn", "userToken"]);
        if (stored.isLoggedIn !== "true" || !stored.userToken) {
          sendResponse({ success: false });
          return;
        }
        const spentByTier = req.spentByTier || { free: 0, plus: 0, max: 0 };
        await chrome.storage.local.set({ tbdSpentByTier: spentByTier });
        const { res, data } = await fetchBackend("/extension/credits", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ spentByTier })
        }, stored.userToken);
        sendResponse({ success: Boolean(res.ok && data?.success), data });
      } catch (e) {
        sendResponse({ success: false, error: e?.message });
      }
    })();
    return true;
  }

  if (req.type === "SWITCH_SERVER") {
    switchServerInPool({
      mode: req.flowMode || null,
      targetSlot: req.targetSlot || null,
      excludeSlot: req.excludeSlot || null,
      reason: req.reason || "manual_switch_btn"
    })
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: err?.message || "Server switch failed" }));
    return true;
  }

  if (req.type === "GET_SERVER_POOL") {
    chrome.storage.local.get(["poolInfo", "activeSession", "flowMode"], (stored) => {
      sendResponse({
        success: true,
        pool: stored.poolInfo || null,
        session: stored.activeSession || null,
        flowMode: stored.flowMode === "image" ? "image" : "video"
      });
    });
    return true;
  }

  if (req.type === "SWITCH_FLOW_MODE") {
    (async () => {
      const nextMode = req.flowMode === "image" ? "image" : "video";
      await chrome.storage.local.set({
        flowMode: nextMode,
        lastSyncSignature: "",
        selectedSessionId: ""
      });
      const meta = await syncSessionsFromPortal(true);
      const capturedTabs = await captureFlowTabs();
      for (const tab of capturedTabs) {
        if (meta && Number(meta.cookieCount) > 0 && !meta.maintenance) {
          chrome.tabs.update(tab.id, { url: FLOW_HOME }).catch(() => {});
        } else {
          chrome.tabs.update(tab.id, { url: meta?.maintenanceUrl || getMaintenanceUrl(nextMode) }).catch(() => {});
        }
      }
      sendResponse({ success: true, flowMode: nextMode, session: meta, pool: meta?.pool || null });
    })();
    return true;
  }

  if (req.type === "GET_LIVE_EXT_CONFIG") {
    fetchLiveExtensionConfig()
      .then((config) => sendResponse({ success: true, config, extVersion: EXT_VERSION }))
      .catch(() => sendResponse({ success: false, extVersion: EXT_VERSION }));
    return true;
  }

  if (req.type === "GET_USER_PROJECTS") {
    (async () => {
      const stored = await chrome.storage.local.get(["userEmail"]);
      const local = await getLocalUserProjects(stored.userEmail);
      sendResponse({ success: true, projects: local });
      fetchUserProjectsFromServer().catch(() => {});
    })();
    return true;
  }

  if (req.type === "SAVE_USER_PROJECT") {
    (async () => {
      let thumb = req.thumbnail || null;
      if (!thumb && req.captureTab) {
        thumb = await captureVisibleTabThumbnail();
      }
      const projects = await saveUserProject({
        projectId: req.projectId,
        projectUrl: req.projectUrl,
        title: req.title,
        thumbnail: thumb
      });
      sendResponse({ success: true, projects });
    })();
    return true;
  }

  if (req.type === "DELETE_USER_PROJECT") {
    deleteUserProject(req.projectId)
      .then((projects) => sendResponse({ success: true, projects }))
      .catch((e) => sendResponse({ success: false, error: e?.message }));
    return true;
  }

  if (req.type === "OPEN_PROJECT_URL") {
    const targetUrl = String(req.projectUrl || "https://flow.google.com/").trim();
    syncSessionsFromPortal(false)
      .then(() => {
        chrome.tabs.create({ url: targetUrl }, (tab) => {
          sendResponse({ success: true, tabId: tab?.id });
        });
      })
      .catch(() => {
        chrome.tabs.create({ url: targetUrl });
        sendResponse({ success: true });
      });
    return true;
  }

  if (req.type === "SYNC_SESSION" || req.type === "REFRESH_COOKIES") {
    const force = Boolean(req.force);
    const slotId = req.slotId || null;
    syncSessionsFromPortal(force, slotId)
      .then((meta) => sendResponse({ success: true, session: meta, pool: meta?.pool || null }))
      .catch((err) => sendResponse({ success: false, error: err?.message }));
    return true;
  }

  if (req.type === "LAUNCH_FLOW_WITH_MODE") {
    (async () => {
      try {
        const nextMode = req.flowMode === "image" ? "image" : "video";
        const rawUrl = String(req.url || FLOW_HOME).trim();
        const targetUrl = isFlowUrl(rawUrl) ? rawUrl : FLOW_HOME;

        let stored = await chrome.storage.local.get(["isLoggedIn", "userToken", "flowMode", "activeSession"]);
        if (stored.isLoggedIn !== "true" || !stored.userToken) {
          let ssoRes = null;
          if (req.flowToken) {
            ssoRes = await handleWebAuthSync({
              flowToken: req.flowToken,
              deviceId: req.deviceId,
              force: true,
              mode: nextMode
            });
          } else {
            ssoRes = await syncFromOpenToolsByDcxTabs({
              force: true,
              mode: nextMode
            });
          }
          if (!ssoRes || !ssoRes.loggedIn) {
            sendResponse({
              ok: false,
              needLogin: true,
              error: ssoRes?.error || "Please sign in on flow.toolsbydcx.com first."
            });
            return;
          }
          stored = await chrome.storage.local.get(["isLoggedIn", "userToken", "flowMode", "activeSession"]);
        }

        const modeChanged = stored.flowMode !== nextMode;
        const rulesReady = await sessionRulesActive();
        const isRecentlyVerified = Boolean(
          !modeChanged &&
          rulesReady &&
          stored.activeSession?.flowMode === nextMode &&
          !stored.activeSession?.maintenance &&
          Number(stored.activeSession?.cookieCount || 0) >= 5 &&
          (Date.now() - Number(stored.activeSession?.syncedAt || 0)) < 10000
        );

        if (isRecentlyVerified) {
          chrome.tabs.create({ url: targetUrl }, (tab) => {
            sendResponse({ ok: true, mode: nextMode, tabId: tab?.id, session: stored.activeSession });
          });
          syncSessionsFromPortal(false).catch(() => {});
          return;
        }

        await chrome.storage.local.set({
          flowMode: nextMode,
          ...(modeChanged ? { lastSyncSignature: "", lastCookieSig: "", selectedSessionId: "" } : {})
        });

        const meta = await syncSessionsFromPortal(true);
        if (meta?.upgradeRequired) {
          sendResponse({
            ok: false,
            upgradeRequired: true,
            mode: nextMode,
            error: meta.error || "Please update your Tools By DCX Extension to the latest version."
          });
          return;
        }
        if (!meta || Number(meta.cookieCount) === 0 || meta.maintenance) {
          if (meta?.noAccount) {
            sendResponse({
              ok: false,
              noAccount: true,
              mode: nextMode,
              error: nextMode === "image"
                ? "No shared Nano Banana account is set up for your plan yet. Please ask the admin to add one."
                : "No shared Google Flow account is set up for your plan yet. Please ask the admin to add one."
            });
            return;
          }
          if (meta?.noValidCookies) {
            sendResponse({
              ok: false,
              noValidCookies: true,
              mode: nextMode,
              error: nextMode === "image"
                ? "The shared Nano Banana account's cookies have expired. Please ask the admin to refresh the shared account cookies."
                : "The shared Google Flow account's cookies have expired. Please ask the admin to refresh the shared account cookies."
            });
            return;
          }
          if (meta?.limitReached) {
            sendResponse({
              ok: false,
              limitReached: true,
              mode: nextMode,
              error: nextMode === "image"
                ? "Nano Banana AI Image server is currently at full user capacity. Please try again shortly."
                : "All Video servers are currently at full user capacity. Please try again shortly."
            });
            return;
          }
          const maintUrl = meta?.maintenanceUrl || getMaintenanceUrl(nextMode);
          chrome.tabs.create({ url: maintUrl }, (tab) => {
            sendResponse({
              ok: false,
              maintenance: true,
              maintenanceUrl: maintUrl,
              tabId: tab?.id,
              mode: nextMode,
              error: nextMode === "image"
                ? "Nano Banana AI Image server is currently under maintenance."
                : "Google Flow Video server is currently under maintenance."
            });
          });
          return;
        }

        if (modeChanged) {
          const existingTabs = await captureFlowTabs();
          for (const t of existingTabs) {
            chrome.tabs.update(t.id, { url: FLOW_HOME }).catch(() => {});
          }
        }

        chrome.tabs.create({ url: targetUrl }, (tab) => {
          sendResponse({ ok: true, mode: nextMode, tabId: tab?.id, session: meta });
        });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || "Failed to launch Google Flow." });
      }
    })();
    return true;
  }

  if (req.type === "OPEN_FLOW") {
    (async () => {
      try {
        let stored = await chrome.storage.local.get(["flowMode", "activeSession", "isLoggedIn", "userToken"]);
        const targetMode = req.flowMode
          ? (req.flowMode === "image" ? "image" : "video")
          : (stored.flowMode === "image" ? "image" : "video");

        if (stored.isLoggedIn !== "true" || !stored.userToken) {
          const ssoRes = await syncFromOpenToolsByDcxTabs({ force: true, mode: targetMode });
          if (!ssoRes || !ssoRes.loggedIn) {
            chrome.tabs.create({ url: "https://flow.toolsbydcx.com/login" });
            sendResponse({ success: false, needLogin: true });
            return;
          }
          stored = await chrome.storage.local.get(["flowMode", "activeSession", "isLoggedIn", "userToken"]);
        }

        const modeChanged = stored.flowMode !== targetMode;
        const needForce = modeChanged || Boolean(req.slotId) || Boolean(stored.activeSession?.maintenance) || stored.activeSession?.flowMode !== targetMode;
        const rulesReady = await sessionRulesActive();
        const isRecentlyVerified = Boolean(
          !needForce &&
          rulesReady &&
          stored.activeSession?.flowMode === targetMode &&
          Number(stored.activeSession?.cookieCount || 0) >= 5 &&
          (Date.now() - Number(stored.activeSession?.syncedAt || 0)) < 10000
        );

        if (isRecentlyVerified) {
          chrome.tabs.create({ url: FLOW_HOME }, (tab) => {
            sendResponse({ success: true, tabId: tab?.id, session: stored.activeSession });
          });
          syncSessionsFromPortal(false).catch(() => {});
          return;
        }

        if (modeChanged) {
          await chrome.storage.local.set({
            flowMode: targetMode,
            lastSyncSignature: "",
            lastCookieSig: "",
            selectedSessionId: ""
          });
        }
        const meta = await syncSessionsFromPortal(true, req.slotId || null);
        if (!meta || Number(meta.cookieCount) === 0 || meta.maintenance) {
          const maintUrl = meta?.maintenanceUrl || getMaintenanceUrl(targetMode);
          chrome.tabs.create({ url: maintUrl }, (tab) => {
            sendResponse({ success: false, maintenance: true, maintenanceUrl: maintUrl, tabId: tab?.id });
          });
          return;
        }
        if (modeChanged) {
          const existingTabs = await captureFlowTabs();
          for (const t of existingTabs) {
            chrome.tabs.update(t.id, { url: FLOW_HOME }).catch(() => {});
          }
        }
        chrome.tabs.create({ url: FLOW_HOME }, (tab) => {
          sendResponse({ success: true, tabId: tab?.id, session: meta });
        });
      } catch (_) {
        chrome.tabs.create({ url: FLOW_HOME });
        sendResponse({ success: true });
      }
    })();
    return true;
  }

  return false;
});
