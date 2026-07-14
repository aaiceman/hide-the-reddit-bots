"use strict";

// ===== Hide the Reddit Bots — content script (old Reddit layout) =====
// v1.1.0: ID-anchor age estimation + slow verify queue + LRU cache trim.
//
// Resolution pipeline per author:
//   1. verified cache (permanent — creation dates never change)
//   2. estimate from account-ID anchors: if an anchor with a HIGHER id is
//      already comfortably old, this account is at least as old (IDs increase
//      monotonically with registration) -> label [~X years], zero requests.
//      Estimates NEVER hide; hiding requires a verified age.
//   3. slow verify queue (~1 req / 7 s) — only possibly-young or unestimable
//      accounts. Every verification adds an anchor, so demand collapses as
//      calibration builds.

const DEFAULT_SETTINGS = { thresholdDays: 30, showAges: true, hideYoung: true };
const NEG_CACHE_MS = 60 * 60 * 1000; // retry failed lookups after 1 hour
const VERIFY_INTERVAL_MS = 7000; // ~8.5 requests/minute, strictly serial
const BACKOFF_MS = 5 * 60 * 1000; // after a 429 without Retry-After
const SAFE_OLD_BASE_DAYS = 180; // estimation exemption floor
const MAX_ANCHORS = 800;
const TRIM_LIMIT = 50000; // entries that trigger a trim
const TRIM_KEEP = 40000; // entries kept after a trim

let settings = { ...DEFAULT_SETTINGS };

// username(lowercase) -> { c: created_utc|null, t: verifiedAt_ms, id: accountIdNum|undefined, s: lastSeenDay }
const memCache = new Map();
// username(lowercase) -> Set<HTMLAnchorElement>
const registry = new Map();
// username(lowercase) -> accountIdNum harvested from DOM / page JSON this session
const idMap = new Map();
const fetchQueue = [];
const queued = new Set();
const retriedOnce = new Set();
let fetchBusy = false;
let backoffUntil = 0;
let pageJsonTried = false;
// sorted ascending by id: [[idNum, created_utc_seconds], ...]
let anchors = [];
let entryCount = 0;
let trimRunning = false;

// ----- stats (cumulative hide-rate per subreddit, since last reset) -----
// stored in storage.local under "stats": { "<subreddit>": { seen, hidden } }
let stats = {};
let statsUi = { collapsed: false };
const pageSubs = new Set(); // distinct subreddits with >=1 processed .thing this page load
let statsPersistTimer = null;

function bumpSeen(sub) {
  const e = stats[sub] || (stats[sub] = { seen: 0, hidden: 0 });
  e.seen++;
  pageSubs.add(sub);
  schedulePersistStats();
  scheduleBadge();
}

function bumpHidden(sub) {
  const e = stats[sub] || (stats[sub] = { seen: 0, hidden: 0 });
  e.hidden++;
  schedulePersistStats();
  scheduleBadge();
}

function schedulePersistStats() {
  if (statsPersistTimer) return;
  statsPersistTimer = setTimeout(() => {
    statsPersistTimer = null;
    browser.storage.local.set({ stats });
  }, 1000);
}

function flushStats() {
  if (statsPersistTimer) {
    clearTimeout(statsPersistTimer);
    statsPersistTimer = null;
  }
  browser.storage.local.set({ stats });
}

// subreddit context ----------------------------------------------------------
const MIXED_SUBS = new Set(["all", "popular", "mod", "friends"]);

// The single subreddit this page is scoped to, or null for mixed listings
// (front page, /r/all, /r/popular, multireddits, user profiles, search, etc.).
function currentPageSubreddit() {
  const m = location.pathname.match(/^\/r\/([A-Za-z0-9_]+)(?:\/|$)/);
  if (!m) return null;
  const name = m[1].toLowerCase();
  return MIXED_SUBS.has(name) ? null : name;
}

// Subreddit for a specific .thing (post/comment), lowercased, or null.
// Old Reddit annotates .thing with data-subreddit (same family as the
// data-author attributes this extension already relies on).
function subredditOfThing(thing) {
  if (thing && thing.dataset && thing.dataset.subreddit) {
    return thing.dataset.subreddit.toLowerCase();
  }
  return currentPageSubreddit();
}

