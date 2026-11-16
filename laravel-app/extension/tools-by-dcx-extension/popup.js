(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const EXT_VERSION = (typeof chrome !== "undefined" && chrome.runtime?.getManifest)
    ? (chrome.runtime.getManifest().version || "2.4.8")
    : "2.4.8";
  const EXT_SECURE_TOKEN = "bunny-v246-edition-secured-2026";

  const storage = {
    get: (keys) =>
      new Promise((resolve) => {
        const keyArray = Array.isArray(keys) ? keys : [keys];
        chrome.storage.local.get(keyArray, (items) => resolve(items || {}));
      }),
    set: (items) =>
      new Promise((resolve) => {
        chrome.storage.local.set(items, () => resolve());
      }),
    remove: (keys) =>
      new Promise((resolve) => {
        const keyArray = Array.isArray(keys) ? keys : [keys];
        chrome.storage.local.remove(keyArray, () => resolve());
      })
  };

  let currentDeviceId = null;
  let latestSyncSchedule = null;
  let countdownTimer = null;
  let latestDownloadUrl = "https://flow.toolsbydcx.com/extension";
  let currentPoolState = null;
  let currentUserIsFree = false;
  let isSwitchingUi = false;

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

  async function sendBg(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  function computeStaggeredSchedule(_userKey) {
    return {
      cycleSeconds: 10,
      userOffsetSeconds: 0,
      nextSyncAt: Date.now() + 10000
    };
  }

  function updateAutoSyncButton() {
    const btn = $("syncNowBtn");
    if (!btn || btn.disabled || isSwitchingUi) return;
    if (!btn.dataset.customLabel && btn.dataset.renderedDefault !== "1") {
      btn.dataset.renderedDefault = "1";
      btn.innerHTML = `<span>⚡ Auto-Sync</span>`;
    }
    if (!latestSyncSchedule || !latestSyncSchedule.nextSyncAt) {
      latestSyncSchedule = computeStaggeredSchedule("default");
    }
    const remSec = Math.max(0, Math.ceil((Number(latestSyncSchedule.nextSyncAt) - Date.now()) / 1000));
    if (remSec <= 0) {
      latestSyncSchedule.nextSyncAt = Date.now() + 10000;
      sendBg({ type: "SYNC_SESSION", force: false }).then((res) => {
        if (res?.session && !isSwitchingUi) {
          renderSessionMeta({
            ...res.session,
            pool: res.pool || res.session.pool || currentPoolState?.pool || null
          });
        }
      });
    }
  }

  function startCountdownLoop() {
    if (countdownTimer) return;
    updateAutoSyncButton();
    countdownTimer = setInterval(updateAutoSyncButton, 2000);
  }

  async function getOrCreateDeviceId() {
    const data = await storage.get(["deviceId"]);
    if (data.deviceId) {
      currentDeviceId = data.deviceId;
    } else {
      currentDeviceId = `dev_${Math.random().toString(36).substring(2, 10)}_${Date.now().toString(36)}`;
      await storage.set({ deviceId: currentDeviceId });
    }
    return currentDeviceId;
  }

  function showStatus(text, type = "info") {
    const banner = $("statusBanner");
    const txt = $("statusBannerText");
    if (!banner || !txt) return;
    if (!text) {
      banner.classList.add("hidden");
      return;
    }
    txt.textContent = text;
    banner.className = `status-banner ${type}`;
    banner.classList.remove("hidden");
  }

  function setChip(ok, label) {
    const chip = $("statusChip");
    const txt = $("statusChipText");
    if (!chip || !txt) return;
    chip.className = `chip ${ok ? "ok" : "bad"}`;
    txt.textContent = label;
  }

  function escHtml(str) {
    return String(str ?? "").replace(/[&<>'"]/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    }[c]));
  }

  function renderVersionAlert(cfg) {
    const card = $("versionUpdateBanner");
    if (!card) return;
    if (!cfg) {
      card.classList.add("hidden");
      return;
    }
    const remoteVer = String(cfg.latestVersion || cfg.version || "").trim();
    const minReqVer = String(cfg.minRequiredVersion || "").trim();
    if (!remoteVer || compareSemver(remoteVer, EXT_VERSION) <= 0) {
      card.classList.add("hidden");
      return;
    }

    const isUrgent = Boolean(minReqVer && compareSemver(minReqVer, EXT_VERSION) > 0);
    latestDownloadUrl = cfg.downloadUrl || `https://flow.toolsbydcx.com/bunny-ai/Tools By DCX-Ai-Extension.zip?v=${encodeURIComponent(remoteVer)}`;

    card.className = `version-alert-card${isUrgent ? " urgent" : ""}`;
    if ($("versionAlertTitle")) {
      $("versionAlertTitle").textContent = isUrgent
        ? `⚠️ Update Required (v${remoteVer})`
        : (cfg.updateTitle || `🚀 New Update v${remoteVer} Available!`);
    }
    if ($("versionAlertBadge")) {
      $("versionAlertBadge").textContent = isUrgent ? "REQUIRED" : `v${remoteVer}`;
    }
    if ($("versionAlertDesc")) {
      $("versionAlertDesc").textContent = cfg.updateMessage || `You are on v${EXT_VERSION}. Update to v${remoteVer} for the latest fixes & features.`;
    }
    const dlBtn = $("versionDownloadBtn");
    if (dlBtn) {
      dlBtn.innerHTML = `<span>⬇ Download Extension v${escHtml(remoteVer)}</span>`;
    }
  }

  async function triggerServerSwitch(targetSlot = null) {
    if (isSwitchingUi) return;
    const activeSlotNow = Number(currentPoolState?.meta?.slot || currentPoolState?.pool?.currentSlot || 0);
    if (targetSlot && activeSlotNow && Number(targetSlot) === activeSlotNow && currentPoolState?.meta?.flowMode !== "image") {
      const curNum = Number(currentPoolState?.pool?.serverNumber || currentPoolState?.meta?.serverNumber || 1);
      const curTotal = Number(currentPoolState?.pool?.totalServers || currentPoolState?.meta?.totalServers || 1);
      showStatus(`✅ Already active on Video Server ${curNum}/${curTotal}!`, "ok");
      return;
    }

    isSwitchingUi = true;
    const swBtn = $("switchServerBtn");
    const pills = document.querySelectorAll(".server-pill-btn");
    if (swBtn) {
      swBtn.disabled = true;
      swBtn.innerHTML = `<span class="switch-btn-left"><span>🔄 Switching Server...</span></span><span class="switch-server-tag">Please wait</span>`;
    }
    pills.forEach((p) => { p.disabled = true; });
    showStatus("Switching Google Flow Video server...", "info");

    let res = null;
    try {
      res = await sendBg({
        type: "SWITCH_SERVER",
        flowMode: "video",
        targetSlot: targetSlot ? Number(targetSlot) : null,
        reason: targetSlot ? "pill_select" : "switch_button"
      });
    } finally {
      isSwitchingUi = false;
      if (swBtn) {
        swBtn.disabled = false;
        swBtn.innerHTML = `
          <span class="switch-btn-left">
            <span>🔀 Switch Server</span>
            <small class="switch-btn-hint">Fix Errors</small>
          </span>
          <span id="switchServerTag" class="switch-server-tag">Server 1</span>
        `;
      }
      pills.forEach((p) => { p.disabled = false; });
    }

    if (!res || !res.success) {
      if (res?.maintenance && res.maintenanceUrl) {
        chrome.tabs.create({ url: res.maintenanceUrl });
        window.close();
        return;
      }
      const rawErr = String(res?.error || "").trim();
      const cleanErr = (!rawErr || /aborted|timeout/i.test(rawErr))
        ? "Server busy — please click Switch Server again."
        : rawErr;
      showStatus(cleanErr, "err");
      if (currentPoolState) renderServerPoolControls(currentPoolState.meta, currentPoolState.pool);
      return;
    }

    if (res.session) {
      renderSessionMeta({
        ...res.session,
        pool: res.pool || res.session.pool || null
      });
    }

    const sNum = Number(res.serverNumber || res.session?.serverNumber || 1);
    const total = Number(res.totalServers || res.session?.totalServers || 1);
    if (res.switched) {
      showStatus(`✅ Switched to Video Server ${sNum}/${total} — Google Flow Reloaded!`, "ok");
    } else if (total <= 1) {
      showStatus(`⚡ Re-synced Video Server 1 cookies!`, "ok");
    } else {
      showStatus(`✅ Active on Video Server ${sNum}/${total} (${res.session?.cookieCount || 0} cookies)!`, "ok");
    }
  }

  function renderServerPoolControls(meta, poolObj) {
    const pool = poolObj || meta?.pool || currentPoolState?.pool || null;
    currentPoolState = { meta, pool };

    const countBadge = $("serverPoolCountBadge");
    const switchBtn = $("switchServerBtn");
    const freeUpgBtn = $("freePlanUpgradeBtn");
    const switchTag = $("switchServerTag");
    const pillsRow = $("serverPoolPillsRow");

    const isImgMode = meta?.flowMode === "image";
    if (isImgMode) {
      if (switchBtn) switchBtn.classList.add("hidden");
      if (freeUpgBtn) freeUpgBtn.classList.add("hidden");
      if (countBadge) countBadge.classList.add("hidden");
      if (pillsRow) {
        pillsRow.classList.add("hidden");
        pillsRow.dataset.structKey = "";
        pillsRow.innerHTML = "";
      }
      return;
    }

    if (countBadge) countBadge.classList.remove("hidden");
    const isFreePool = currentUserIsFree || pool?.mode === "free_video" || Number(meta?.slot) === 5;
    if (switchBtn && freeUpgBtn) {
      if (isFreePool) {
        switchBtn.classList.add("hidden");
        freeUpgBtn.classList.remove("hidden");
      } else {
        switchBtn.classList.remove("hidden");
        freeUpgBtn.classList.add("hidden");
      }
    }

    const sNum = Number(pool?.serverNumber || meta?.serverNumber || 1);
    const total = Number(pool?.totalServers || meta?.totalServers || (Number(meta?.cookieCount) > 0 ? 1 : 0));

    if (countBadge) {
      if (meta?.maintenance) {
        countBadge.textContent = "Maintenance";
      } else if (isFreePool) {
        countBadge.textContent = total > 0 ? "Free 1x" : "Syncing";
      } else {
        countBadge.textContent = total > 0 ? `Server ${sNum}/${total}` : "Syncing...";
      }
    }
    if (switchTag && !isFreePool) {
      if (meta?.maintenance) {
        switchTag.textContent = "Check Status →";
      } else if (total > 1) {
        const nextNum = (sNum % total) + 1;
        switchTag.textContent = `Server ${sNum}/${total} → S${nextNum}`;
      } else if (total === 1) {
        switchTag.textContent = "Server 1/1";
      } else {
        switchTag.textContent = "Syncing...";
      }
    }

    if (!pillsRow) return;
    const servers = Array.isArray(pool?.servers) ? pool.servers : [];
    if (isFreePool || isImgMode) {
      pillsRow.classList.add("hidden");
      pillsRow.dataset.structKey = "";
      pillsRow.innerHTML = "";
      return;
    }
    if (servers.length <= 1) {
      // Only hide if server explicitly returned <= 1 server; never clear already-rendered pills on a null/loading pool
      if (pool && Array.isArray(pool.servers)) {
        pillsRow.classList.add("hidden");
        pillsRow.dataset.structKey = "";
        pillsRow.innerHTML = "";
      }
      return;
    }

    pillsRow.classList.remove("hidden");
    const structKey = servers.map((srv) => `${Number(srv.slot)}:${Number(srv.serverNumber)}`).join("|");
    if (pillsRow.dataset.structKey !== structKey) {
      pillsRow.dataset.structKey = structKey;
      pillsRow.innerHTML = servers.map((srv) => {
        const isActive = Boolean(srv.active || Number(srv.slot) === Number(meta?.slot));
        const isDisabled = Boolean((srv.isFull && !isActive) || isSwitchingUi);
        return `
          <button type="button" class="server-pill-btn${isActive ? " active" : ""}" data-target-slot="${Number(srv.slot)}"${isDisabled ? " disabled" : ""}${srv.isFull && !isActive ? " title=\"Server full\"" : ""}>
            <i class="s-dot"></i>
            <span>Server ${Number(srv.serverNumber)}</span>
          </button>
        `;
      }).join("");

      pillsRow.querySelectorAll(".server-pill-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const slotVal = Number(btn.getAttribute("data-target-slot") || 0);
          if (!slotVal) return;
          triggerServerSwitch(slotVal);
        });
      });
    } else {
      // Update existing button classes in-place so hover states NEVER blink or reset!
      const srvBySlot = new Map(servers.map((srv) => [Number(srv.slot), srv]));
      pillsRow.querySelectorAll(".server-pill-btn").forEach((btn) => {
        const slotVal = Number(btn.getAttribute("data-target-slot") || 0);
        const srv = srvBySlot.get(slotVal);
        if (!srv) return;
        const isActive = Boolean(srv.active || slotVal === Number(meta?.slot));
        btn.classList.toggle("active", isActive);
        btn.disabled = Boolean((srv.isFull && !isActive) || isSwitchingUi);
        if (srv.isFull && !isActive) {
          btn.setAttribute("title", "Server full");
        } else {
          btn.removeAttribute("title");
        }
      });
    }
  }

  function renderSessionMeta(meta) {
    const dot = $("sessionDot");
    const title = $("sessionTitle");
    const sub = $("sessionSub");
    const badge = $("sessionBadge");
    if (!dot || !title || !sub || !badge) return;

    if (meta?.syncSchedule) {
      latestSyncSchedule = meta.syncSchedule;
    }
    startCountdownLoop();

    const count = Number(meta?.cookieCount || meta?.injectedCount || 0);
    const isImgMode = (meta?.flowMode === "image");
    const isFreePool = currentUserIsFree || meta?.pool?.mode === "free_video" || Number(meta?.slot) === 5;
    const sNum = Number(meta?.serverNumber || meta?.pool?.serverNumber || 1);

    const openBtnSpan = $("openFlowBtn")?.querySelector("span");
    if (openBtnSpan && !openBtnSpan.dataset.forceUpdateLabel) {
      openBtnSpan.textContent = isImgMode ? "Open Nano Banana" : "Open Google Flow";
    }

    if (meta && count > 0 && !meta.maintenance) {
      const jar = meta.lastJarWrite || null;
      const jarFailed = jar ? Number(jar.failed || 0) : 0;
      const jarApplied = jar ? Number(jar.applied || 0) : 0;
      const jarBad = jar ? jarFailed > 0 : false;
      const acct = meta.slotName ? ` · ${meta.slotName}` : "";
      const jarText = jar ? ` · Jar ${jarApplied}/${jarApplied + jarFailed} written` : "";
      dot.className = jarBad ? "session-dot err" : "session-dot ok";
      title.textContent = isImgMode
        ? "Nano Banana AI (Image)"
        : (isFreePool ? "Free Trial Video Server (1x)" : `Video Server ${sNum} (Veo 3.1)`);
      sub.textContent = isImgMode
        ? `Auto-Synced · Image account active${acct}`
        : (isFreePool ? `Free Trial (Slow Queue) · ${count} cookies active${acct}` : `Auto-Synced · ${count} Video cookies active${jarText}${acct}`);
      badge.className = jarBad ? "session-badge err" : "session-badge ok";
      badge.textContent = jarBad ? "JAR FAIL" : "READY";
    } else if (meta?.noAccount) {
      dot.className = "session-dot err";
      title.textContent = isImgMode
        ? "Nano Banana AI (No Account)"
        : "Google Flow Video (No Account)";
      sub.textContent = "No shared account is set up for your plan, ask the admin to add one";
      badge.className = "session-badge err";
      badge.textContent = "NO ACCOUNT";
    } else if (meta?.noValidCookies) {
      dot.className = "session-dot err";
      title.textContent = isImgMode
        ? "Nano Banana AI (Cookies Expired)"
        : "Google Flow Video (Cookies Expired)";
      sub.textContent = "The shared account's cookies have expired, ask the admin to refresh them";
      badge.className = "session-badge err";
      badge.textContent = "EXPIRED";
    } else if (meta?.maintenance) {
      dot.className = "session-dot wait";
      title.textContent = isImgMode
        ? "Nano Banana AI (Maintenance)"
        : (isFreePool ? "Free Trial Video (Maintenance)" : "Google Flow Video (Maintenance)");
      sub.textContent = "Server is temporarily under maintenance — auto-healing active";
      badge.className = "session-badge wait";
      badge.textContent = "MAINT";
    } else {
      dot.className = "session-dot wait";
      title.textContent = isImgMode
        ? "Nano Banana AI (Image)"
        : (isFreePool ? "Free Trial Video Server (1x)" : "🎬 Video Account (Veo)");
      sub.textContent = isImgMode
        ? "Auto-syncing Nano Banana Image session..."
        : "Auto-syncing Google Flow server cookies...";
      badge.className = "session-badge wait";
      badge.textContent = "SYNCING";
    }

    renderServerPoolControls(meta, meta?.pool || null);
  }

  function applyLivePopupConfig(cfg) {
    if (!cfg) return;
    renderVersionAlert(cfg);

    if (cfg.syncButtonLabel && $("syncNowBtn")) {
      $("syncNowBtn").dataset.customLabel = "1";
      $("syncNowBtn").innerHTML = `<span>${escHtml(cfg.syncButtonLabel)}</span>`;
    }
    if (cfg.openFlowButtonLabel && $("openFlowBtn")) {
      const span = $("openFlowBtn").querySelector("span");
      if (span) {
        if (/update/i.test(cfg.openFlowButtonLabel)) {
          span.dataset.forceUpdateLabel = "1";
          span.textContent = cfg.openFlowButtonLabel;
        } else {
          delete span.dataset.forceUpdateLabel;
          if (currentPoolState?.meta?.flowMode !== "image") {
            span.textContent = cfg.openFlowButtonLabel;
          }
        }
      }
    }
    if (cfg.customPopupCss) {
      let st = document.getElementById("bunny-live-popup-css");
      if (!st) {
        st = document.createElement("style");
        st.id = "bunny-live-popup-css";
        document.head.appendChild(st);
      }
      st.textContent = cfg.customPopupCss;
    }
    if (cfg.customPopupHtml !== undefined && $("liveRemotePopupSlot")) {
      $("liveRemotePopupSlot").innerHTML = cfg.customPopupHtml || "";
    }
  }

  async function checkLiveVersionAndConfig() {
    try {
      const cached = await storage.get(["liveExtConfig"]);
      if (cached.liveExtConfig) {
        applyLivePopupConfig(cached.liveExtConfig);
      }
      const cr = await fetch(`https://flow.toolsbydcx.com/bunny-ai/extension/live-config?t=${Date.now()}`, {
        headers: {
          "x-bunny-ext-v2": "manual-2.0",
          "x-bunny-ext-version": EXT_VERSION,
          "x-bunny-ext-token": EXT_SECURE_TOKEN
        },
        cache: "no-store"
      });
      const cd = await cr.json().catch(() => ({}));
      if (cd?.success && cd.config) {
        await storage.set({ liveExtConfig: cd.config });
        applyLivePopupConfig(cd.config);
      }
    } catch (_) {}
  }

  function showLoginView() {
    $("loginView")?.classList.remove("hidden");
    $("dashboardView")?.classList.add("hidden");
    setChip(false, "Disconnected");
  }

  function showDashboardView(user) {
    $("loginView")?.classList.add("hidden");
    $("dashboardView")?.classList.remove("hidden");
    setChip(true, "Connected");

    const email = user.email || user.username || "user@flow.toolsbydcx.com";
    const name = user.name || email.split("@")[0] || "Tools By DCX Member";
    if ($("displayUserName")) $("displayUserName").textContent = name;
    if ($("displayUserEmail")) $("displayUserEmail").textContent = email;

    const plan = String(user.plan || "FREE PLAN").toUpperCase();
    currentUserIsFree = plan.includes("FREE") || plan.includes("TRIAL");
    if ($("displayUserPlan")) $("displayUserPlan").textContent = plan.includes("PLAN") ? plan : `${plan} PLAN`;

    const days = user.daysLeft !== undefined ? Number(user.daysLeft) : 0;
    if ($("displayDaysLeft")) {
      $("displayDaysLeft").textContent = days > 0 ? `${days} Days Left` : "Active";
    }
  }

  async function initPopup() {
    if ($("footerVersionLabel")) {
      $("footerVersionLabel").textContent = `v${EXT_VERSION}`;
    }
    await getOrCreateDeviceId();
    checkLiveVersionAndConfig();

    const stored = await storage.get([
      "isLoggedIn",
      "userToken",
      "userEmail",
      "userName",
      "userPlan",
      "flowMode",
      "daysLeft",
      "activeSession",
      "poolInfo"
    ]);

    const currentMode = stored.flowMode === "image" ? "image" : "video";

    if (stored.isLoggedIn === "true" && stored.userToken) {
      showDashboardView({
        name: stored.userName,
        email: stored.userEmail || stored.userName,
        plan: stored.userPlan,
        daysLeft: stored.daysLeft
      });
      const initialMeta = stored.activeSession
        ? { ...stored.activeSession, flowMode: currentMode, pool: stored.poolInfo || stored.activeSession.pool || null }
        : { flowMode: currentMode, pool: stored.poolInfo || null };
      renderSessionMeta(initialMeta);

      const needsInitialForce =
        !stored.activeSession ||
        !Number(stored.activeSession.cookieCount) ||
        stored.activeSession.flowMode !== currentMode ||
        (currentMode === "video" && !stored.poolInfo);
      const syncRes = await sendBg({ type: "SYNC_SESSION", force: needsInitialForce });
      const after = await storage.get(["isLoggedIn", "userToken", "activeSession", "flowMode", "poolInfo"]);
      if (after.isLoggedIn !== "true" || !after.userToken) {
        showLoginView();
        return;
      }
      const bestMeta = syncRes?.session || after.activeSession;
      if (bestMeta) {
        renderSessionMeta({
          ...bestMeta,
          flowMode: after.flowMode || currentMode,
          pool: syncRes?.pool || after.poolInfo || bestMeta.pool || null
        });
      }
      return;
    }

    showLoginView();

    // Auto-attempt Website SSO from cookie or any open flow.toolsbydcx.com tab
    const ssoRes = await sendBg({ type: "TRY_WEB_SSO", force: false });
    if (ssoRes && ssoRes.loggedIn) {
      const fresh = await storage.get(["isLoggedIn", "userToken", "userEmail", "userName", "userPlan", "flowMode", "daysLeft", "activeSession", "poolInfo"]);
      if (fresh.isLoggedIn === "true" && fresh.userToken) {
        showStatus("", "info");
        showDashboardView({
          name: fresh.userName,
          email: fresh.userEmail || fresh.userName,
          plan: fresh.userPlan,
          daysLeft: fresh.daysLeft
        });
        renderSessionMeta(ssoRes.session || fresh.activeSession || { flowMode: fresh.flowMode || "video", pool: fresh.poolInfo || null });
      }
    }
  }

  try {
    if (chrome?.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes.isLoggedIn) {
          if (changes.isLoggedIn.newValue !== "true") {
            showLoginView();
            return;
          }
          storage.get(["userEmail", "userName", "userPlan", "daysLeft", "activeSession", "poolInfo", "flowMode"]).then((st) => {
            showDashboardView({
              name: st.userName,
              email: st.userEmail || st.userName,
              plan: st.userPlan,
              daysLeft: st.daysLeft
            });
            if (st.activeSession) {
              renderSessionMeta({
                ...st.activeSession,
                flowMode: st.flowMode === "image" ? "image" : "video",
                pool: st.poolInfo || st.activeSession.pool || null
              });
            }
          });
        }
        if (changes.activeSession || changes.poolInfo) {
          if (isSwitchingUi) return;
          storage.get(["isLoggedIn", "activeSession", "poolInfo", "flowMode"]).then((st) => {
            if (isSwitchingUi || st.isLoggedIn !== "true" || !st.activeSession) return;
            renderSessionMeta({
              ...st.activeSession,
              flowMode: st.flowMode === "image" ? "image" : "video",
              pool: st.poolInfo || st.activeSession.pool || currentPoolState?.pool || null
            });
          });
        }
      });
    }
  } catch (_) {}

  document.addEventListener("DOMContentLoaded", () => {
    initPopup();

    // Download Latest Version Button
    $("versionDownloadBtn")?.addEventListener("click", () => {
      chrome.tabs.create({ url: latestDownloadUrl || "https://flow.toolsbydcx.com/extension" });
      window.close();
    });

    // Primary Website Login Button
    $("openWebsiteLoginBtn")?.addEventListener("click", async () => {
      const ssoRes = await sendBg({ type: "TRY_WEB_SSO", force: true });
      if (ssoRes && ssoRes.loggedIn) {
        const st = await storage.get(["userEmail", "userName", "userPlan", "daysLeft", "activeSession", "poolInfo", "flowMode"]);
        showStatus("", "info");
        showDashboardView({
          name: st.userName,
          email: st.userEmail || st.userName,
          plan: st.userPlan,
          daysLeft: st.daysLeft
        });
        renderSessionMeta(ssoRes.session || st.activeSession || { flowMode: st.flowMode || "video", pool: st.poolInfo || null });
        return;
      }
      chrome.tabs.create({ url: "https://flow.toolsbydcx.com/login" });
      window.close();
    });

    // 1-Click Sync Website Session Button
    $("webSsoConnectBtn")?.addEventListener("click", async () => {
      const btn = $("webSsoConnectBtn");
      if (btn) btn.disabled = true;
      showStatus("Checking flow.toolsbydcx.com session...", "info");
      const res = await sendBg({ type: "TRY_WEB_SSO", force: true });
      if (btn) btn.disabled = false;
      if (res && res.loggedIn) {
        const st = await storage.get(["userEmail", "userName", "userPlan", "daysLeft", "activeSession", "poolInfo", "flowMode"]);
        showStatus("", "info");
        showDashboardView({
          name: st.userName,
          email: st.userEmail || st.userName,
          plan: st.userPlan,
          daysLeft: st.daysLeft
        });
        renderSessionMeta(res.session || st.activeSession || { flowMode: st.flowMode || "video", pool: st.poolInfo || null });
      } else {
        showStatus("Not signed in on website — opening flow.toolsbydcx.com...", "info");
        chrome.tabs.create({ url: "https://flow.toolsbydcx.com/login" });
        setTimeout(() => window.close(), 250);
      }
    });

    // Open Google Flow (Video)
    $("openFlowBtn")?.addEventListener("click", async () => {
      const btn = $("openFlowBtn");
      if (btn) btn.disabled = true;
      showStatus("Opening Google Flow...", "ok");
      await sendBg({ type: "OPEN_FLOW" });
      setTimeout(() => window.close(), 60);
    });

    // Smart Pool Auto-Switch: 1-Click Switch Server Button
    $("switchServerBtn")?.addEventListener("click", () => {
      triggerServerSwitch(null);
    });

    // Sync Session Now
    $("syncNowBtn")?.addEventListener("click", async () => {
      const btn = $("syncNowBtn");
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = "<span>Syncing...</span>";
      }
      showStatus("Syncing Google Flow cookies...", "info");
      const res = await sendBg({ type: "SYNC_SESSION", force: true });
      if (btn) {
        btn.disabled = false;
        updateAutoSyncButton();
      }
      if (res?.session && Number(res.session.cookieCount) > 0 && !res.session.maintenance) {
        renderSessionMeta(res.session);
        showStatus(`Synced ${res.session.cookieCount} Google Flow cookies!`, "ok");
      } else {
        renderSessionMeta(res?.session || null);
        showStatus(res?.session?.maintenance ? "Server is currently under maintenance." : "Syncing cookies...", "err");
      }
    });

    // Free Plan Upgrade CTA Button
    $("freePlanUpgradeBtn")?.addEventListener("click", () => {
      chrome.tabs.create({ url: "https://flow.toolsbydcx.com/pricing" });
      window.close();
    });

    // Open Website Dashboard
    $("openDashboardBtn")?.addEventListener("click", () => {
      chrome.tabs.create({ url: "https://flow.toolsbydcx.com/dashboard" });
      window.close();
    });
  });
})();
