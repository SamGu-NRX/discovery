// The fetch-mode page. It owns one unfocused x.com window, opens only URLs
// minted by lib/xurl.js in it, and hands each request to content/fetcher.js
// in that tab. lib/fetchrun.js decides what to request; this file does the
// browser I/O, the Worker reservation and the bundle download.

import { FetchRefused, parseTemplate } from "../lib/fetchops.js";
import { parseJobs, runJobs } from "../lib/fetchrun.js";
import { getLocal, loadConfig, pausedOrPausing } from "../lib/store.js";
import { doneRepolls, postStatus, reserveSession } from "../lib/worker-api.js";
import { bookmarksUrl, historyBookmarksUrl, isMintedXUrl, permalinkUrl, searchUrl, xPath } from "../lib/xurl.js";

const $ = (id) => document.getElementById(id);
const LOAD_TIMEOUT_MS = 30_000;
const TEMPLATE_WAIT_MS = 15_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The Nov 12 comparison run (docs/X-DIRECT.md): Sam's 48 new bookmarks above
// the Phase 1 boundary plus 40 below it, and context for the Phase 2 pilot's
// 10 saves.
const DEFAULT_JOBS = {
  limits: { minGapMs: 1500, jitterMs: 1000, runCap: 400, detailCapPerPost: 24, searchPagesPerQuery: 3, linksPerPost: 2 },
  jobs: [
    { type: "bookmarks_until", boundary: "2114348461835637076", after: 40 },
    {
      type: "context",
      ids: [
        "2119930229661503893", "2120494222516339134", "2119870150845599972", "2119879610724720702", "2119124661443457189",
        "2120252783953871317", "2115876931749200320", "2119895207181156424", "2114446672831058376", "2119777023845417175",
      ],
    },
  ],
};

let running = null;
let lastBundle = null;

init();

async function init() {
  $("job").value = JSON.stringify(DEFAULT_JOBS, null, 2);
  const config = await loadConfig();
  const account = await getLocal("lastAccount", null);
  $("account").textContent = account ? `@${account}` : "account unknown";
  const configured = Boolean(config.workerUrl && config.ingestToken);
  $("to-worker").checked = configured;
  $("to-worker").disabled = !configured;
  $("worker-note").textContent = configured
    ? "Batches go to the Worker with mode \"fetch\". The Worker must be deployed with fetch mode, or it rejects them."
    : "No Worker is set in the popup, so results stay in the downloaded bundle only.";
  $("job-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (file) $("job").value = await file.text();
  });
  $("start").addEventListener("click", start);
  $("stop").addEventListener("click", () => {
    if (running) running.stop = true;
    setStatus("stopping after the current request…");
  });
  $("download").addEventListener("click", () => lastBundle && download(lastBundle));
  if (new URLSearchParams(location.search).get("auto") === "repoll") await autoRepoll();
}

// Opened by the service worker's hourly re-poll (background.js,
// startRepolls): one TweetDetail per due post, batches to the Worker, the
// posts that were fetched marked done, then the tab closes. No bundle is
// downloaded.
async function autoRepoll() {
  const { repollJob: job } = await chrome.storage.session.get("repollJob");
  await chrome.storage.session.remove("repollJob");
  if (!job?.ids?.length || Date.now() - job.at > 10 * 60_000) return window.close();
  // The lens may have been cleared since the alarm queued this.
  if ((await loadConfig()).lensId !== job.lensId) return window.close();
  $("to-worker").checked = true;
  const parsed = parseJobs({
    limits: { detailCapPerPost: 1 },
    jobs: [{ type: "context", ids: job.ids, rankings: ["Relevance"], branches: false, upstream: false, quotes: false, mentions: false, links: false, conversation: false }],
  });
  const owner = crypto.randomUUID();
  const refusal = await refuseToStart(owner);
  if (refusal) {
    setStatus(`re-poll skipped: ${refusal}`, "bad");
    return setTimeout(() => window.close(), 5000);
  }
  try {
    const bundle = await run(parsed, owner);
    const fetched = Object.values(bundle.context).filter((c) => c.detailRequests > 0 && !c.error).map((c) => c.id);
    if (fetched.length) await doneRepolls(await loadConfig(), job.account, fetched);
  } finally {
    await chrome.runtime.sendMessage({ type: "fetch-release", owner }).catch(() => {});
    window.close();
  }
}

function setStatus(text, tone = "") {
  $("status").textContent = text;
  $("status").className = tone ? `status-${tone}` : "";
}

