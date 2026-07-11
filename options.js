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
