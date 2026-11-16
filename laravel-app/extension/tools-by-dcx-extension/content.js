// Profile button is unlocked so the customized Google Flow Account Menu can open
if (false) (function () {
  "use strict";

  const SHIELD_ID = "flow-sparx-profile-shield";
  const HEADER_MAX_Y = 180;
  const RESCAN_INTERVAL_MS = 750;
  const observedRoots = new WeakSet();
  const observers = [];
  const blockedEvents = [
    "pointerdown",
    "pointerup",
    "mousedown",
    "mouseup",
    "click",
    "dblclick",
    "auxclick",
    "contextmenu",
    "touchstart",
    "touchend"
  ];

  let profileButton = null;
  let shield = null;
  let scheduled = false;
  let stopped = false;

  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .toUpperCase();
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;

    const rectangle = element.getBoundingClientRect();
    if (rectangle.width <= 0 || rectangle.height <= 0) return false;

    const style = getComputedStyle(element);
    return style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity || 1) > 0;
  }

  function containsUltra(element) {
    if (!(element instanceof Element)) return false;

    const rendered = normalizeText(element.innerText || element.textContent);
    const accessible = normalizeText([
      element.getAttribute("aria-label"),
      element.getAttribute("title")
    ].filter(Boolean).join(" "));

    return rendered.includes("ULTRA") || accessible.includes("ULTRA");
  }

  function collectRoots() {
    const roots = [document];

    for (let index = 0; index < roots.length; index += 1) {
      for (const element of roots[index].querySelectorAll("*")) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }

    return roots;
  }

  function findClickableAncestor(label) {
    const selector = [
      "button",
      "a",
      "[role='button']",
      "[tabindex]",
      "[aria-haspopup]",
      "[aria-expanded]"
    ].join(",");

    const clickable = label.closest(selector);
    if (clickable && isVisible(clickable)) return clickable;

    // Google sometimes renders the control as nested generic divs. In that
    // case, select the largest compact ancestor that still belongs only to the
    // account pill, so the avatar is covered as well as the ULTRA label.
    let fallback = label;
    let current = label.parentElement;

    for (let depth = 0; current && depth < 5; depth += 1) {
      const rectangle = current.getBoundingClientRect();
      if (rectangle.width > 220 || rectangle.height > 100 || !containsUltra(current)) break;

      fallback = current;
      const style = getComputedStyle(current);
      if (
        style.cursor === "pointer" ||
        current.hasAttribute("onclick") ||
        current.hasAttribute("aria-haspopup")
      ) {
        return current;
      }
      current = current.parentElement;
    }

    return fallback;
  }

  function findProfileButton() {
    const candidates = [];

    for (const root of collectRoots()) {
      observeRoot(root);

      const elements = root.querySelectorAll(
        "button, [role='button'], [aria-label], [title], span, div"
      );

      for (const element of elements) {
        if (element.id === SHIELD_ID || !isVisible(element)) continue;

        const rectangle = element.getBoundingClientRect();
        if (rectangle.top < 0 || rectangle.top > HEADER_MAX_Y) continue;
        if (rectangle.left < window.innerWidth * 0.45) continue;

        const rendered = normalizeText(element.innerText || element.textContent);
        const accessible = normalizeText([
          element.getAttribute("aria-label"),
          element.getAttribute("title")
        ].filter(Boolean).join(" "));

        const exact = rendered === "ULTRA";
        if (!rendered.includes("ULTRA") && !accessible.includes("ULTRA")) continue;

        const area = rectangle.width * rectangle.height;
        const score = (exact ? 0 : 100000) + rendered.length * 100 + area;
        candidates.push({ element, score });
      }
    }

    candidates.sort((left, right) => left.score - right.score);
    if (!candidates.length) return null;

    return findClickableAncestor(candidates[0].element);
  }

  function createShield() {
    const element = document.createElement("div");
    element.id = SHIELD_ID;
    element.tabIndex = -1;
    element.title = "Account menu locked";
    element.setAttribute("aria-hidden", "true");

    const lockBadge = document.createElement("span");
    lockBadge.setAttribute("aria-hidden", "true");
    Object.assign(lockBadge.style, {
      position: "absolute",
      left: "-24px",
      top: "50%",
      transform: "translateY(-50%)",
      display: "flex",
      width: "20px",
      height: "20px",
      alignItems: "center",
      justifyContent: "center",
      border: "1px solid rgba(174, 151, 255, 0.7)",
      borderRadius: "7px",
      background: "linear-gradient(145deg, #5a3cc7, #2b1a70)",
      boxShadow: "0 0 10px rgba(132, 91, 255, 0.55)",
      color: "#ffffff",
      pointerEvents: "none"
    });

    const svgNamespace = "http://www.w3.org/2000/svg";
    const lockSvg = document.createElementNS(svgNamespace, "svg");
    lockSvg.setAttribute("viewBox", "0 0 24 24");
    lockSvg.setAttribute("width", "13");
    lockSvg.setAttribute("height", "13");
    lockSvg.setAttribute("aria-hidden", "true");

    const lockPath = document.createElementNS(svgNamespace, "path");
    lockPath.setAttribute("fill", "currentColor");
    lockPath.setAttribute(
      "d",
      "M17 8h-1V6a4 4 0 0 0-8 0v2H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2Zm-7-2a2 2 0 1 1 4 0v2h-4V6Zm3 10.73V18h-2v-1.27a2 2 0 1 1 2 0Z"
    );

    lockSvg.appendChild(lockPath);
    lockBadge.appendChild(lockSvg);
    element.appendChild(lockBadge);

    Object.assign(element.style, {
      position: "fixed",
      display: "none",
      zIndex: "2147483647",
      margin: "0",
      padding: "0",
      border: "0",
      background: "rgba(0, 0, 0, 0.001)",
      pointerEvents: "auto",
      touchAction: "none",
      userSelect: "none",
      cursor: "not-allowed",
      boxSizing: "border-box",
      overflow: "visible"
    });

    document.body.appendChild(element);
    return element;
  }

  function eventTouchesLockedArea(event) {
    const path = typeof event.composedPath === "function"
      ? event.composedPath()
      : [];

    const touchesShield = Boolean(shield) &&
      (event.target === shield || path.includes(shield));

    const targetIsNode = event.target instanceof Node;
    const touchesProfile = Boolean(profileButton) && targetIsNode &&
      (event.target === profileButton || profileButton.contains(event.target) || path.includes(profileButton));

    return touchesShield || touchesProfile;
  }

  function blockEvent(event) {
    if (!eventTouchesLockedArea(event)) return;

    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function blockKeyboard(event) {
    if (!profileButton) return;

    const root = profileButton.getRootNode();
    const activeElement = root && "activeElement" in root
      ? root.activeElement
      : document.activeElement;

    const eventTargetIsNode = event.target instanceof Node;
    const activeIsNode = activeElement instanceof Node;
    const targetsProfile =
      (eventTargetIsNode && (event.target === profileButton || profileButton.contains(event.target))) ||
      (activeIsNode && (activeElement === profileButton || profileButton.contains(activeElement)));

    if (!targetsProfile) return;
    if (!["Enter", " ", "Spacebar", "ArrowDown"].includes(event.key)) return;

    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (typeof profileButton.blur === "function") profileButton.blur();
  }

  function blockFocus(event) {
    if (!profileButton || !(event.target instanceof Node)) return;
    if (event.target !== profileButton && !profileButton.contains(event.target)) return;

    if (typeof event.target.blur === "function") event.target.blur();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function disableProfileButton(button) {
    profileButton = button;
    button.setAttribute("aria-disabled", "true");
    button.setAttribute("data-flow-sparx-locked", "true");
    button.tabIndex = -1;
    if ("inert" in button) button.inert = true;
    button.style.cursor = "not-allowed";
  }

  function positionShield() {
    if (!shield || !profileButton || !isVisible(profileButton)) {
      if (shield) shield.style.display = "none";
      return;
    }

    const rectangle = profileButton.getBoundingClientRect();
    const padding = 3;
    shield.style.left = `${Math.round(rectangle.left - padding)}px`;
    shield.style.top = `${Math.round(rectangle.top - padding)}px`;
    shield.style.width = `${Math.round(rectangle.width + padding * 2)}px`;
    shield.style.height = `${Math.round(rectangle.height + padding * 2)}px`;
    shield.style.borderRadius = getComputedStyle(profileButton).borderRadius || "12px";
    shield.style.display = "block";
  }

  function observeRoot(root) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);

    const observer = new MutationObserver((mutations) => {
      const meaningful = mutations.some((mutation) => {
        const target = mutation.target;
        return !shield || (target !== shield && !shield.contains(target));
      });
      if (meaningful) scheduleSync();
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      // Excluding style prevents the shield's own repositioning from creating
      // a mutation feedback loop. The interval handles layout-only changes.
      attributeFilter: ["class", "aria-label", "aria-expanded", "aria-haspopup"]
    });
    observers.push(observer);
  }

  function syncShield() {
    scheduled = false;
    if (stopped || !document.body) return;

    for (const root of collectRoots()) observeRoot(root);

    if (!shield || !shield.isConnected) shield = createShield();

    const currentButtonIsValid = profileButton &&
      profileButton.isConnected &&
      isVisible(profileButton) &&
      containsUltra(profileButton);

    if (!currentButtonIsValid) {
      profileButton = findProfileButton();
      if (profileButton) disableProfileButton(profileButton);
    }

    positionShield();
  }

  function scheduleSync() {
    if (scheduled || stopped) return;
    scheduled = true;
    requestAnimationFrame(syncShield);
  }

  for (const eventName of blockedEvents) {
    document.addEventListener(eventName, blockEvent, {
      capture: true,
      passive: false
    });
  }

  document.addEventListener("keydown", blockKeyboard, {
    capture: true,
    passive: false
  });
  document.addEventListener("focusin", blockFocus, {
    capture: true,
    passive: false
  });

  function start() {
    if (!document.documentElement) {
      window.setTimeout(start, 25);
      return;
    }
    observeRoot(document);
    scheduleSync();
  }

  window.addEventListener("resize", scheduleSync, { passive: true });
  window.addEventListener("scroll", scheduleSync, { passive: true, capture: true });

  const intervalId = window.setInterval(scheduleSync, RESCAN_INTERVAL_MS);
  window.addEventListener("pagehide", () => {
    stopped = true;
    window.clearInterval(intervalId);
    for (const observer of observers) observer.disconnect();
  }, { once: true });

  start();
})();