async function start() {
  $("job-note").textContent = "";
  let parsed;
  try {
    parsed = parseJobs($("job").value);
  } catch (err) {
    $("job-note").textContent = `Job list: ${err.message}`;
    return;
  }
  const owner = crypto.randomUUID();
  const refusal = await refuseToStart(owner);
  if (refusal) {
    setStatus(refusal, "bad");
    return;
  }
  $("start").disabled = true;
  $("stop").disabled = false;
  $("ledger").replaceChildren();
  try {
    lastBundle = await run(parsed, owner);
    $("download").disabled = false;
    download(lastBundle);
  } catch (err) {
    setStatus(`failed: ${err.message}`, "bad");
  } finally {
    await chrome.runtime.sendMessage({ type: "fetch-release", owner }).catch(() => {});
    $("start").disabled = false;
    $("stop").disabled = true;
  }
}

// The same rules a session follows before it opens a window. The service
// worker admits the run (lib/fetchlock.js), so a session cannot start
// between this check and the run claiming the account.
async function refuseToStart(owner) {
  if (running) return "A fetch run is already going.";
  if (await pausedOrPausing()) return "The extension is paused after an X signal; see the popup.";
  // The Worker files batches under an account, so a run that sends them
  // needs it before it starts; a bundle-only run reads it from its own tab.
  if ($("to-worker").checked && !(await getLocal("lastAccount", null))) return "Open x.com once while logged in, so the account is known.";
  const reply = await chrome.runtime.sendMessage({ type: "fetch-acquire", owner });
  if (reply?.error) return reply.error;
  return reply?.refused ?? null;
}

async function run({ jobs, limits }, owner) {
  const config = await loadConfig();
  let account = await getLocal("lastAccount", null);
  const sessionId = crypto.randomUUID();
  const toWorker = $("to-worker").checked;
  const r = { owner, stop: false, tabId: null, windowId: null, expects: null, opened: null, summaries: {}, learned: [], batches: 0, startedAt: Date.now() };
  running = r;
  let reserved = false;
  const timer = setInterval(() => {
    $("elapsed").textContent = `${Math.round((Date.now() - r.startedAt) / 1000)} s`;
  }, 1000);
  // Holds the lock through rate-limit waits, which can last 16 minutes.
  const beat = setInterval(() => heartbeat(r).catch(() => {}), 20_000);
  const onRemoved = (windowId) => {
    if (windowId === r.windowId) r.stop = true;
  };
  chrome.windows.onRemoved.addListener(onRemoved);
  try {
    if (toWorker) {
      setStatus("reserving with the Worker…");
      const reservation = await reserveSession(config, { account, session_id: sessionId, mode: "fetch" });
      if (!reservation.ok) throw new Error(reservation.reason);
      reserved = true;
    }
    setStatus("opening the x.com window…");
    const win = await chrome.windows.create({ url: "about:blank", focused: false, type: "normal", width: 1200, height: 900 });
    r.windowId = win.id;
    r.tabId = win.tabs[0].id;
    await heartbeat(r);

    let rows = 0;
    const io = {
      now: () => Date.now(),
      sleep,
      random: Math.random,
      paused: () => pausedOrPausing(),
      stopRequested: () => r.stop,
      prime: async (kind, arg) => {
        await prime(r, kind, arg);
        // The handle in the side nav of the page the run just opened.
        const seen = await fetcher(r, "account");
        if (account && seen && seen !== account) throw new FetchRefused(`X shows @${seen}, but this run started as @${account}`);
        account ??= seen;
        if (!account) throw new FetchRefused("X shows no logged-in account in the run's tab");
        $("account").textContent = `@${account}`;
      },
      template: async (operation) => (r.summaries[operation] ? parseTemplate(r.summaries[operation]) : null),
      send: (operation, url) => send(r, operation, url),
      loadPage: (kind, query, product) => loadSearchPage(r, kind, query, product),
      onBatch: async ({ batch }) => {
        r.batches += 1;
        if (!toWorker) return;
        const reply = await chrome.runtime.sendMessage({ type: "fetch-batch", account, session_id: sessionId, batch });
        if (!reply?.queued) throw new Error(`the service worker did not queue a batch: ${reply?.error ?? "no answer"}`);
      },
      onSignal: async ({ reason, detail }) => {
        await chrome.runtime.sendMessage({ type: "fetch-signal", reason, detail });
      },
    };
    // Rows are shown as they arrive; runJobs keeps the full ledger.
    let live = null;
    const show = () => {
      if (!live) return;
      while (rows < live.ledger.length) addRow(live.ledger[rows++]);
      $("requests").textContent = `${live.requests} / ${limits.runCap}`;
      $("posts").textContent = Object.keys(live.posts).length.toLocaleString();
    };
    const watch = setInterval(show, 500);
    setStatus("running");
    let result;
    try {
      result = await runJobs(jobs, limits, { ...io, onStart: (state) => (live = state) });
    } finally {
      clearInterval(watch);
    }
    show();

    const status = statusFor(result.stop);
    if (reserved) {
      const detail = result.stop ? `${result.stop.reason}: ${result.stop.detail}` : `fetch run, ${result.requests} requests`;
      reserved = false;
      await postStatus(config, { account, session_id: sessionId, status, detail }).catch((err) => {
        $("worker-note").textContent = `The Worker did not take this run's status: ${err.message}`;
      });
    }
    setStatus(result.stop ? `stopped: ${result.stop.reason}: ${result.stop.detail}` : "finished", status === "ok" ? "ok" : "bad");
    const { startedAt, endedAt, ...rest } = result;
    return {
      kind: "x-direct-fetch-bundle",
      version: 1,
      extension_version: chrome.runtime.getManifest().version,
      account,
      session_id: sessionId,
      sent_to_worker: toWorker,
      batches: r.batches,
      // Fetching itself calls no model. Tokens spent setting the run up
      // happen outside this page and are not counted here.
      model_tokens: 0,
      started_at: new Date(startedAt).toISOString(),
      ended_at: new Date(endedAt).toISOString(),
      wall_ms: endedAt - startedAt,
      jobs,
      templates: r.learned,
      ...rest,
    };
  } finally {
    clearInterval(timer);
    clearInterval(beat);
    chrome.windows.onRemoved.removeListener(onRemoved);
    // A run that threw before reporting still closes its reservation.
    if (reserved) {
      await postStatus(config, { account, session_id: sessionId, status: "error", detail: "fetch run ended without a result" }).catch(() => {});
    }
    if (r.windowId !== null) await chrome.windows.remove(r.windowId).catch(() => {});
    running = null;
  }
}

