// Tools By DCX v2.4.6 — Direct Website Sync Bridge (flow.toolsbydcx.com <-> Extension Background)
// 100% Automatic Website Login/Logout Sync + Zero-Flicker Connected Status + Maintenance Forwarding
(() => {
  "use strict";
  if (globalThis.__bunnyFlowPortalBridgeActive) return;
  globalThis.__bunnyFlowPortalBridgeActive = true;

  const EXT_VERSION = (typeof chrome !== "undefined" && chrome.runtime?.getManifest)
    ? (chrome.runtime.getManifest().version || "2.4.6")
    : "2.4.6";

  let lastKnownWebToken = "";
  let lastSyncedToken = "";
  let lastSyncAtMs = 0;

  function mirrorAuthCookies(flowToken, deviceId) {
    try {
      const securePart = location.protocol === "https:" ? "; Secure" : "";
      if (flowToken) {
        document.cookie = `bf_ext_token=${encodeURIComponent(flowToken)}; path=/; max-age=7776000; SameSite=Lax${securePart}`;
        if (deviceId) {
          document.cookie = `bf_ext_did=${encodeURIComponent(deviceId)}; path=/; max-age=31536000; SameSite=Lax${securePart}`;
        }
      } else {
        document.cookie = `bf_ext_token=; path=/; max-age=0; SameSite=Lax${securePart}`;
      }
    } catch (_) {}
  }

  function readLocalWebAuth() {
    try {
      const flowToken = String(localStorage.getItem("flow_token") || "").trim();
      const deviceId = String(localStorage.getItem("bf_device_id") || "").trim();
      if (flowToken) {
        mirrorAuthCookies(flowToken, deviceId);
      }
      return { flowToken, deviceId, hasAuth: Boolean(flowToken) };
    } catch (_) {
      return { flowToken: "", deviceId: "", hasAuth: false };
    }
  }

  function setConnectedAttr(isConnected) {
    try {
      if (document.documentElement) {
        document.documentElement.setAttribute("data-bunnyflow-extension", EXT_VERSION);
        document.documentElement.setAttribute("data-bunnyflow-connected", isConnected ? "true" : "false");
      }
      window.postMessage({
        type: "BUNNYFLOW_EXTENSION_STATUS",
        installed: true,
        connected: Boolean(isConnected),
        version: EXT_VERSION
      }, "*");
    } catch (_) {}
  }

  function announcePresence() {
    try {
      const { hasAuth } = readLocalWebAuth();
      if (document.documentElement) {
        document.documentElement.setAttribute("data-bunnyflow-extension", EXT_VERSION);
      }
      window.postMessage({ type: "BUNNYFLOW_EXTENSION_READY", version: EXT_VERSION }, "*");
      window.postMessage({ type: "BUNNYFLOW_PONG_EXTENSION", version: EXT_VERSION }, "*");
      if (hasAuth) {
        setConnectedAttr(true);
      } else if (chrome?.storage?.local) {
        chrome.storage.local.get(["isLoggedIn"], (st) => {
          setConnectedAttr(st?.isLoggedIn === "true");
        });
      } else {
        setConnectedAttr(false);
      }
    } catch (_) {}
  }

  function syncWebAuthToExtension(opts = {}) {
    try {
      if (!chrome?.runtime?.id) return;
      const { flowToken, deviceId } = readLocalWebAuth();
      if (flowToken) {
        const isFreshToken = flowToken !== lastKnownWebToken;
        lastKnownWebToken = flowToken;
        const now = Date.now();
        if (!opts.force && !isFreshToken && flowToken === lastSyncedToken && (now - lastSyncAtMs) < 8000) {
          return;
        }
        lastSyncedToken = flowToken;
        lastSyncAtMs = now;
        setConnectedAttr(true);
        chrome.runtime.sendMessage({
          type: "WEB_AUTH_SYNC",
          flowToken,
          deviceId,
          clearManualSignout: true
        }, (res) => {
          void chrome.runtime?.lastError;
          if (res && res.loggedIn === true) {
            setConnectedAttr(true);
          } else if (res && (res.code === "WEB_LOGGED_OUT" || res.code === "PLAN_EXPIRED")) {
            setConnectedAttr(false);
          }
        });
      } else if (lastKnownWebToken || opts.explicitLogout) {
        const prevTok = lastKnownWebToken;
        lastKnownWebToken = "";
        lastSyncedToken = "";
        mirrorAuthCookies("", "");
        chrome.runtime.sendMessage({
          type: "WEB_AUTH_LOGOUT",
          flowToken: prevTok
        }, () => {
          void chrome.runtime?.lastError;
          setConnectedAttr(false);
        });
      }
    } catch (_) {}
  }

  announcePresence();
  syncWebAuthToExtension({ force: true });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      announcePresence();
      syncWebAuthToExtension({ force: true });
    }, { once: true });
  }

  window.addEventListener("__bf_auth_ready__", () => {
    syncWebAuthToExtension({ force: true, clearManualSignout: true });
  });

  window.addEventListener("__bf_logout__", () => {
    syncWebAuthToExtension({ explicitLogout: true });
  });

  window.addEventListener("storage", (ev) => {
    if (!ev.key || ev.key === "flow_token" || ev.key === "__flow_auth__") {
      if (ev.key === "flow_token" && !ev.newValue) {
        syncWebAuthToExtension({ explicitLogout: true });
      } else {
        syncWebAuthToExtension({ force: true, clearManualSignout: true });
      }
    }
  });

  window.addEventListener("focus", () => {
    const { flowToken } = readLocalWebAuth();
    if (!flowToken) {
      if (lastKnownWebToken) syncWebAuthToExtension({ explicitLogout: true });
    } else {
      syncWebAuthToExtension();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      syncWebAuthToExtension();
    }
  });

  try {
    if (chrome?.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes.isLoggedIn) {
          const { hasAuth } = readLocalWebAuth();
          const isConn = changes.isLoggedIn.newValue === "true";
          if (isConn) {
            setConnectedAttr(true);
          } else if (!hasAuth) {
            setConnectedAttr(false);
          } else {
            syncWebAuthToExtension({ force: true });
          }
        }
      });
    }
    if (chrome?.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg?.type === "READ_WEB_AUTH") {
          sendResponse(readLocalWebAuth());
          return true;
        }
        return false;
      });
    }
  } catch (_) {}

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || typeof event.data !== "object") return;
    const t = event.data.type;

    if (t === "BUNNYFLOW_PING_EXTENSION" || t === "BUNNYFLOW_CHECK_EXTENSION_STATUS") {
      announcePresence();
      syncWebAuthToExtension();
      return;
    }

    if (t === "BUNNYFLOW_LAUNCH_TOOL") {
      const requestId = String(event.data.requestId || "");
      const mode = event.data.mode === "image" ? "image" : "video";
      const targetUrl = String(event.data.url || "https://flow.google.com/").trim();
      const { flowToken, deviceId } = readLocalWebAuth();

      try {
        if (!chrome?.runtime?.id) {
          window.postMessage({
            type: "BUNNYFLOW_LAUNCH_TOOL_ACK",
            requestId,
            ok: false,
            error: "Extension was updated or reloaded. Please refresh this page once.",
            mode
          }, "*");
          return;
        }

        chrome.runtime.sendMessage({
          type: "LAUNCH_FLOW_WITH_MODE",
          flowMode: mode,
          url: targetUrl,
          flowToken,
          deviceId
        }, (res) => {
          const runtimeErr = chrome.runtime?.lastError;
          if (runtimeErr || !res) {
            window.postMessage({
              type: "BUNNYFLOW_LAUNCH_TOOL_ACK",
              requestId,
              ok: false,
              error: runtimeErr?.message || "Could not communicate with Tools By DCX extension.",
              mode
            }, "*");
            return;
          }
          window.postMessage({
            type: "BUNNYFLOW_LAUNCH_TOOL_ACK",
            requestId,
            ok: Boolean(res.ok),
            needLogin: Boolean(res.needLogin),
            maintenance: Boolean(res.maintenance),
            maintenanceUrl: res.maintenanceUrl || "",
            limitReached: Boolean(res.limitReached),
            error: res.error || "",
            mode: res.mode || mode
          }, "*");
        });
      } catch (err) {
        window.postMessage({
          type: "BUNNYFLOW_LAUNCH_TOOL_ACK",
          requestId,
          ok: false,
          error: err?.message || "Failed to launch tool.",
          mode
        }, "*");
      }
    }
  });
})();
