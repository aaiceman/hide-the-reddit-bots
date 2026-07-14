"use strict";

const DEFAULT_SETTINGS = {
  thresholdDays: 30,
  showAges: true,
  suspectedThreshold: 4,
  almostCertainThreshold: 7,
  hideSuspected: false,
  hideAlmostCertain: true,
  factors: {
    age: true,
    karmaAge: true,
    karmaShape: true,
    namePattern: true,
    dupeComment: true,
    noEmail: true,
    defaultAvatar: true,
    emptyProfile: true,
  },
};

const FACTOR_IDS = [
  "age", "karmaAge", "karmaShape", "namePattern",
  "dupeComment", "noEmail", "defaultAvatar", "emptyProfile",
];

// Deep-merge stored settings over defaults; migrate v1.x hideYoung. (Mirrors content.js.)
function mergeSettings(stored) {
  const s = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  s.factors = { ...DEFAULT_SETTINGS.factors, ...((stored && stored.factors) || {}) };
  if (stored && stored.hideYoung === false && !(stored.factors && "age" in stored.factors)) {
    s.factors.age = false;
  }
  delete s.hideYoung;
  return s;
}

const els = {
  thresholdDays: document.getElementById("thresholdDays"),
  showAges: document.getElementById("showAges"),
  hideSuspected: document.getElementById("hideSuspected"),
  hideAlmostCertain: document.getElementById("hideAlmostCertain"),
  suspectedThreshold: document.getElementById("suspectedThreshold"),
  almostCertainThreshold: document.getElementById("almostCertainThreshold"),
};

function updateSliderLabels() {
  document.getElementById("susVal").textContent = els.suspectedThreshold.value;
  document.getElementById("acVal").textContent = els.almostCertainThreshold.value;
}

async function load() {
  const stored = await browser.storage.local.get("settings");
  const s = mergeSettings(stored.settings);
  els.thresholdDays.value = s.thresholdDays;
  els.showAges.checked = s.showAges;
  els.hideSuspected.checked = s.hideSuspected;
  els.hideAlmostCertain.checked = s.hideAlmostCertain;
  els.suspectedThreshold.value = s.suspectedThreshold;
  els.almostCertainThreshold.value = s.almostCertainThreshold;
  for (const id of FACTOR_IDS) {
    document.getElementById("f_" + id).checked = s.factors[id];
  }
  updateSliderLabels();
}

async function save() {
  const factors = {};
  for (const id of FACTOR_IDS) {
    factors[id] = document.getElementById("f_" + id).checked;
  }
  const s = {
    thresholdDays: Math.max(1, parseInt(els.thresholdDays.value, 10) || DEFAULT_SETTINGS.thresholdDays),
    showAges: els.showAges.checked,
    hideSuspected: els.hideSuspected.checked,
    hideAlmostCertain: els.hideAlmostCertain.checked,
    suspectedThreshold: parseInt(els.suspectedThreshold.value, 10) || DEFAULT_SETTINGS.suspectedThreshold,
    almostCertainThreshold: parseInt(els.almostCertainThreshold.value, 10) || DEFAULT_SETTINGS.almostCertainThreshold,
    factors,
  };
  await browser.storage.local.set({ settings: s });
}

for (const el of Object.values(els)) el.addEventListener("change", save);
for (const id of FACTOR_IDS) {
  document.getElementById("f_" + id).addEventListener("change", save);
}
for (const slider of [els.suspectedThreshold, els.almostCertainThreshold]) {
  slider.addEventListener("input", updateSliderLabels);
}
load();

// ----- stats ----------------------------------------------------------------
let statsSort = { key: "rate", dir: -1 };

function statsRows(stats) {
  return Object.keys(stats).map((sub) => {
    const { seen = 0, hidden = 0 } = stats[sub] || {};
    return { sub, seen, hidden, rate: seen > 0 ? hidden / seen : 0 };
  });
}

function sortRows(rows) {
  const { key, dir } = statsSort;
  return rows.sort((a, b) => {
    if (key === "sub") return a.sub.localeCompare(b.sub) * dir;
    if (a[key] === b[key]) return b.hidden - a.hidden; // tie-break: more hides first
    return (a[key] - b[key]) * dir;
  });
}

async function getStats() {
  const stored = await browser.storage.local.get("stats");
  return stored.stats && typeof stored.stats === "object" ? stored.stats : {};
}

async function renderStats() {
  const rows = sortRows(statsRows(await getStats()));
  const body = document.getElementById("statsBody");
  const empty = document.getElementById("statsEmpty");
  const table = document.getElementById("statsTable");
  body.textContent = "";
  if (!rows.length) {
    table.style.display = "none";
    empty.style.display = "";
    return;
  }
  table.style.display = "";
  empty.style.display = "none";
  for (const r of rows) {
    const tr = document.createElement("tr");
    const cells = [
      ["r/" + r.sub, "left"],
      [String(r.seen), "right"],
      [String(r.hidden), "right"],
      [Math.round(r.rate * 100) + "%", "right"],
    ];
    for (const [text, align] of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      td.style.textAlign = align;
      td.style.padding = "4px";
      td.style.borderBottom = "1px solid #eee";
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
}

function statsMarkdown(rows) {
  const lines = ["| Subreddit | Seen | Hidden | Rate |", "|---|---:|---:|---:|"];
  for (const r of rows) {
    lines.push(`| r/${r.sub} | ${r.seen} | ${r.hidden} | ${Math.round(r.rate * 100)}% |`);
  }
  return lines.join("\n");
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e2) {}
    ta.remove();
    return ok;
  }
}

async function copyStats() {
  const md = statsMarkdown(sortRows(statsRows(await getStats())));
  const ok = await copyToClipboard(md);
  const btn = document.getElementById("copyStats");
  const orig = btn.textContent;
  btn.textContent = ok ? "Copied" : "Copy failed";
  setTimeout(() => (btn.textContent = orig), 1200);
}

async function resetStats() {
  if (!confirm("Reset all hide statistics? This cannot be undone.")) return;
  await browser.storage.local.set({ stats: {} });
  renderStats();
}

document.getElementById("copyStats").addEventListener("click", copyStats);
document.getElementById("resetStats").addEventListener("click", resetStats);
for (const th of document.querySelectorAll("#statsTable th[data-sort]")) {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (statsSort.key === key) statsSort.dir *= -1;
    else statsSort = { key, dir: key === "sub" ? 1 : -1 };
    renderStats();
  });
}
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.stats) renderStats();
});
renderStats();