// The Worker status for how a run ended. X's own signals keep their name;
// Stop, the cap, a pause another tab set and a run that would have eaten
// into the rate reserve are a clean end; anything else
// (a refused template, a parse failure, a 404) is an error.
function statusFor(stop) {
  if (!stop || ["stopped", "cap", "paused", "rate_budget"].includes(stop.reason)) return "ok";
  return ["rate_limited", "login_wall", "challenge"].includes(stop.reason) ? stop.reason : "error";
}

// Keeps this run's claim on the account fresh, and tells the service worker
// which tab is the run's, so it ignores passive captures from it (the run
// records every response itself). A claim the worker no longer knows, after
// a worker restart for instance, stops the run.
async function heartbeat(r) {
  const reply = await chrome.runtime.sendMessage({ type: "fetch-heartbeat", owner: r.owner, tabId: r.tabId, windowId: r.windowId });
  if (!reply?.held) r.stop = true;
}

// One page load where X itself calls the operation; the runner decides
// whether to try another (bookmarks, then history bookmarks).
const PAGES = {
  bookmarks: ["Bookmarks", () => bookmarksUrl()],
  history_bookmarks: ["Bookmarks", () => historyBookmarksUrl()],
  detail: ["TweetDetail", (id) => permalinkUrl(id)],
  search: ["SearchTimeline", (query) => searchUrl(query)],
};

async function prime(r, kind, arg) {
  if (!Object.hasOwn(PAGES, kind)) throw new FetchRefused(`unknown page kind ${kind}`);
  const [operation, mint] = PAGES[kind];
  const url = mint(arg);
  setStatus(`opening ${url.href} so X calls ${operation}…`);
  await heartbeat(r);
  await open(r, url);
  await waitForTemplate(r, operation);
  setStatus("running");
}

