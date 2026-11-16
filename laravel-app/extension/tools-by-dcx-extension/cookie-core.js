(function (root) {
  "use strict";

  const DAY_SECONDS = 24 * 60 * 60;
  const MAX_EXTENSION_DAYS = 400;
  const SAME_SITE_VALUES = new Set([
    "no_restriction",
    "lax",
    "strict",
    "unspecified"
  ]);

  function parseCookieInput(text) {
    if (typeof text !== "string" || !text.trim()) {
      throw new Error("Paste a JSON cookie array first.");
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`The pasted text is not valid JSON: ${error.message}`);
    }

    const cookies = Array.isArray(parsed) ? parsed : parsed && parsed.cookies;
    if (!Array.isArray(cookies)) {
      throw new Error("Expected a JSON array, or an object with a cookies array.");
    }
    if (cookies.length === 0) {
      throw new Error("The cookie list is empty.");
    }
    if (cookies.length > 500) {
      throw new Error("For safety, import no more than 500 cookies at once.");
    }

    return cookies;
  }

  function normalizeDomain(value) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("Cookie domain is missing.");
    }

    const original = value.trim().toLowerCase();
    const clean = original.replace(/^\.+/, "");
    if (!clean || clean.includes(":") || clean.includes("/") || /\s/.test(clean)) {
      throw new Error(`Invalid cookie domain: ${value}`);
    }
    return { original, clean };
  }

  const BLOCKED_ROTATION_COOKIE_NAMES = new Set([
    "__Secure-1PSIDRTS",
    "__Secure-3PSIDRTS",
    "SIDRTS",
    "__Secure-STRP",
    "LSID",
    "__Host-1PLSID",
    "__Host-3PLSID",
    "__Host-GAPS",
    "ACCOUNT_CHOOSER",
    "SMSV",
    "OTZ"
  ]);

  function isAllowedDomain(domain) {
    if (domain === "accounts.google.com" || domain.endsWith(".accounts.google.com")) {
      return false;
    }
    return domain === "labs.google" ||
      domain.endsWith(".labs.google") ||
      domain === "google.com" ||
      domain.endsWith(".google.com") ||
      domain === "googleapis.com" ||
      domain.endsWith(".googleapis.com");
  }

  function normalizeSameSite(value) {
    if (value === null || value === undefined || value === "") {
      return undefined;
    }

    const normalized = String(value).toLowerCase().replaceAll("-", "_");
    const mapped = normalized === "none" ? "no_restriction" : normalized;
    if (!SAME_SITE_VALUES.has(mapped)) {
      throw new Error(`Unsupported SameSite value: ${value}`);
    }
    return mapped;
  }

  function normalizePath(value) {
    if (value === null || value === undefined || value === "") {
      return "/";
    }
    if (typeof value !== "string" || !value.startsWith("/")) {
      throw new Error("Cookie path must start with /.");
    }
    return value;
  }

  function normalizePartitionKey(value) {
    if (value === null || value === undefined) {
      return undefined;
    }
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new Error("partitionKey must be an object.");
    }

    const output = {};
    if (value.topLevelSite !== undefined) {
      try {
        const site = new URL(value.topLevelSite);
        if (site.protocol !== "https:" && site.protocol !== "http:") {
          throw new Error();
        }
        output.topLevelSite = site.origin;
      } catch (_error) {
        throw new Error("partitionKey.topLevelSite must be an HTTP(S) origin.");
      }
    }
    if (value.hasCrossSiteAncestor !== undefined) {
      output.hasCrossSiteAncestor = Boolean(value.hasCrossSiteAncestor);
    }
    return Object.keys(output).length ? output : undefined;
  }

  function resolveExpiration(cookie, minimumDays, nowSeconds) {
    if (cookie.session === true) return undefined;
    const original = Number(cookie.expirationDate);
    const hasOriginal = Number.isFinite(original) && original > 0;
    const days = Number.isFinite(Number(minimumDays)) && Number(minimumDays) > 0 ? Number(minimumDays) : 30;
    const chromeMaximum = nowSeconds + MAX_EXTENSION_DAYS * DAY_SECONDS;
    const boundedDays = Math.min(days, MAX_EXTENSION_DAYS);
    const minimum = nowSeconds + boundedDays * DAY_SECONDS;
    return hasOriginal ? Math.min(Math.max(original, minimum), chromeMaximum) : minimum;
  }

  function prepareImport(cookies, options = {}) {
    const nowSeconds = Number.isFinite(options.nowSeconds) ? options.nowSeconds : Date.now() / 1000;
    const unique = new Map();
    let skippedExpired = 0;
    let skippedDuplicates = 0;
    const cookieList = Array.isArray(cookies) ? cookies : (cookies?.cookies || []);

    for (const cookie of cookieList) {
      if (!cookie || typeof cookie !== "object") continue;
      try {
        const item = buildSetDetails(cookie, { ...options, minimumDays: 30, nowSeconds });
        const key = JSON.stringify([
          item.details.name,
          item.expected.domain,
          item.expected.hostOnly,
          item.expected.path,
          item.expected.partitionKey?.topLevelSite || "",
          item.expected.partitionKey?.hasCrossSiteAncestor || false
        ]);
        if (unique.has(key)) skippedDuplicates++;
        unique.set(key, item);
      } catch (_err) {
        skippedDuplicates++;
      }
    }

    if (!unique.size) throw new Error("No valid Google Flow cookies were found in this session.");
    return { prepared: [...unique.values()], skippedExpired, skippedDuplicates };
  }

  function buildSetDetails(cookie, options = {}) {
    if (!cookie || typeof cookie !== "object" || Array.isArray(cookie)) {
      throw new Error("Each cookie must be a JSON object.");
    }
    const name = String(cookie.name || "").trim();
    if (!name) {
      throw new Error("Cookie name must be a non-empty string.");
    }
    if (BLOCKED_ROTATION_COOKIE_NAMES.has(name) || name.endsWith("PSIDRTS") || name.endsWith("SIDRTS")) {
      throw new Error(`Cookie ${name} is a rotation-trigger token and is excluded.`);
    }
    const value = cookie.value !== undefined && cookie.value !== null ? String(cookie.value) : "";

    const rawDomain = String(cookie.domain || "").trim();
    if (!rawDomain) {
      throw new Error("Cookie domain is missing.");
    }
    const domain = normalizeDomain(rawDomain);
    if (!isAllowedDomain(domain.clean)) {
      throw new Error(`Domain ${domain.clean} is outside this extension's allowed Google hosts.`);
    }

    const isHostPrefix = cookie.name.startsWith("__Host-");
    const isSecurePrefix = cookie.name.startsWith("__Secure-");
    const inferredHostOnly = !domain.original.startsWith(".");
    const hostOnly = isHostPrefix ||
      (typeof cookie.hostOnly === "boolean" ? cookie.hostOnly : inferredHostOnly);
    const path = isHostPrefix ? "/" : normalizePath(cookie.path);
    const sameSite = normalizeSameSite(cookie.sameSite);
    const secure = Boolean(cookie.secure) || isHostPrefix || isSecurePrefix ||
      sameSite === "no_restriction";
    const nowSeconds = Number.isFinite(options.nowSeconds)
      ? options.nowSeconds
      : Date.now() / 1000;

    const details = {
      url: `https://${domain.clean}${path}`,
      name: cookie.name,
      value: cookie.value,
      path,
      secure,
      httpOnly: Boolean(cookie.httpOnly)
    };

    if (!hostOnly) {
      details.domain = domain.original.startsWith(".")
        ? domain.original
        : `.${domain.clean}`;
    }

    if (sameSite !== undefined) {
      details.sameSite = sameSite;
    }

    const expirationDate = resolveExpiration(
      cookie,
      options.minimumDays,
      nowSeconds
    );
    if (expirationDate !== undefined) {
      details.expirationDate = expirationDate;
    }

    const partitionKey = normalizePartitionKey(cookie.partitionKey);
    if (partitionKey !== undefined) {
      details.partitionKey = partitionKey;
    }

    return {
      details,
      expected: {
        domain: domain.clean,
        hostOnly,
        path,
        secure,
        httpOnly: Boolean(cookie.httpOnly),
        expirationDate,
        sameSite: sameSite || "unspecified",
        partitionKey
      }
    };
  }

  function verifyCookie(actual, expected) {
    const problems = [];
    if (!actual) return ["Chrome returned no cookie after writing it."];
    if (actual.domain.replace(/^\./, "") !== expected.domain) {
      problems.push("domain does not match");
    }
    if (actual.hostOnly !== expected.hostOnly) {
      problems.push("host-only scope does not match");
    }
    if (actual.path !== expected.path) problems.push("path does not match");
    if (actual.secure !== expected.secure) problems.push("Secure flag does not match");
    if (actual.httpOnly !== expected.httpOnly) problems.push("HttpOnly flag does not match");
    if (actual.sameSite !== expected.sameSite) problems.push("SameSite flag does not match");
    if (Boolean(actual.partitionKey) !== Boolean(expected.partitionKey) ||
        (expected.partitionKey?.topLevelSite &&
          actual.partitionKey?.topLevelSite !== expected.partitionKey.topLevelSite) ||
        (expected.partitionKey?.hasCrossSiteAncestor !== undefined &&
          actual.partitionKey?.hasCrossSiteAncestor !== expected.partitionKey.hasCrossSiteAncestor)) {
      problems.push("partition key does not match");
    }
    if (expected.expirationDate !== undefined) {
      if (!Number.isFinite(actual.expirationDate) ||
          Math.abs(actual.expirationDate - expected.expirationDate) > 2) {
        problems.push("expiration does not match");
      }
    } else if (!actual.session) {
      problems.push("expected a session cookie");
    }
    return problems;
  }

  root.CookieCore = Object.freeze({
    parseCookieInput,
    buildSetDetails,
    prepareImport,
    verifyCookie
  });
})(globalThis);