// Model Switcher & Plan-Based Model/Batch Rules are handled by flow-shield.js
if (false) (function () {
  "use strict";

  const ALLOWED_MODEL = "VEO 3.1 - LITE [LOWER PRIORITY]";
  const LOCK_ATTRIBUTE = "data-flow-sparx-model-locked";
  const LOCK_EMOJI_ATTRIBUTE = "data-flow-sparx-lock-emoji";
  const OPTION_SELECTOR = [
    "[role='option']",
    "[role='menuitem']",
    "[role='menuitemradio']"
  ].join(",");
  const BLOCKED_EVENTS = [
    "pointerdown",
    "pointerup",
    "mousedown",
    "mouseup",
    "click",
    "dblclick",
    "auxclick",
    "contextmenu",
    "touchstart",
    "touchend"
  ];

  const originalStates = new WeakMap();
  const lockedElements = new Set();
  const observedRoots = new WeakSet();
  const observers = [];

  let activeMenu = null;
  let filterTimer = null;
  let stopped = false;

  function canonicalText(value) {
    return String(value || "")
      .replace(/[–—−]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .toUpperCase();
  }

  function elementText(element) {
    return canonicalText(element.innerText || element.textContent);
  }

  function isAllowed(element) {
    return elementText(element).includes(ALLOWED_MODEL);
  }

  function looksLikeModel(element) {
    const text = elementText(element);
    return /\bVEO\s*\d|\bOMNI\b|\bIMAGEN\b|\bGEMINI\b|\bNANO BANANA\b/.test(text);
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const rectangle = element.getBoundingClientRect();
    if (rectangle.width <= 0 || rectangle.height <= 0) return false;

    const style = getComputedStyle(element);
    return style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity || 1) > 0;
  }

  function collectRoots() {
    const roots = [document];
    for (let index = 0; index < roots.length; index += 1) {
      for (const element of roots[index].querySelectorAll("*")) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    return roots;
  }

  function findAllowedOption(searchRoot) {
    const candidates = searchRoot.querySelectorAll(
      `${OPTION_SELECTOR}, button, li, [tabindex], div, span`
    );
    const matches = [];

    for (const element of candidates) {
      if (!isVisible(element) || !isAllowed(element)) continue;
      const rectangle = element.getBoundingClientRect();
      if (rectangle.width > 1000 || rectangle.height > 220) continue;

      const text = elementText(element);
      const exact = text === ALLOWED_MODEL;
      matches.push({
        element,
        score: (exact ? 0 : 100000) + text.length * 100 + rectangle.width * rectangle.height
      });
    }

    matches.sort((left, right) => left.score - right.score);
    if (!matches.length) return null;

    const label = matches[0].element;
    const semanticOption = label.closest(
      `${OPTION_SELECTOR}, button, li, [aria-selected]`
    );
    if (semanticOption && isVisible(semanticOption)) return semanticOption;

    let fallback = label;
    let current = label.parentElement;
    for (let depth = 0; current && depth < 5; depth += 1) {
      const rectangle = current.getBoundingClientRect();
      if (rectangle.width > 1000 || rectangle.height > 220 || !isAllowed(current)) break;

      fallback = current;
      const style = getComputedStyle(current);
      if (
        style.cursor === "pointer" ||
        current.hasAttribute("tabindex") ||
        current.hasAttribute("aria-selected")
      ) {
        return current;
      }
      current = current.parentElement;
    }

    return fallback;
  }

  function findMenu(allowedOption) {
    const semanticMenu = allowedOption.closest([
      "[role='listbox']",
      "[role='menu']",
      "[data-radix-menu-content]",
      "[data-radix-popper-content-wrapper]"
    ].join(","));
    if (semanticMenu) return semanticMenu;

    const fallback = allowedOption.parentElement || allowedOption;
    let current = fallback;

    for (let depth = 0; current && depth < 6; depth += 1) {
      const text = elementText(current);
      const modelMatches = text.match(/(?:VEO\s*\d|OMNI|IMAGEN|GEMINI)/g) || [];
      // Return the first (smallest) ancestor containing multiple models. Using
      // a larger ancestor could accidentally include unrelated page controls.
      if (modelMatches.length >= 2) return current;

      const rectangle = current.getBoundingClientRect();
      if (rectangle.width > 1200 || rectangle.height > 900) break;
      current = current.parentElement;
    }

    return fallback;
  }

  function uniqueTopLevel(elements) {
    const unique = Array.from(new Set(elements));
    return unique.filter((element) => {
      return !unique.some((other) => other !== element && other.contains(element));
    });
  }

  function collectOptions(menu, allowedOption) {
    let options = Array.from(menu.querySelectorAll(OPTION_SELECTOR))
      .filter((element) => isVisible(element) && elementText(element));

    if (options.length >= 2) return uniqueTopLevel(options);

    options = Array.from(menu.querySelectorAll(
      "button, li, [tabindex], [aria-selected]"
    )).filter((element) => isVisible(element) && looksLikeModel(element));

    if (options.length >= 2) return uniqueTopLevel(options);

    let parent = allowedOption.parentElement;
    for (let depth = 0; parent && depth < 5; depth += 1) {
      const children = Array.from(parent.children)
        .filter((element) => isVisible(element) && looksLikeModel(element));
      if (children.length >= 2) return children;
      if (parent === menu) break;
      parent = parent.parentElement;
    }

    const fallback = Array.from(menu.querySelectorAll("div, span, button, li"))
      .filter((element) => isVisible(element) && looksLikeModel(element));
    const smallest = fallback.filter((element) => {
      return !fallback.some((other) => other !== element && element.contains(other));
    });

    return uniqueTopLevel(smallest.map((element) => {
      return element.closest(`${OPTION_SELECTOR}, button, li, [tabindex]`) || element;
    }));
  }

  function saveOriginalState(option) {
    if (originalStates.has(option)) return;
    originalStates.set(option, {
      opacity: option.style.getPropertyValue("opacity"),
      opacityPriority: option.style.getPropertyPriority("opacity"),
      cursor: option.style.getPropertyValue("cursor"),
      cursorPriority: option.style.getPropertyPriority("cursor"),
      hadAriaDisabled: option.hasAttribute("aria-disabled"),
      ariaDisabled: option.getAttribute("aria-disabled"),
      hadTabIndex: option.hasAttribute("tabindex"),
      tabIndex: option.getAttribute("tabindex")
    });
  }

  function addLockEmojiOnce(option) {
    // React may recreate or revisit the option repeatedly. The marker
    // attribute makes this operation idempotent for every live element.
    if (option.querySelector(`[${LOCK_EMOJI_ATTRIBUTE}="true"]`)) return;

    const lockEmoji = document.createElement("span");
    lockEmoji.setAttribute(LOCK_EMOJI_ATTRIBUTE, "true");
    lockEmoji.setAttribute("aria-hidden", "true");
    lockEmoji.textContent = " 🔒";
    option.appendChild(lockEmoji);
  }

  function removeLockEmoji(option) {
    for (const marker of option.querySelectorAll(`[${LOCK_EMOJI_ATTRIBUTE}="true"]`)) {
      marker.remove();
    }
  }

  function lockOption(option) {
    if (isAllowed(option)) {
      unlockOption(option);
      return;
    }

    saveOriginalState(option);
    option.setAttribute(LOCK_ATTRIBUTE, "true");
    option.setAttribute("aria-disabled", "true");
    option.setAttribute("tabindex", "-1");
    option.style.setProperty("opacity", "0.4", "important");
    option.style.setProperty("cursor", "not-allowed", "important");
    addLockEmojiOnce(option);
    lockedElements.add(option);
  }

  function restoreStyle(option, property, value, priority) {
    if (value) option.style.setProperty(property, value, priority);
    else option.style.removeProperty(property);
  }

  function unlockOption(option) {
    const original = originalStates.get(option);
    option.removeAttribute(LOCK_ATTRIBUTE);
    removeLockEmoji(option);

    if (original) {
      restoreStyle(option, "opacity", original.opacity, original.opacityPriority);
      restoreStyle(option, "cursor", original.cursor, original.cursorPriority);

      if (original.hadAriaDisabled) option.setAttribute("aria-disabled", original.ariaDisabled);
      else option.removeAttribute("aria-disabled");

      if (original.hadTabIndex) option.setAttribute("tabindex", original.tabIndex);
      else option.removeAttribute("tabindex");
    }

    lockedElements.delete(option);
  }

  function pruneDisconnectedOptions() {
    for (const option of Array.from(lockedElements)) {
      if (!option.isConnected) lockedElements.delete(option);
    }
  }

  function filterMenu() {
    if (filterTimer !== null) {
      window.clearTimeout(filterTimer);
      filterTimer = null;
    }
    if (stopped || !document.documentElement) return;

    let allowedOption = null;
    if (activeMenu && activeMenu.isConnected) {
      allowedOption = findAllowedOption(activeMenu);
    }

    if (!allowedOption) {
      activeMenu = null;
      for (const root of collectRoots()) {
        observeRoot(root);
        allowedOption = findAllowedOption(root);
        if (allowedOption) break;
      }
    }

    if (!allowedOption) {
      // Do not unlock still-connected items during React's transient render
      // phases. Only a positively identified allowed option may be unlocked.
      pruneDisconnectedOptions();
      return;
    }

    activeMenu = findMenu(allowedOption);
    const options = collectOptions(activeMenu, allowedOption);
    activeMenu.setAttribute("data-flow-sparx-model-menu", "true");

    pruneDisconnectedOptions();
    for (const option of options) {
      option.setAttribute("data-flow-sparx-model-option", "true");
      if (isAllowed(option)) unlockOption(option);
      else lockOption(option);
    }
  }

  function scheduleFilter() {
    if (filterTimer !== null || stopped) return;
    filterTimer = window.setTimeout(filterMenu, 0);
  }

  function mutationMayContainModels(mutation) {
    if (activeMenu) return true;
    if (mutation.type === "characterData") {
      return /VEO|OMNI|IMAGEN|GEMINI/i.test(mutation.target.textContent || "");
    }
    return Array.from(mutation.addedNodes || []).some((node) => {
      return /VEO|OMNI|IMAGEN|GEMINI/i.test(node.textContent || "");
    });
  }

  function observeRoot(root) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);

    const observer = new MutationObserver((mutations) => {
      if (mutations.some(mutationMayContainModels)) filterMenu();
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["role", "aria-label", "aria-selected"]
    });
    observers.push(observer);
  }

  function isLiveModelMenu(element) {
    if (!(element instanceof Element)) return false;
    if (element.getAttribute("data-flow-sparx-model-menu") === "true") return true;

    const text = elementText(element);
    if (!text.includes(ALLOWED_MODEL)) return false;
    const modelMatches = text.match(/(?:VEO\s*\d|OMNI|IMAGEN|GEMINI|NANO BANANA)/g) || [];
    return modelMatches.length >= 2;
  }

  function resolveLiveModelOption(event) {
    const path = typeof event.composedPath === "function"
      ? event.composedPath().filter((node) => node instanceof Element)
      : [];

    const tagged = path.find((element) => {
      return element.getAttribute(LOCK_ATTRIBUTE) === "true" ||
        element.getAttribute("data-flow-sparx-model-option") === "true";
    });
    if (tagged) return tagged;

    const menuIndex = path.findIndex(isLiveModelMenu);
    if (menuIndex < 0) return null;

    for (let index = 0; index < menuIndex; index += 1) {
      const element = path[index];
      const text = elementText(element);
      if (!text || text.length > 280) continue;

      const semanticOption = element.matches(
        `${OPTION_SELECTOR}, button, li, [tabindex], [aria-selected]`
      );
      if (semanticOption && (looksLikeModel(element) || isAllowed(element))) return element;
      if (looksLikeModel(element) || isAllowed(element)) return element;
    }

    return null;
  }

  function globallyBlockLockedOption(event) {
    if (event.type === "keydown" && !["Enter", " ", "Spacebar"].includes(event.key)) return;
    const option = resolveLiveModelOption(event);
    if (!option || isAllowed(option)) return;

    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  for (const eventName of BLOCKED_EVENTS) {
    document.addEventListener(eventName, globallyBlockLockedOption, {
      capture: true,
      passive: false
    });
  }
  document.addEventListener("keydown", globallyBlockLockedOption, {
    capture: true,
    passive: false
  });

  let observedBody = null;
  let bodyObserver = null;

  function ensureBodyObserver() {
    if (!document.body || observedBody === document.body) return;
    if (bodyObserver) bodyObserver.disconnect();

    observedBody = document.body;
    bodyObserver = new MutationObserver((mutations) => {
      if (activeMenu || mutations.some(mutationMayContainModels)) filterMenu();
    });
    bodyObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function startModelFilter() {
    if (!document.documentElement) {
      window.setTimeout(startModelFilter, 25);
      return;
    }
    ensureBodyObserver();
    scheduleFilter();
  }

  const intervalId = window.setInterval(() => {
    ensureBodyObserver();
    scheduleFilter();
  }, 500);
  window.addEventListener("pagehide", () => {
    stopped = true;
    if (filterTimer !== null) window.clearTimeout(filterTimer);
    window.clearInterval(intervalId);
    if (bodyObserver) bodyObserver.disconnect();
    for (const observer of observers) observer.disconnect();
  }, { once: true });

  startModelFilter();
})();

/*
 * Project / Media privacy lock
 * On the Flow home page, hide existing project cards locally while leaving
 * Google's native "New Project" control visible and usable. This does not
 * delete or modify any server-side projects.
 */
(function () {
  "use strict";

  const LOCK_ATTR = "data-flow-sparx-project-hidden";
  const NEW_PROJECT_RE = /\bNEW\s+PROJECT\b/i;
  const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  const PROJECT_HREF_RE = new RegExp("^/project/" + UUID + "(?:/|$)", "i");
  const HIDDEN = new WeakSet();
  let stopped = false;
  let timer = null;

  function text(el) {
    return String(el?.innerText || el?.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .toUpperCase();
  }

  function visible(el) {
    if (!(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity || 1) > 0;
  }

  function isNewProject(el) {
    return NEW_PROJECT_RE.test(text(el)) && text(el).length <= 160;
  }

  function hasProjectHref(el) {
    if (!(el instanceof Element)) return false;
    const href = el.getAttribute("href");
    if (!href) return false;
    try {
      const url = new URL(href, location.origin);
      return url.origin === location.origin && PROJECT_HREF_RE.test(url.pathname);
    } catch (_) {
      return false;
    }
  }

  function containsProjectLink(el) {
    if (!(el instanceof Element)) return false;
    if (hasProjectHref(el)) return true;
    return Array.from(el.querySelectorAll("a[href]"))
      .some(a => hasProjectHref(a));
  }

  function findCard(link) {
    let cur = link;
    let best = link;

    for (let depth = 0; cur && depth < 8; depth++, cur = cur.parentElement) {
      if (isNewProject(cur)) return null;
      const r = cur.getBoundingClientRect();
      const t = text(cur);

      // Project cards in Flow are compact clickable containers. Prefer the
      // smallest ancestor that contains the project link but is large enough
      // to remove the complete card (image + timestamp), without swallowing
      // the whole page/grid.
      if (r.width > 150 && r.height > 80 && r.width < 900 && r.height < 650) {
        best = cur;
      }
      if (r.width > 1000 || r.height > 750) break;
      if (t.length > 300 && depth > 2) break;
    }
    return best;
  }

  function hide(el) {
    if (!(el instanceof Element) || HIDDEN.has(el)) return;
    if (el.id === "bunny-user-projects-history" || el.closest("#bunny-user-projects-history") || el.querySelector("#bunny-user-projects-history")) return;
    if (isNewProject(el)) return;
    HIDDEN.add(el);
    el.setAttribute(LOCK_ATTR, "true");
    el.setAttribute("aria-hidden", "true");
    el.style.setProperty("display", "none", "important");
    el.style.setProperty("pointer-events", "none", "important");
  }

  function scanProjectLinks() {
    if (stopped || !document.body) return;

    // Only operate on the Flow home/project listing page. Never hide content
    // inside an active project editor.
    if (location.pathname !== "/" && location.pathname !== "") return;

    const links = Array.from(document.querySelectorAll("a[href]"));
    for (const link of links) {
      if (link.closest("#bunny-user-projects-history")) continue;
      if (!visible(link) || !hasProjectHref(link)) continue;
      const card = findCard(link);
      if (card && !isNewProject(card)) hide(card);
    }

    // Some cards may be rendered without anchors. Detect compact repeated
    // timestamp/card controls and hide them, while explicitly preserving the
    // native New Project control.
    const candidates = document.querySelectorAll(
      "button, [role='button'], [role='link'], [tabindex], div, article, li"
    );
    for (const el of candidates) {
      if (!visible(el) || isNewProject(el) || HIDDEN.has(el)) continue;
      const t = text(el);
      if (!t || t.length > 120) continue;
      const looksLikeTimestamp = /^(?:SEPT?\s*09|SEP\s*09)\s*-\s*\d{1,2}:\d{2}$/.test(t);
      if (!looksLikeTimestamp) continue;

      let card = el;
      for (let i = 0; i < 6 && card.parentElement; i++) {
        const parent = card.parentElement;
        if (isNewProject(parent)) break;
        const r = parent.getBoundingClientRect();
        if (r.width >= 180 && r.width <= 900 && r.height >= 80 && r.height <= 650) card = parent;
        else if (r.width > 1000 || r.height > 750) break;
        else card = parent;
      }
      if (!isNewProject(card)) hide(card);
    }
  }

  function schedule() {
    if (timer !== null || stopped) return;
    timer = window.setTimeout(() => {
      timer = null;
      scanProjectLinks();
    }, 0);
  }

  const observer = new MutationObserver(schedule);

  function start() {
    if (!document.body) {
      window.setTimeout(start, 25);
      return;
    }
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["href", "class", "role", "aria-label"]
    });
    schedule();
  }

  const interval = window.setInterval(schedule, 500);
  window.addEventListener("resize", schedule, { passive: true });
  window.addEventListener("pagehide", () => {
    stopped = true;
    if (timer !== null) window.clearTimeout(timer);
    window.clearInterval(interval);
    observer.disconnect();
  }, { once: true });

  start();
})();
