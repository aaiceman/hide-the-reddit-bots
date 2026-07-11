"use strict";

const DEFAULT_SETTINGS = { thresholdDays: 30, showAges: true, hideYoung: true };

const els = {
  thresholdDays: document.getElementById("thresholdDays"),
  showAges: document.getElementById("showAges"),
  hideYoung: document.getElementById("hideYoung"),
};

async function load() {
  const stored = await browser.storage.local.get("settings");
  const s = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  els.thresholdDays.value = s.thresholdDays;
  els.showAges.checked = s.showAges;
  els.hideYoung.checked = s.hideYoung;
}

async function save() {
  const s = {
    thresholdDays: Math.max(1, parseInt(els.thresholdDays.value, 10) || DEFAULT_SETTINGS.thresholdDays),
    showAges: els.showAges.checked,
    hideYoung: els.hideYoung.checked,
  };
  await browser.storage.local.set({ settings: s });
}

for (const el of Object.values(els)) el.addEventListener("change", save);
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