const today = () => Math.floor(Date.now() / 86400000);
const safeOldDays = () => Math.max(SAFE_OLD_BASE_DAYS, settings.thresholdDays * 2);

// ----- styles -----
const style = document.createElement("style");
style.textContent = `
  .hrb-hidden { display: none !important; }
  .hrb-age { font-size: 0.85em; margin-left: 4px; font-weight: bold; }
  #hrb-badge { position: fixed; bottom: 12px; right: 12px; z-index: 2147483646;
    background: #1a1a1b; color: #d7dadc; border: 1px solid #474748;
    border-radius: 8px; font: 12px/1.3 -apple-system, system-ui, sans-serif;
    padding: 6px 9px; cursor: pointer; box-shadow: 0 1px 4px rgba(0,0,0,.4);
    user-select: none; }
  #hrb-badge.hrb-collapsed { padding: 6px 8px; border-radius: 14px; }
  #hrb-badge .hrb-badge-dot { display: none; }
  #hrb-badge.hrb-collapsed .hrb-badge-full { display: none; }
  #hrb-badge.hrb-collapsed .hrb-badge-dot { display: inline; font-weight: bold; }
`;
document.documentElement.appendChild(style);

// ----- stats badge ----------------------------------------------------------
let badgeEl = null;

function ensureBadge() {
  if (badgeEl) return badgeEl;
  badgeEl = document.createElement("div");
  badgeEl.id = "hrb-badge";
  const full = document.createElement("span");
  full.className = "hrb-badge-full";
  const dot = document.createElement("span");
  dot.className = "hrb-badge-dot";
  dot.textContent = "◑";
  badgeEl.append(full, dot);
  badgeEl.title =
    "Hide the Reddit Bots — hidden / seen (cumulative since reset).\n" +
    "Only verified-young accounts are hidden, so the rate is conservative.\n" +
    "Click to collapse.";
  badgeEl.addEventListener("click", () => {
    statsUi.collapsed = !statsUi.collapsed;
    browser.storage.local.set({ statsUi });
    applyBadgeCollapsed();
  });
  document.body.appendChild(badgeEl);
  applyBadgeCollapsed();
  return badgeEl;
}

function applyBadgeCollapsed() {
  if (badgeEl) badgeEl.classList.toggle("hrb-collapsed", !!statsUi.collapsed);
}

let badgeRepaintTimer = null;

function badgeTotals() {
  const sub = currentPageSubreddit();
  let seen = 0, hidden = 0, label;
  if (sub) {
    const e = stats[sub] || { seen: 0, hidden: 0 };
    seen = e.seen; hidden = e.hidden; label = "r/" + sub;
  } else {
    for (const s of pageSubs) {
      const e = stats[s];
      if (!e) continue;
      seen += e.seen; hidden += e.hidden;
    }
    label = "this page";
  }
  return { seen, hidden, label };
}

function scheduleBadge() {
  if (badgeRepaintTimer) return;
  badgeRepaintTimer = setTimeout(() => {
    badgeRepaintTimer = null;
    renderBadge();
  }, 250);
}

function renderBadge() {
  const hasContext = currentPageSubreddit() != null || pageSubs.size > 0;
  if (!hasContext) return;
  ensureBadge();
  const { seen, hidden, label } = badgeTotals();
  const pct = seen > 0 ? Math.round((hidden / seen) * 100) : 0;
  badgeEl.querySelector(".hrb-badge-full").textContent =
    `${label} · ${hidden} / ${seen} · ${pct}%`;
}

// ----- bot score (v1.3.0) ----------------------------------------------------
// Suggested-username shape: Word_Word_1234 / Word-Word-1234 (optional 2nd sep)
const NAME_PATTERN_RE = /^[A-Z][a-z]+[_-][A-Z][a-z]+[_-]?\d{1,6}$/;

const FACTOR_POINTS = {
  age: 7,
  karmaAgeExtreme: 5,
  karmaAgeHigh: 3,
  karmaShape: 3,
  namePattern: 2,
  dupeComment: 2,
  noEmail: 1,
  defaultAvatar: 1,
  emptyProfile: 1,
};

