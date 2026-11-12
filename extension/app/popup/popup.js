import { loadConfig } from "../lib/store.js";

const $ = (id) => document.getElementById(id);

const MODE_HELP = {
  off: "Nothing is captured.",
  passive: "Captures posts while you scroll X.",
  active: "Captures while you scroll, plus a read-only session every 3 hours.",
};

const REASON = {
  completed: "finished",
  stopped_by_user: "stopped by you",
  window_closed: "window closed",
  interrupted: "interrupted",
  paused: "paused by the Worker",
  capture_off: "capture turned off",
  login_wall: "login wall",
  rate_limited: "rate limited",
  challenge: "challenge shown",
  error: "error",
};

// Hosts the manifest already grants; anything else needs a permission prompt.
const GRANTED = [/^https:\/\/[^/]+\.workers\.dev$/];

async function render() {
  const config = await loadConfig();
  const local = await chrome.storage.local.get([
    "stats", "lastSession", "nextSessionAt", "pauseUntil", "lastProblem", "lastAccount",
  ]);
  const { activeSession: record } = await chrome.storage.session.get("activeSession");
  // A finished session kept only until its status reaches the Worker is not running.
  const activeSession = record && !record.awaitingReport && !record.statusSent ? record : null;
  const today = new Date().toLocaleDateString("en-CA");

  $("account").textContent = local.lastAccount ? `@${local.lastAccount}` : "";

  const modes = ["off", "passive", "active"];
  document.querySelector(".segmented").style.setProperty("--index", modes.indexOf(config.mode));
  for (const button of document.querySelectorAll(".segmented button")) {
    button.setAttribute("aria-checked", String(button.dataset.mode === config.mode));
    button.tabIndex = button.dataset.mode === config.mode ? 0 : -1;
  }
  $("mode-help").textContent = MODE_HELP[config.mode];

  $("posts-today").textContent = (local.stats?.day === today ? local.stats.postsSent : 0).toLocaleString();

  $("row-running").hidden = !activeSession;
  if (activeSession) {
    $("running").textContent = `${activeSession.phase} · ${activeSession.screens} screens · ${activeSession.posts} posts`;
  }

  const last = local.lastSession;
  const lastCell = $("last-session");
  lastCell.replaceChildren();
  if (last) {
    const dot = document.createElement("span");
    dot.className = `dot ${last.status === "ok" ? (last.reason === "completed" ? "ok" : "") : "bad"}`;
    const unreported = last.reported === false ? " · not yet sent to the Worker" : "";
    lastCell.append(dot, `${ago(last.endedAt)} · ${REASON[last.reason] ?? last.reason}${unreported}`);
    lastCell.title = last.detail ?? "";
  } else {
    lastCell.textContent = "none yet";
    lastCell.title = "";
  }

  const paused = local.pauseUntil && Date.parse(local.pauseUntil) > Date.now();
  $("row-pause").hidden = !paused;
  if (paused) $("pause").textContent = clock(local.pauseUntil);

  const showNext = config.mode === "active" && local.nextSessionAt && !activeSession && !paused;
  $("row-next").hidden = !showNext;
  if (showNext) $("next-session").textContent = until(local.nextSessionAt);

  const problem = local.lastProblem;
  const recentProblem = problem && Date.now() - Date.parse(problem.at) < 24 * 3600_000;
  $("row-problem").hidden = !recentProblem;
  if (recentProblem) {
    $("problem").textContent = problem.message;
    $("problem").title = `${problem.kind} · ${clock(problem.at)}`;
  }

  const run = $("run");
  if (activeSession) {
    run.textContent = "Stop session";
    run.disabled = false;
  } else {
    run.textContent = "Run session now";
    run.disabled = config.mode === "off" || !config.workerUrl || !config.ingestToken || paused;
  }

  const configured = Boolean(config.workerUrl && config.ingestToken);
  if (!configured) $("connection").open = true;
  if (document.activeElement !== $("worker-url")) $("worker-url").value = config.workerUrl;
  $("token").placeholder = config.ingestToken ? `Saved, ends in ${config.ingestToken.slice(-4)}` : "Paste the INGEST token";
}

function ago(iso) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function until(iso) {
  const minutes = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000));
  if (minutes < 60) return `in ${minutes} min`;
  return `in ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function clock(iso) {
  return new Date(iso).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

async function updateConfig(change) {
  const { config = {} } = await chrome.storage.local.get("config");
  await chrome.storage.local.set({ config: { ...config, ...change } });
}

// modeChangedAt tells the service worker which stored captures came after
// a switch to Off.
const setMode = (mode) => updateConfig({ mode, modeChangedAt: Date.now() });

for (const button of document.querySelectorAll(".segmented button")) {
  button.addEventListener("click", () => setMode(button.dataset.mode));
}

// Arrow keys move between modes, as in any radio group.
document.querySelector(".segmented").addEventListener("keydown", (event) => {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
  if (!step) return;
  event.preventDefault();
  const buttons = [...document.querySelectorAll(".segmented button")];
  const index = buttons.findIndex((b) => b.getAttribute("aria-checked") === "true");
  const next = buttons[(index + step + buttons.length) % buttons.length];
  next.focus();
  setMode(next.dataset.mode);
});

$("run").addEventListener("click", async () => {
  const { activeSession } = await chrome.storage.session.get("activeSession");
  const running = activeSession && !activeSession.awaitingReport && !activeSession.statusSent;
  const reply = await chrome.runtime.sendMessage({ type: running ? "stopSession" : "runSession" });
  $("run-note").textContent = reply?.error ?? reply?.reason ?? (reply?.stopping ? "Stopping…" : "");
});

$("open-fetch").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("fetch/fetch.html") });
  window.close();
});

$("connection-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const note = $("save-note");
  const raw = $("worker-url").value.trim();
  let origin;
  try {
    const url = new URL(raw);
    const local = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
    if (url.protocol !== "https:" && !local) throw new Error();
    origin = url.origin;
  } catch {
    note.textContent = "Use an https:// URL.";
    return;
  }

  let warning = "";
  if (!GRANTED.some((pattern) => pattern.test(origin))) {
    const pattern = `${origin}/*`;
    const allowed =
      (await chrome.permissions.contains({ origins: [pattern] })) ||
      (await chrome.permissions.request({ origins: [pattern] }).catch(() => false));
    if (!allowed) warning = " Without access to this host, captures cannot be sent.";
  }

  const token = $("token").value.trim();
  await updateConfig({ workerUrl: origin, ...(token ? { ingestToken: token } : {}) });
  $("token").value = "";
  note.textContent = `Saved.${warning}`;
});

chrome.storage.onChanged.addListener(() => render());
render();
// Keeps "ago" and "in" times current while the popup stays open.
setInterval(render, 30_000);
