"use strict";

// ===== Hide the Reddit Bots — content script (old Reddit layout) =====

const DEFAULT_SETTINGS = { thresholdDays: 30, showAges: true, hideYoung: true };
const NEG_CACHE_MS = 60 * 60 * 1000; // retry failed lookups after 1 hour
const MAX_CONCURRENT = 1; // strictly serial — Reddit rate-limits aggressively
const DEQUEUE_DELAY_MS = 1200; // ~0.8 requests/second
const BACKOFF_MS = 5 * 60 * 1000; // pause 5 minutes after a 429

let settings = { ...DEFAULT_SETTINGS };

// username(lowercase) -> { c: created_utc_seconds | null, t: checkedAt_ms }
const memCache = new Map();
// username(lowercase) -> Set<HTMLAnchorElement>
const registry = new Map();
const fetchQueue = [];
const queued = new Set();
const retriedOnce = new Set();
let activeFetches = 0;
let backoffUntil = 0;

// ----- styles -----
const style = document.createElement("style");
style.textContent = `
  .hrb-hidden { display: none !important; }
  .hrb-age { font-size: 0.85em; margin-left: 4px; font-weight: bold; }
`;
document.documentElement.appendChild(style);

// ----- age math / colors (same scale as the original RES patch) -----
function ageInfo(createdUtcSeconds) {
  const days = Math.floor((Date.now() / 1000 - createdUtcSeconds) / 86400);
  let text;
  if (days >= 365) {
    const y = Math.floor(days / 365);
    text = `[${y} year${y > 1 ? "s" : ""}]`;
  } else if (days >= 30) {
    const m = Math.floor(days / 30);
    text = `[${m} month${m > 1 ? "s" : ""}]`;
  } else {
    text = `[${days} day${days === 1 ? "" : "s"}]`;
  }
  let color = "#888888";
  if (days <= 90) color = "#ff0000";
  else if (days <= 365) color = "#e63939";
  else if (days <= 1095) color = "#cc6666";
  else if (days <= 1825) color = "#b38080";
  else if (days <= 2190) color = "#a38585";
  return { days, text, color };
}

function keyFor(name) {
  return "age:" + name;
}

// ----- rendering -----
function applyToElement(link, entry) {
  // age label span sits immediately after the author link
  let span = link.nextElementSibling;
  if (!(span && span.classList && span.classList.contains("hrb-age"))) {
    span = document.createElement("span");
    span.className = "hrb-age";
    link.after(span);
  }
  if (!settings.showAges) {
    span.textContent = "";
  } else if (entry === undefined || entry === null) {
    span.textContent = "[…]"; // pending
    span.style.color = "#888888";
  } else if (entry.c == null) {
    span.textContent = "[?]"; // unknown age — never hidden
    span.style.color = "#888888";
  } else {
    const info = ageInfo(entry.c);
    span.textContent = info.text;
    span.style.color = info.color;
  }
  // hide / unhide the enclosing post or comment
  const container = link.closest(".thing");
  if (!container) return;
  const young =
    entry != null && entry.c != null && ageInfo(entry.c).days < settings.thresholdDays;
  if (young && settings.hideYoung) {
    container.classList.add("hrb-hidden");
  } else {
    container.classList.remove("hrb-hidden");
  }
}

function applyToUser(name) {
  const entry = memCache.get(name);
  const set = registry.get(name);
  if (!set) return;
  for (const link of set) {
    if (!link.isConnected) {
      set.delete(link); // drop references to removed DOM
      continue;
    }
    applyToElement(link, entry);
  }
}

function reapplyAll() {
  for (const name of registry.keys()) applyToUser(name);
}

// ----- discovery -----
function processNewAuthors() {
  const links = document.querySelectorAll("a.author:not([data-hrb])");
  const toLookup = new Set();
  for (const link of links) {
    link.dataset.hrb = "1";
    const name = link.textContent.trim();
    if (!name || name === "[deleted]") continue;
    const lower = name.toLowerCase();
    let set = registry.get(lower);
    if (!set) {
      set = new Set();
      registry.set(lower, set);
    }
    set.add(link);
    const cached = memCache.get(lower);
    const expired = cached && cached.c == null && Date.now() - cached.t > NEG_CACHE_MS;
    if (cached && !expired) {
      applyToElement(link, cached);
    } else {
      applyToElement(link, null); // pending placeholder
      toLookup.add(lower);
    }
  }
  if (toLookup.size) lookupUsers([...toLookup]);
}

// ----- resolution: storage cache, then network -----
async function lookupUsers(names) {
  const stored = await browser.storage.local.get(names.map(keyFor));
  const now = Date.now();
  for (const name of names) {
    const entry = stored[keyFor(name)];
    const expired = entry && entry.c == null && now - entry.t > NEG_CACHE_MS;
    if (entry && !expired) {
      memCache.set(name, entry);
      applyToUser(name);
    } else {
      enqueueFetch(name);
    }
  }
}

function enqueueFetch(name) {
  if (queued.has(name)) return;
  queued.add(name);
  fetchQueue.push(name);
  pump();
}

function pump() {
  if (activeFetches >= MAX_CONCURRENT) return;
  const wait = backoffUntil - Date.now();
  if (wait > 0) {
    setTimeout(pump, wait + 50);
    return;
  }
  const name = fetchQueue.shift();
  if (name === undefined) return;
  activeFetches++;
  fetchUser(name).finally(() => {
    activeFetches--;
    setTimeout(pump, DEQUEUE_DELAY_MS);
  });
  if (fetchQueue.length) pump(); // fill remaining slots
}

async function fetchUser(name) {
  let entry = { c: null, t: Date.now() }; // default: unknown (negative cache)
  try {
    const resp = await fetch(
      location.origin + "/user/" + encodeURIComponent(name) + "/about.json",
      { credentials: "same-origin" }
    );
    if (resp.status === 429) {
      // honor Retry-After when Reddit provides it, else back off BACKOFF_MS
      const retryAfter = parseInt(resp.headers.get("Retry-After"), 10);
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : BACKOFF_MS;
      backoffUntil = Date.now() + waitMs;
      queued.delete(name);
      if (!retriedOnce.has(name)) {
        retriedOnce.add(name);
        enqueueFetch(name); // one retry after backoff
        return;
      }
      // second 429: fall through and negative-cache
    } else if (resp.ok) {
      const d = await resp.json();
      if (d && d.data && typeof d.data.created_utc === "number") {
        entry = { c: d.data.created_utc, t: Date.now() };
      }
    }
  } catch (e) {
    // network error -> negative cache (retried after NEG_CACHE_MS)
  }
  queued.delete(name);
  memCache.set(name, entry);
  browser.storage.local.set({ [keyFor(name)]: entry });
  applyToUser(name);
}

// ----- settings -----
async function loadSettings() {
  const stored = await browser.storage.local.get("settings");
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    reapplyAll();
  }
});

// ----- observe dynamic content (RES never-ending scroll, expanded comments) -----
let scanTimer = null;
const observer = new MutationObserver(() => {
  if (scanTimer) return;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    processNewAuthors();
  }, 250);
});

// ----- init -----
(async function init() {
  await loadSettings();
  processNewAuthors();
  observer.observe(document.body, { childList: true, subtree: true });
})();