// entry: cache entry ({c, sig}) or undefined; live: {namePattern, dupe} or null.
// Returns {score, tier, evidence[]}; tier: null | "suspected" | "almost".
// GATE: a tier requires at least one Strong factor (age / karmaAge / karmaShape).
function computeBotScore(entry, live) {
  const f = settings.factors;
  let score = 0;
  let strong = false;
  const evidence = [];
  const add = (pts, label, isStrong) => {
    score += pts;
    if (isStrong) strong = true;
    evidence.push(`${label} (${pts})`);
  };
  const days = entry && entry.c != null ? ageDays(entry.c) : null;
  if (days != null) {
    if (f.age && days < settings.thresholdDays) {
      add(FACTOR_POINTS.age, `account ${days}d old`, true);
    }
    const sig = entry.sig;
    if (sig) {
      if (f.karmaAge && days < 730) {
        const perDay = days > 0 ? sig.tk / days : sig.tk;
        if (perDay >= 1000) {
          add(FACTOR_POINTS.karmaAgeExtreme, `${Math.round(perDay)} karma/day`, true);
        } else if (perDay >= 200) {
          add(FACTOR_POINTS.karmaAgeHigh, `${Math.round(perDay)} karma/day`, true);
        }
      }
      if (f.karmaShape && sig.tk > 10000 && sig.lk > 10 * sig.ck) {
        add(FACTOR_POINTS.karmaShape, "link-heavy karma", true);
      }
      if (f.noEmail && !sig.ve) add(FACTOR_POINTS.noEmail, "no verified email", false);
      if (f.defaultAvatar && sig.di) add(FACTOR_POINTS.defaultAvatar, "default avatar", false);
      if (f.emptyProfile && sig.ep) add(FACTOR_POINTS.emptyProfile, "empty profile", false);
    }
  }
  if (live) {
    if (f.namePattern && live.namePattern) {
      add(FACTOR_POINTS.namePattern, "suggested username", false);
    }
    if (f.dupeComment && live.dupe) {
      add(FACTOR_POINTS.dupeComment, "duplicate comment", false);
    }
  }
  let tier = null;
  if (strong) {
    if (score >= settings.almostCertainThreshold) tier = "almost";
    else if (score >= settings.suspectedThreshold) tier = "suspected";
  }
  return { score, tier, evidence };
}

// ----- age math / colors -----
function ageDays(createdUtcSeconds) {
  return Math.floor((Date.now() / 1000 - createdUtcSeconds) / 86400);
}

function ageText(days) {
  if (days >= 365) {
    const y = Math.floor(days / 365);
    return `${y} year${y > 1 ? "s" : ""}`;
  }
  if (days >= 30) {
    const m = Math.floor(days / 30);
    return `${m} month${m > 1 ? "s" : ""}`;
  }
  return `${days} day${days === 1 ? "" : "s"}`;
}

function ageColor(days) {
  if (days <= 90) return "#ff0000";
  if (days <= 365) return "#e63939";
  if (days <= 1095) return "#cc6666";
  if (days <= 1825) return "#b38080";
  if (days <= 2190) return "#a38585";
  return "#888888";
}

function keyFor(name) {
  return "age:" + name;
}

function idFromFullname(fullname) {
  if (typeof fullname !== "string" || !fullname.startsWith("t2_")) return undefined;
  const n = parseInt(fullname.slice(3), 36);
  return Number.isFinite(n) ? n : undefined;
}

