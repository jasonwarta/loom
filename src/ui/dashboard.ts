/**
 * The read-only kanban dashboard, as a single self-contained HTML document.
 *
 * It is served verbatim by src/ui/httpServer.ts (NOT by any build step), so it
 * embeds all CSS + JS inline and has zero external dependencies -- matching
 * Loom's low-dependency posture. The page polls the read-only Dispatch API
 * endpoints (/api/queue, /api/status, /api/registry, /api/result) and renders
 * tasks as cards in flow-ordered columns. It issues no mutating requests; the
 * server exposes none.
 *
 * Kept as a TS string constant (rather than a .html asset) so `tsc` carries it
 * into dist/ untouched -- no asset-copy step to maintain.
 */

export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Loom</title>
<style>
  :root {
    --bg: #0e1116; --panel: #161b22; --panel-2: #1c232d; --border: #2a323d;
    --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --ok: #3fb950; --warn: #d29922; --bad: #f85149; --info: #58a6ff; --idle: #6e7681;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: var(--bg); color: var(--text);
    font: 13px/1.45 ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    display: flex; flex-direction: column; height: 100vh; overflow: hidden;
  }
  header {
    display: flex; align-items: center; gap: 16px; padding: 10px 16px;
    background: var(--panel); border-bottom: 1px solid var(--border); flex: none;
  }
  header h1 { font-size: 15px; margin: 0; letter-spacing: .3px; font-weight: 650; }
  header h1 .dot { color: var(--accent); }
  .stats { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; }
  .stat { color: var(--muted); font-variant-numeric: tabular-nums; }
  .stat b { color: var(--text); font-weight: 600; }
  .stat.bad b { color: var(--bad); }
  .spacer { flex: 1; }
  .conn { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
  .conn .led { width: 8px; height: 8px; border-radius: 50%; background: var(--idle); }
  .conn.live .led { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
  .conn.down .led { background: var(--bad); }

  .workers { display: flex; gap: 8px; padding: 8px 16px; overflow-x: auto; flex: none;
    background: var(--panel); border-bottom: 1px solid var(--border); }
  .worker { display: flex; align-items: center; gap: 7px; padding: 4px 10px; border-radius: 999px;
    background: var(--panel-2); border: 1px solid var(--border); white-space: nowrap; font-size: 12px; }
  .worker .av { width: 8px; height: 8px; border-radius: 50%; }
  .worker .load { color: var(--muted); font-variant-numeric: tabular-nums; }
  .av.available { background: var(--ok); } .av.degraded { background: var(--warn); }
  .av.offline { background: var(--idle); } .av.rate_limited { background: var(--bad); }

  .board { display: flex; gap: 12px; padding: 12px 16px; overflow-x: auto; flex: 1; align-items: stretch; }
  .col { flex: 1 1 0; min-width: 230px; display: flex; flex-direction: column;
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .col > h2 { margin: 0; padding: 10px 12px; font-size: 12px; font-weight: 600; letter-spacing: .4px;
    text-transform: uppercase; color: var(--muted); border-bottom: 1px solid var(--border);
    display: flex; justify-content: space-between; align-items: center; }
  .col > h2 .n { background: var(--panel-2); color: var(--text); border-radius: 999px; padding: 1px 8px; font-size: 11px; }
  .col.attention > h2 { color: var(--warn); }
  .cards { padding: 8px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; flex: 1; }
  .card { background: var(--panel-2); border: 1px solid var(--border); border-left: 3px solid var(--idle);
    border-radius: 8px; padding: 9px 10px; cursor: pointer; transition: border-color .12s, transform .06s; }
  .card:hover { border-color: var(--accent); }
  .card:active { transform: translateY(1px); }
  .card .title { font-weight: 550; margin-bottom: 6px; word-break: break-word; }
  .card .meta { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; color: var(--muted); font-size: 11px; }
  .tag { background: #21262d; border: 1px solid var(--border); border-radius: 4px; padding: 0 6px; }
  .badge { border-radius: 4px; padding: 0 6px; font-size: 11px; font-weight: 600; }
  .card .id { margin-left: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; opacity: .7; }
  .empty { color: var(--idle); font-size: 12px; text-align: center; padding: 18px 0; }

  /* state colors on card left-border + badges */
  .s-running, .s-dispatched { border-left-color: var(--info); }
  .s-review { border-left-color: var(--accent); }
  .s-completed { border-left-color: var(--ok); }
  .s-escalated, .s-failed { border-left-color: var(--bad); }
  .s-waiting, .s-revision_requested, .s-retry { border-left-color: var(--warn); }
  .s-cancelled { border-left-color: var(--idle); }
  .badge.s-running, .badge.s-dispatched { background: rgba(88,166,255,.15); color: var(--info); }
  .badge.s-review { background: rgba(88,166,255,.15); color: var(--accent); }
  .badge.s-completed { background: rgba(63,185,80,.15); color: var(--ok); }
  .badge.s-escalated, .badge.s-failed { background: rgba(248,81,73,.15); color: var(--bad); }
  .badge.s-waiting, .badge.s-revision_requested, .badge.s-retry { background: rgba(210,153,34,.15); color: var(--warn); }
  .badge.s-created, .badge.s-queued, .badge.s-cancelled { background: #21262d; color: var(--muted); }

  /* detail drawer */
  .drawer { position: fixed; top: 0; right: 0; height: 100%; width: min(560px, 92vw);
    background: var(--panel); border-left: 1px solid var(--border); transform: translateX(100%);
    transition: transform .18s ease; display: flex; flex-direction: column; z-index: 20; box-shadow: -12px 0 32px rgba(0,0,0,.4); }
  .drawer.open { transform: translateX(0); }
  .drawer .dh { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
  .drawer .dh .id { font-family: ui-monospace, Menlo, monospace; color: var(--muted); font-size: 12px; }
  .drawer .close { margin-left: auto; background: none; border: 1px solid var(--border); color: var(--text);
    border-radius: 6px; width: 28px; height: 28px; cursor: pointer; font-size: 15px; }
  .drawer .body { padding: 14px 16px; overflow-y: auto; }
  .drawer h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .4px; color: var(--muted);
    margin: 18px 0 8px; } .drawer h3:first-child { margin-top: 0; }
  .kv { color: var(--muted); } .kv b { color: var(--text); font-weight: 600; }
  ul.crit { margin: 0; padding-left: 18px; } ul.crit li { margin: 2px 0; }
  .run { border: 1px solid var(--border); border-radius: 6px; padding: 8px; margin-bottom: 6px; background: var(--panel-2); }
  .run .rid { font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
  .events { display: flex; flex-direction: column; gap: 6px; }
  .ev { border-left: 2px solid var(--border); padding: 3px 0 3px 10px; }
  .ev.escalation { border-left-color: var(--bad); } .ev.review { border-left-color: var(--accent); }
  .ev .t { color: var(--muted); font-size: 11px; }
  .ev .r { word-break: break-word; }
  .scrim { position: fixed; inset: 0; background: rgba(0,0,0,.45); opacity: 0; pointer-events: none;
    transition: opacity .18s; z-index: 15; } .scrim.open { opacity: 1; pointer-events: auto; }
  code { font-family: ui-monospace, Menlo, monospace; background: #21262d; padding: 0 4px; border-radius: 4px; }
</style>
</head>
<body>
  <header>
    <h1><span class="dot">&#9632;</span> Loom</h1>
    <div class="stats" id="stats"></div>
    <div class="spacer"></div>
    <div class="conn" id="conn"><span class="led"></span><span id="conn-txt">connecting&hellip;</span></div>
  </header>
  <div class="workers" id="workers"></div>
  <div class="board" id="board"></div>

  <div class="scrim" id="scrim"></div>
  <aside class="drawer" id="drawer">
    <div class="dh"><b id="d-title">Task</b><span class="id" id="d-id"></span>
      <button class="close" id="d-close" title="Close">&times;</button></div>
    <div class="body" id="d-body"></div>
  </aside>

<script>
const COLUMNS = [
  { key: "backlog",    title: "Backlog",        states: ["created", "queued", "retry"] },
  { key: "progress",   title: "In Progress",    states: ["dispatched", "running", "revision_requested"] },
  { key: "validating", title: "Validating",     states: ["review"] },
  { key: "attention",  title: "Needs Attention", states: ["waiting", "escalated", "failed"], attention: true },
  { key: "done",       title: "Done",           states: ["completed", "cancelled"] },
];
const STATE_COL = {};
for (const c of COLUMNS) for (const s of c.states) STATE_COL[s] = c.key;

let selected = null;   // taskId of the open drawer, or null
const $ = (id) => document.getElementById(id);

async function getJSON(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(url + " -> " + r.status);
  return r.json();
}

function fmtCost(n) { return "$" + (Number(n) || 0).toFixed(2); }

function renderStats(status) {
  const byState = status.tasksByState || {};
  const total = Object.values(byState).reduce((a, b) => a + b, 0);
  const esc = status.openEscalations ? status.openEscalations.length : (status.escalations || 0);
  $("stats").innerHTML =
    '<span class="stat"><b>' + total + '</b> tasks</span>' +
    '<span class="stat"><b>' + (byState.running || 0) + '</b> running</span>' +
    '<span class="stat"><b>' + (byState.completed || 0) + '</b> done</span>' +
    '<span class="stat ' + (esc ? "bad" : "") + '"><b>' + esc + '</b> escalations</span>' +
    '<span class="stat"><b>' + fmtCost(status.totalCostUsd) + '</b> spend</span>';
}

function renderWorkers(registry, status) {
  const util = (status && status.utilization) || {};
  $("workers").innerHTML = registry.map((w) => {
    const av = w.availability || "available";
    const load = util[w.workerId] || 0;
    const cap = w.concurrencyLimit != null ? "/" + w.concurrencyLimit : "";
    return '<div class="worker"><span class="av ' + av + '"></span>' +
      '<span>' + esc(w.displayName || w.workerId) + '</span>' +
      '<span class="load">' + load + cap + '</span></div>';
  }).join("") || '<span class="stat">no workers in registry</span>';
}

function card(t) {
  const dep = t.deps && t.deps.length ? '<span class="tag" title="blocked by ' + t.deps.length +
    ' task(s)">&#9741; ' + t.deps.length + '</span>' : "";
  return '<div class="card s-' + t.state + '" data-id="' + t.id + '">' +
    '<div class="title">' + esc(t.title || "(no description)") + '</div>' +
    '<div class="meta">' +
      '<span class="tag">' + esc(t.taskType) + '</span>' +
      '<span class="badge s-' + t.state + '">' + t.state + '</span>' +
      dep +
      '<span class="id">' + t.id.slice(0, 8) + '</span>' +
    '</div></div>';
}

function renderBoard(queue) {
  const buckets = {}; for (const c of COLUMNS) buckets[c.key] = [];
  for (const t of queue.tasks) {
    const key = STATE_COL[t.state] || "backlog";
    buckets[key].push(t);
  }
  // Highest priority first within a column, newest-looking last.
  for (const k in buckets) buckets[k].sort((a, b) => b.priority - a.priority);
  $("board").innerHTML = COLUMNS.map((c) => {
    const items = buckets[c.key];
    const body = items.length ? items.map(card).join("") : '<div class="empty">&mdash;</div>';
    return '<section class="col ' + (c.attention ? "attention" : "") + '">' +
      '<h2>' + c.title + '<span class="n">' + items.length + '</span></h2>' +
      '<div class="cards">' + body + '</div></section>';
  }).join("");
  for (const el of document.querySelectorAll(".card")) {
    el.addEventListener("click", () => openDrawer(el.getAttribute("data-id")));
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function openDrawer(taskId) {
  selected = taskId;
  $("scrim").classList.add("open");
  $("drawer").classList.add("open");
  await refreshDrawer();
}
function closeDrawer() {
  selected = null;
  $("scrim").classList.remove("open");
  $("drawer").classList.remove("open");
}

async function refreshDrawer() {
  if (!selected) return;
  let view;
  try { view = await getJSON("/api/result/" + encodeURIComponent(selected)); }
  catch { return; }
  if (!view || !selected) return;
  const t = view.task, def = t.definition;
  $("d-title").textContent = def.description.split("\n")[0].slice(0, 80);
  $("d-id").textContent = t.id.slice(0, 12);

  const crit = (def.acceptanceCriteria || []).map((c) => "<li>" + esc(c) + "</li>").join("") ||
    "<li class=kv>(none)</li>";
  const runs = (view.runs || []).map((r) => {
    const res = (view.results && view.results[r.runId]) || {};
    const branch = res.branchRef ? ' &rarr; <code>' + esc(res.branchRef) + "</code>" : "";
    return '<div class="run"><span class="rid">' + r.runId.slice(0, 8) + "</span> " +
      '<span class="tag">' + esc(r.runSpec ? r.runSpec.taskType : "?") + "</span> " +
      '<span class="badge s-' + (r.state === "completed" ? "completed" : r.state === "errored" || r.state === "timed_out" ? "failed" : "running") +
      '">' + r.state + "</span>" + branch + "</div>";
  }).join("") || '<div class="kv">no runs yet</div>';

  const events = (view.events || []).slice().reverse().map((e) => {
    const reason = e.data && (e.data.reason || e.data.verdict || e.data.to);
    const cls = e.type === "escalation" ? "escalation" : e.type === "review" ? "review" : "";
    return '<div class="ev ' + cls + '"><div class="t">' + esc(e.type) +
      (e.data && e.data.verdict ? " &middot; " + esc(e.data.verdict) : "") + "</div>" +
      (reason ? '<div class="r">' + esc(reason) + "</div>" : "") + "</div>";
  }).join("");

  $("d-body").innerHTML =
    '<div class="kv">State <b class="badge s-' + t.state + '">' + t.state + "</b>" +
      " &middot; type <b>" + esc(def.taskType) + "</b> &middot; priority <b>" + def.priority + "</b>" +
      " &middot; base <code>" + esc(def.baseBranch) + "</code></div>" +
    "<h3>Description</h3><div>" + esc(def.description) + "</div>" +
    "<h3>Acceptance criteria</h3><ul class=crit>" + crit + "</ul>" +
    (def.verificationCommand ? "<h3>Verification</h3><code>" + esc(def.verificationCommand) + "</code>" : "") +
    "<h3>Runs (" + (view.runs || []).length + ")</h3>" + runs +
    "<h3>Event history</h3><div class=events>" + events + "</div>";
}

let failed = false;
async function tick() {
  try {
    const [queue, status, registry] = await Promise.all([
      getJSON("/api/queue"), getJSON("/api/status"), getJSON("/api/registry"),
    ]);
    renderStats(status);
    renderWorkers(registry, status);
    renderBoard(queue);
    if (selected) await refreshDrawer();
    setConn(true);
  } catch (e) {
    setConn(false);
  }
}
function setConn(live) {
  const el = $("conn");
  el.className = "conn " + (live ? "live" : "down");
  $("conn-txt").textContent = live ? "live · " + new Date().toLocaleTimeString() : "disconnected";
}

$("d-close").addEventListener("click", closeDrawer);
$("scrim").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

tick();
setInterval(tick, 2000);
</script>
</body>
</html>`;