async function open(r, url) {
  if (!isMintedXUrl(url)) throw new FetchRefused("refusing to open a URL that xurl.js did not build");
  r.expects = url.expects;
  r.opened = url.href;
  const completed = new Set();
  const onUpdated = (tabId, info) => {
    if (info.status === "complete") completed.add(tabId);
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  try {
    await chrome.tabs.update(r.tabId, { url: url.href });
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    while (!completed.has(r.tabId) && Date.now() < deadline && !r.stop) await sleep(250);
  } finally {
    chrome.tabs.onUpdated.removeListener(onUpdated);
  }
  await sleep(2500);
  await onExpectedPage(r);
  await chrome.scripting.executeScript({ target: { tabId: r.tabId }, files: ["content/detect.js", "content/fetcher.js"] });
}

async function onExpectedPage(r) {
  const tab = await chrome.tabs.get(r.tabId);
  const path = xPath(tab.url ?? "");
  if (path === null || !r.expects(path)) throw new FetchRefused(`the fetch tab is on ${tab.url} after opening ${r.opened}`);
}

async function waitForTemplate(r, operation) {
  const deadline = Date.now() + TEMPLATE_WAIT_MS;
  while (Date.now() < deadline && !r.stop) {
    const summaries = await fetcher(r, "templates");
    if (summaries[operation]) {
      r.summaries = summaries;
      // What X's page sent, for the bundle: method, path and header names,
      // never a header value.
      const t = summaries[operation];
      r.learned.push({ operation, method: t.method, path: new URL(t.url).pathname, headerNames: t.headerNames, at: new Date().toISOString() });
      return true;
    }
    await sleep(500);
  }
  return false;
}

// Opens a search page and returns the first SearchTimeline response X's own
// page received there, shaped like a fetcher reply.
async function loadSearchPage(r, kind, query, product) {
  if (kind !== "search") throw new FetchRefused(`no page load for ${kind}`);
  const url = searchUrl(query, product);
  const started = performance.now();
  const since = Date.now();
  await heartbeat(r);
  await open(r, url);
  const deadline = Date.now() + TEMPLATE_WAIT_MS;
  while (Date.now() < deadline && !r.stop) {
    const [first] = await fetcher(r, "responses", { operation: "SearchTimeline", since });
    if (first) return { status: 200, contentType: "application/json", text: first.body, url: first.url, ms: Math.round(performance.now() - started) };
    await sleep(500);
  }
  const seen = await fetcher(r, "inspect");
  if (seen && ["login_wall", "challenge", "rate_limited"].includes(seen.blocker)) {
    return { status: 0, contentType: "", text: "", ms: 0, blocked: { blocker: seen.blocker, evidence: seen.evidence, path: seen.path } };
  }
  throw new Error(`X loaded no search results for ${query} within ${TEMPLATE_WAIT_MS / 1000} s`);
}

async function send(r, operation, url) {
  await onExpectedPage(r);
  await heartbeat(r);
  return fetcher(r, "get", { operation, url });
}

// The fetcher's own GET gives up after 20 s (content/fetcher.js). The call
// into the tab has no limit of its own: on Nov 12, while the disk was full,
// one call never returned and the run sat on it for 39 minutes until its
// window was closed. 45 s covers the GET plus a slow tab; past that the call
// fails, which stops the run like any request that fails outright.
const FETCHER_CALL_MS = 45_000;

function fetcher(r, name, arg) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`fetcher ${name}: the x.com tab did not answer within ${FETCHER_CALL_MS / 1000} s`)), FETCHER_CALL_MS);
  });
  return Promise.race([callFetcher(r, name, arg), late]).finally(() => clearTimeout(timer));
}

async function callFetcher(r, name, arg) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: r.tabId },
    func: async (command) => {
      try {
        return { value: await globalThis.__dxFetcher.run(command) };
      } catch (err) {
        return { error: String(err?.message ?? err) };
      }
    },
    args: [{ name, arg }],
  });
  const reply = injection?.result;
  if (!reply) throw new Error(`fetcher ${name}: no answer from the x.com tab`);
  if (reply.error) throw new Error(reply.error);
  return reply.value;
}

function addRow(row) {
  const tr = document.createElement("tr");
  const what = row.note ?? "";
  for (const [text, cls] of [[row.i, ""], [row.operation, ""], [what, "what"], [row.status, row.status === 200 ? "" : "bad"], [row.ms ?? "", ""]]) {
    const td = document.createElement("td");
    td.textContent = String(text);
    if (cls) td.className = cls;
    if (cls === "what") td.title = what;
    tr.append(td);
  }
  $("ledger").append(tr);
  tr.scrollIntoView({ block: "nearest" });
}

function download(bundle) {
  const blob = new Blob([JSON.stringify(bundle, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `x-fetch-${bundle.started_at.replace(/[:.]/g, "-")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