// ----- anchors (id <-> creation-date calibration) -----
function anchorInsertPos(id) {
  let lo = 0,
    hi = anchors.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid][0] < id) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function addAnchor(id, created) {
  if (!Number.isFinite(id) || !Number.isFinite(created)) return;
  const pos = anchorInsertPos(id);
  // skip if a nearby anchor already covers this point (within 3 days)
  for (const nb of [anchors[pos - 1], anchors[pos]]) {
    if (nb && Math.abs(nb[1] - created) < 3 * 86400) return;
  }
  anchors.splice(pos, 0, [id, created]);
  if (anchors.length > MAX_ANCHORS) {
    // drop the anchor in the densest time region
    let best = 1,
      bestGap = Infinity;
    for (let i = 1; i < anchors.length - 1; i++) {
      const gap = anchors[i + 1][1] - anchors[i - 1][1];
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    anchors.splice(best, 1);
  }
  browser.storage.local.set({ anchors });
}

// Returns {days, floor:boolean} when the account is PROVABLY at least
// safeOldDays old (an anchor with id >= this id is itself that old), else null.
function estimateOld(id) {
  if (!Number.isFinite(id) || !anchors.length) return null;
  const pos = anchorInsertPos(id);
  if (pos >= anchors.length) return null; // newer than all anchors — unbounded
  const upper = anchors[pos]; // smallest anchor id >= id
  const minDays = ageDays(upper[1]); // account is AT LEAST this old
  if (minDays <= safeOldDays()) return null;
  if (pos > 0) {
    // interpolate for a nicer display value; the bound above is what we trust
    const [aId, aC] = anchors[pos - 1];
    const [bId, bC] = upper;
    const created = bId === aId ? bC : aC + ((id - aId) * (bC - aC)) / (bId - aId);
    return { days: ageDays(created), floor: false };
  }
  return { days: minDays, floor: true }; // older than our oldest anchor
}

// ----- rendering -----
function ensureSpan(link) {
  let span = link.nextElementSibling;
  if (!(span && span.classList && span.classList.contains("hrb-age"))) {
    span = document.createElement("span");
    span.className = "hrb-age";
    link.after(span);
  }
  return span;
}

function setHidden(link, hidden) {
  const container = link.closest(".thing");
  if (!container) return;
  if (hidden) {
    container.classList.add("hrb-hidden");
    if (!container.dataset.hrbHiddenCounted) {
      container.dataset.hrbHiddenCounted = "1";
      const sub = subredditOfThing(container);
      if (sub) bumpHidden(sub);
    }
  } else {
    container.classList.remove("hrb-hidden");
  }
}

// state: {kind: "pending"|"unknown"|"verified"|"estimated", days?, floor?}
function renderElement(link, state) {
  const span = ensureSpan(link);
  if (!settings.showAges && state.kind !== "verified") {
    span.textContent = "";
  } else if (state.kind === "pending") {
    span.textContent = "[…]";
    span.style.color = "#888888";
  } else if (state.kind === "unknown") {
    span.textContent = "[?]";
    span.style.color = "#888888";
  } else if (state.kind === "estimated") {
    span.textContent = settings.showAges
      ? `[~${ageText(state.days)}${state.floor ? "+" : ""}]`
      : "";
    span.style.color = ageColor(state.days);
  } else {
    // verified
    span.textContent = settings.showAges ? `[${ageText(state.days)}]` : "";
    span.style.color = ageColor(state.days);
  }
  // only VERIFIED ages may hide
  const young = state.kind === "verified" && state.days < settings.thresholdDays;
  setHidden(link, young && settings.hideYoung);
}

function stateFor(name) {
  const entry = memCache.get(name);
  if (entry && entry.c != null) return { kind: "verified", days: ageDays(entry.c) };
  const id = idMap.get(name) ?? (entry ? entry.id : undefined);
  const est = estimateOld(id);
  if (est) return { kind: "estimated", days: est.days, floor: est.floor };
  if (entry && entry.c == null && entry.t > 0 && Date.now() - entry.t < NEG_CACHE_MS) {
    return { kind: "unknown" };
  }
  return { kind: "pending" };
}

function renderUser(name) {
  const set = registry.get(name);
  if (!set) return;
  const state = stateFor(name);
  for (const link of set) {
    if (!link.isConnected) {
      set.delete(link);
      continue;
    }
    renderElement(link, state);
  }
  if (state.kind === "pending" && !queued.has(name)) enqueueVerify(name);
}

function reapplyAll() {
  // settings/anchors changed: prune queue entries that no longer need verifying
  for (let i = fetchQueue.length - 1; i >= 0; i--) {
    const name = fetchQueue[i];
    const k = stateFor(name).kind;
    if (k === "verified" || k === "estimated") {
      fetchQueue.splice(i, 1);
      queued.delete(name);
    }
  }
  for (const name of registry.keys()) renderUser(name);
}

// ----- discovery -----
function harvestIdFromThing(link) {
  const thing = link.closest(".thing");
  if (!thing || !thing.dataset) return undefined;
  // old reddit annotates .thing with data-author / data-author-fullname
  if (thing.dataset.author && thing.dataset.authorFullname) {
    const id = idFromFullname(thing.dataset.authorFullname);
    if (id !== undefined) idMap.set(thing.dataset.author.toLowerCase(), id);
    if (thing.dataset.author.toLowerCase() === link.textContent.trim().toLowerCase()) {
      return id;
    }
  }
  return undefined;
}

function processNewAuthors() {
  const links = document.querySelectorAll("a.author:not([data-hrb])");
  const fresh = [];
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
    harvestIdFromThing(link);
    const thing = link.closest(".thing");
    if (thing && !thing.dataset.hrbSeen) {
      thing.dataset.hrbSeen = "1";
      const sub = subredditOfThing(thing);
      if (sub) bumpSeen(sub);
    }
    fresh.push(lower);
  }
  if (fresh.length) resolveUsers([...new Set(fresh)]);
}

