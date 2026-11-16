(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  function escHtml(str) {
    return String(str ?? "").replace(/[&<>'"]/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    }[c]));
  }

  async function getProjectsState() {
    const stored = await chrome.storage.local.get(["userEmail", "userToken", "userProjectsByEmail"]);
    const email = String(stored.userEmail || "default").toLowerCase().trim();
    const map = stored.userProjectsByEmail || {};
    const list = Array.isArray(map[email]) ? map[email] : [];
    return { email, token: stored.userToken, map, list };
  }

  function render(list, email) {
    if ($("userSub") && email && email !== "default") {
      $("userSub").textContent = `Saved projects for ${email}`;
    }
    if ($("countBadge")) {
      $("countBadge").textContent = `${list.length} Saved`;
    }
    const box = $("projectsContainer");
    if (!box) return;
    if (!list.length) {
      box.innerHTML = `<div class="empty">No saved projects yet. Click <b>+ Open Google Flow</b> and start a new project — it will automatically be saved here with its real image and date!</div>`;
      return;
    }

    box.innerHTML = `<div class="grid">${list.map((p) => {
      const titleStr = p.title || `Flow Project ${String(p.projectId || "").slice(0, 8)}`;
      const dateStr = (p.updatedAt || p.createdAt)
        ? new Date(p.updatedAt || p.createdAt).toLocaleString()
        : "Saved Project";
      const thumbHtml = p.thumbnail
        ? `<img class="thumb" src="${escHtml(p.thumbnail)}" alt="${escHtml(titleStr)}">`
        : `<div class="placeholder">
             <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><path d="M5 3l14 9-14 9V3z"/></svg>
             <span>Google Flow Project</span>
           </div>`;
      return `
        <div class="card">
          <div class="thumb-wrap">
            ${thumbHtml}
            <button type="button" class="del-btn" data-del-pid="${escHtml(p.projectId)}" title="Remove project">×</button>
          </div>
          <div class="body">
            <div class="title" title="${escHtml(titleStr)}">${escHtml(titleStr)}</div>
            <div class="date">📅 ${escHtml(dateStr)}</div>
            <button type="button" class="open-btn" data-open-url="${escHtml(p.projectUrl)}">
              <span>▶ Open This Project</span>
            </button>
          </div>
        </div>
      `;
    }).join("")}</div>`;

    box.querySelectorAll("[data-open-url]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const url = btn.getAttribute("data-open-url");
        if (url) chrome.tabs.create({ url });
      });
    });

    box.querySelectorAll("[data-del-pid]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const pid = btn.getAttribute("data-del-pid");
        if (!pid) return;
        const st = await getProjectsState();
        const filtered = st.list.filter((x) => x.projectId !== pid);
        st.map[st.email] = filtered;
        await chrome.storage.local.set({ userProjectsByEmail: st.map, currentUserProjects: filtered });
        render(filtered, st.email);
        if (st.token) {
          fetch(`https://flow.toolsbydcx.com/bunny-ai/extension/projects/${encodeURIComponent(pid)}`, {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${st.token}`,
              "x-bunny-ext-v2": "manual-2.0", "x-bunny-ext-version": "2.2.9", "x-bunny-ext-token": "bunny-v229-edition-secured-2026"
            }
          }).catch(() => {});
        }
      });
    });
  }

  async function init() {
    const st = await getProjectsState();
    render(st.list, st.email);

    if (st.token) {
      try {
        const r = await fetch(`https://flow.toolsbydcx.com/bunny-ai/extension/projects?t=${Date.now()}`, {
          headers: {
            Authorization: `Bearer ${st.token}`,
            "x-bunny-ext-v2": "manual-2.0", "x-bunny-ext-version": "2.2.9", "x-bunny-ext-token": "bunny-v229-edition-secured-2026"
          }
        });
        const d = await r.json().catch(() => ({}));
        if (d?.success && Array.isArray(d.projects)) {
          const byId = new Map();
          for (const p of st.list) if (p?.projectId) byId.set(p.projectId, p);
          for (const s of d.projects) {
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
          const merged = Array.from(byId.values());
          st.map[st.email] = merged;
          await chrome.storage.local.set({ userProjectsByEmail: st.map, currentUserProjects: merged });
          render(merged, st.email);
        }
      } catch (_) {}
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    init();
    $("newFlowBtn")?.addEventListener("click", () => {
      chrome.tabs.create({ url: "https://flow.google.com/" });
    });
  });
})();