// ----- resolution -----
async function resolveUsers(names) {
  const unknown = names.filter((n) => !memCache.has(n));
  if (unknown.length) {
    const stored = await browser.storage.local.get(unknown.map(keyFor));
    for (const name of unknown) {
      const entry = stored[keyFor(name)];
      if (entry) {
        memCache.set(name, entry);
        if (entry.id !== undefined && !idMap.has(name)) idMap.set(name, entry.id);
      }
    }
  }
  // mark last-seen (at most one write per user per day)
  const day = today();
  const touch = {};
  for (const name of names) {
    const entry = memCache.get(name);
    if (entry && entry.s !== day) {
      entry.s = day;
      touch[keyFor(name)] = entry;
    }
  }
  if (Object.keys(touch).length) browser.storage.local.set(touch);

  for (const name of names) renderUser(name);

  // if some authors still lack an id, try the page's own .json once
  if (!pageJsonTried) {
    const needIds = names.some(
      (n) => stateFor(n).kind === "pending" && idMap.get(n) === undefined
    );
    if (needIds) {
      pageJsonTried = true;
      fetchPageJson();
    }
  }
}

async function fetchPageJson() {
  if (Date.now() < backoffUntil) return;
  try {
    const path = location.pathname.replace(/\/$/, "") || "/"; // root -> "/.json"
    const resp = await fetch(
      location.origin + (path === "/" ? "/.json" : path + ".json") + "?limit=500",
      { credentials: "same-origin" }
    );
    if (resp.status === 429) {
      noteRateLimit(resp);
      return;
    }
    if (!resp.ok) return;
    const data = await resp.json();
    const found = [];
    const walk = (o) => {
      if (!o || typeof o !== "object") return;
      if (typeof o.author === "string" && typeof o.author_fullname === "string") {
        const id = idFromFullname(o.author_fullname);
        if (id !== undefined) {
          const lower = o.author.toLowerCase();
          if (!idMap.has(lower)) {
            idMap.set(lower, id);
            found.push(lower);
          }
        }
      }
      for (const k in o) walk(o[k]);
    };
    walk(data);
    if (found.length) reapplyAll();
  } catch (e) {
    /* page json unavailable — slow queue covers it */
  }
}

// ----- verify queue (strictly serial, gentle) -----
function enqueueVerify(name) {
  if (queued.has(name)) return;
  queued.add(name);
  fetchQueue.push(name);
  pump();
}

function pump() {
  if (fetchBusy) return;
  const wait = backoffUntil - Date.now();
  if (wait > 0) {
    setTimeout(pump, wait + 100);
    return;
  }
  const name = fetchQueue.shift();
  if (name === undefined) return;
  // skip if estimation now covers it (anchors may have grown since enqueue)
  const k = stateFor(name).kind;
  if (k === "verified" || k === "estimated") {
    queued.delete(name);
    renderUser(name);
    pump();
    return;
  }
  fetchBusy = true;
  verifyUser(name).finally(() => {
    fetchBusy = false;
    setTimeout(pump, VERIFY_INTERVAL_MS);
  });
}

function noteRateLimit(resp) {
  const retryAfter = parseInt(resp.headers.get("Retry-After"), 10);
  const waitMs =
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : BACKOFF_MS;
  backoffUntil = Date.now() + waitMs;
}

async function verifyUser(name) {
  let entry = { c: null, t: Date.now(), s: today() }; // default: unknown
  const knownId = idMap.get(name);
  if (knownId !== undefined) entry.id = knownId;
  try {
    const resp = await fetch(
      location.origin + "/user/" + encodeURIComponent(name) + "/about.json",
      { credentials: "same-origin" }
    );
    if (resp.status === 429) {
      noteRateLimit(resp);
      queued.delete(name);
      if (!retriedOnce.has(name)) {
        retriedOnce.add(name);
        enqueueVerify(name); // one retry after backoff
        return;
      }
    } else if (resp.ok) {
      const d = await resp.json();
      if (d && d.data && typeof d.data.created_utc === "number") {
        entry.c = d.data.created_utc;
        // about.json carries the account id (base36, no t2_ prefix)
        if (typeof d.data.id === "string") {
          const id = parseInt(d.data.id, 36);
          if (Number.isFinite(id)) {
            entry.id = id;
            idMap.set(name, id);
          }
        }
        if (entry.id !== undefined) addAnchor(entry.id, entry.c);
        // v1.3.0: snapshot bot-score signals (fields verified 2026-07-14 console tests)
        const sd = d.data.subreddit || {};
        entry.sig = {
          lk: d.data.link_karma || 0,
          ck: d.data.comment_karma || 0,
          tk: d.data.total_karma || 0,
          ve: d.data.has_verified_email === true,
          di: sd.is_default_icon === true,
          ep: !(sd.public_description && sd.public_description.trim()),
        };
      }
    }
  } catch (e) {
    /* network error -> negative entry, retried after NEG_CACHE_MS */
  }
  queued.delete(name);
  const isNew = !memCache.has(name);
  memCache.set(name, entry);
  browser.storage.local.set({ [keyFor(name)]: entry });
  if (isNew) bumpEntryCount();
  renderUser(name);
  if (entry.c != null) reapplyAll(); // new anchor may unlock estimates for others
}

// ----- cache trim (LRU by last-seen day) -----
function bumpEntryCount() {
  entryCount++;
  browser.storage.local.set({ meta: { count: entryCount } });
  if (entryCount > TRIM_LIMIT && !trimRunning) runTrim();
}

async function runTrim() {
  trimRunning = true;
  try {
    const all = await browser.storage.local.get(null);
    const entries = Object.keys(all)
      .filter((k) => k.startsWith("age:"))
      .map((k) => [k, all[k] && all[k].s ? all[k].s : 0]);
    if (entries.length > TRIM_KEEP) {
      entries.sort((a, b) => a[1] - b[1]); // oldest-seen first
      const remove = entries.slice(0, entries.length - TRIM_KEEP).map((e) => e[0]);
      await browser.storage.local.remove(remove);
      entryCount = TRIM_KEEP;
    } else {
      entryCount = entries.length;
    }
    browser.storage.local.set({ meta: { count: entryCount } });
  } finally {
    trimRunning = false;
  }
}

// ----- settings -----
async function loadState() {
  const stored = await browser.storage.local.get([
    "settings", "anchors", "meta", "stats", "statsUi",
  ]);
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  if (Array.isArray(stored.anchors)) anchors = stored.anchors;
  entryCount = stored.meta && stored.meta.count ? stored.meta.count : 0;
  stats = stored.stats && typeof stored.stats === "object" ? stored.stats : {};
  statsUi = { collapsed: false, ...(stored.statsUi || {}) };
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings) {
    settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    reapplyAll();
  }
  if (changes.anchors && Array.isArray(changes.anchors.newValue)) {
    anchors = changes.anchors.newValue; // share calibration across tabs
  }
  if (changes.stats) {
    stats = changes.stats.newValue && typeof changes.stats.newValue === "object"
      ? changes.stats.newValue
      : {};
    renderBadge();
  }
  if (changes.statsUi) {
    statsUi = { collapsed: false, ...(changes.statsUi.newValue || {}) };
    applyBadgeCollapsed();
  }
});

// ----- observe dynamic content -----
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
  await loadState();
  processNewAuthors();
  renderBadge();
  window.addEventListener("pagehide", flushStats);
  observer.observe(document.body, { childList: true, subtree: true });
})();
