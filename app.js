"use strict";
// The dashboard: window.USAGE (data/dashboard.js, written by collect.mjs) drawn as six cards, plus the plan usage that
// serve.mjs reads from Anthropic. Charts are SVG drawn at each card's measured size and redrawn on resize, so
// every aspect ratio gets crisp text and full-width plots.

const DATA = window.USAGE;
const root = document.documentElement;
const token = name => getComputedStyle(root).getPropertyValue(name).trim();
const FAMILIES = ["opus", "sonnet", "fable", "haiku", "other"];
const COLOR = Object.fromEntries([...FAMILIES, "now", "bar", "grid", "baseline", "muted", "fg"].map(k => [k, token(`--${k}`)]));
const HEAT = [0, 1, 2, 3, 4].map(i => token(`--heat-${i}`));
// key, days (null: since the first day of data), button label, title suffix
const RANGES = [["7d", 7, "7d", "Last 7 Days"], ["30d", 30, "30d", "Last 30 Days"], ["90d", 90, "90d", "Last 90 Days"], ["all", null, "All", "All Time"]];
const RANGE_KEY = "claude-usage.range";
// Collection runs daily, so data older than a day and a bit means the job did not run.
const STALE_MS = 26 * 3_600_000;
// serve.mjs asks Anthropic at most every 3 minutes.
const LIMIT_STALE_MS = 15 * 60_000;
// Plan usage this many points over even pacing turns red.
const PACE_MARGIN = 5;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// Stacked layouts size cards to their contents, so lists there show a fixed number of rows instead of filling a box.
const STACKED = matchMedia("(max-width: 1100px), (max-aspect-ratio: 1/1)");
const STACKED_ROWS = 8;

// ---------- formatting

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const n = v => Math.round(v).toLocaleString("en-US");
// Cents only below $10, where they carry information; whole dollars above.
const usd = v => v < 9.995 ? `$${v.toFixed(2)}` : `$${n(v)}`;
const usdTick = v => v >= 1000 ? `$${+(v / 1000).toFixed(1)}k` : `$${v}`;
// The largest unit whose rounded value stays under 1000 of the next: 999,960 is "1.0M", not "1000.0k".
const UNITS = [[1e9, "B"], [1e6, "M"], [1e3, "k"]];
const compact = v => {
  if (Math.round(v) < 1000) return n(v);
  let i = UNITS.length - 1;
  while (i > 0 && +(v / UNITS[i][0]).toFixed(1) >= 1000) i--;
  return `${(v / UNITS[i][0]).toFixed(1)}${UNITS[i][1]}`;
};
const pct = v => `${Math.round(v * 100)}%`;
const pad = v => String(v).padStart(2, "0");
const counted = (k, word) => `<b>${n(k)}</b> ${k === 1 ? word : `${word}s`}`;
const hhmm = t => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const duration = ms => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
};

// Local calendar days as "YYYY-MM-DD", the keys ccusage groups by.
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDay = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, k) => { const d = parseDay(s); d.setDate(d.getDate() + k); return iso(d); };
const dayLabel = s => parseDay(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const fullDay = s => parseDay(s).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
const weekday = s => (parseDay(s).getDay() + 6) % 7;

// claude-opus-5-5 -> opus-5.5, claude-sonnet-4-5-20250929 -> sonnet-4.5, claude-3-5-haiku-20241022 -> haiku-3.5.
function modelName(id) {
  const s = id.replace(/-(\d{8})$/, "").replace(/^claude-/, "");
  return s.replace(/^(\d+)-(\d+)-([a-z]+)$/, "$3-$1.$2").replace(/^([a-z]+)-(\d+)-(\d+)$/, "$1-$2.$3");
}
const family = id => /opus|sonnet|fable|haiku/.exec(id)?.[0] ?? "other";

// mcp__claude_ai_Linear__save_issue -> linear.save_issue, mcp__claude-in-chrome__computer -> chrome.computer.
function toolName(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1].replace(/^claude_ai_|^claude-in-/, "").toLowerCase()}.${m[2]}` : name;
}

// A project's name from its working directory: the repository for a repo or its worktree, "scratchpad" for session
// scratch directories, else the path under the home directory.
function projectName(dir) {
  // A worktree whose transcripts hold no usable working directory takes its main checkout's name.
  const cwd = DATA.cwds[dir] ?? DATA.cwds[dir.replace(/--claude-worktrees-.*$/, "")];
  if (!cwd) return dir.replace(/^.*-repos-[a-z]+-/, "").replace(/^-Users-[^-]+-/, "").replace(/^Code-/, "");
  if (/^\/(private\/)?tmp\//.test(cwd)) return "scratchpad";
  const path = cwd.replace(/\/\.claude\/worktrees\/[^/]+/, "");
  if (path === DATA.home) return "~";
  const repo = /\/repos\/[^/]+\/([^/]+)/.exec(path);
  return repo ? repo[1] : path.replace(`${DATA.home}/`, "").replace(/^Code\//, "");
}

const add = (o, k, v) => { o[k] = (o[k] ?? 0) + v; };
const sum = vs => vs.reduce((a, v) => a + v, 0);
const sorted = o => Object.entries(o).sort((a, b) => b[1] - a[1]);
const $ = s => document.querySelector(s);

// ---------- data

const days = {};
for (const [date, projects] of Object.entries(DATA?.daily ?? {})) {
  const d = days[date] = { cost: 0, fam: {}, models: {}, projects: {}, projTokens: {}, projModels: {}, tok: { "cache read": 0, "cache write": 0, input: 0, output: 0 } };
  for (const [dir, e] of Object.entries(projects)) {
    d.cost += e.totalCost;
    const name = projectName(dir);
    add(d.projects, name, e.totalCost);
    add(d.projTokens, name, e.totalTokens);
    d.tok["cache read"] += e.cacheReadTokens;
    d.tok["cache write"] += e.cacheCreationTokens;
    d.tok.input += e.inputTokens;
    d.tok.output += e.outputTokens;
    for (const b of e.modelBreakdowns) {
      add(d.models, b.modelName, b.cost);
      add(d.projModels[name] ??= {}, b.modelName, b.cost);
      add(d.fam, family(b.modelName), b.cost);
    }
  }
}
const today = iso(new Date());
const firstDay = [...Object.keys(days), ...Object.keys(DATA?.activity ?? {})].sort()[0] ?? today;

function rangeDates(range) {
  const count = range[1] ?? Math.max(1, Math.round((parseDay(today) - parseDay(firstDay)) / 86_400_000) + 1);
  return Array.from({ length: count }, (_, i) => addDays(today, i - count + 1));
}

// ---------- chart pieces

const rem = () => parseFloat(getComputedStyle(root).fontSize);
const size = host => [host.clientWidth, host.clientHeight];
const svg = (host, W, H, body) => { host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img">${body}</svg>`; };

// Grid values for a 0-based axis: steps of 1, 2 or 5 x 10^k, about 3 steps to the max, and 10% headroom.
function axis(max) {
  const raw = Math.max(max, 1e-9) / 3, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map(m => m * mag).find(s => s >= raw);
  const top = Math.max(max, 1e-9) * 1.1, ticks = [];
  for (let v = 0; v <= top; v += step) ticks.push(+v.toPrecision(12));
  return { top, ticks };
}

// Every bar gets the same 2px top corners; only a bar shorter than that gets less.
const BAR_RADIUS = 2;
const roundTop = (x, y, w, h) => {
  const r = Math.min(BAR_RADIUS, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
};

// Bars with a y axis, the peak bar's value above it and an optional dashed average.
// cols: [{v, now, label, tip}]; a "now" bar (today) is orange, every other bar gray.
function barChart(host, cols, { fmtTick, fmtValue, avg }) {
  const [W, H] = size(host);
  if (!W || !H || !cols.length) return;
  const fs = rem() * .85, cw = fs * .62;
  const max = Math.max(...cols.map(c => c.v));
  const { top, ticks: all } = axis(max);
  const padT = fs * 1.7, padB = fs * 1.9, ph = H - padT - padB;
  // A short plot keeps only the baseline and the top tick, so tick labels never overlap.
  const ticks = ph / all.length < fs * 1.6 ? [all[0], all.at(-1)] : all;
  const axisW = Math.max(...ticks.map(t => fmtTick(t).length)) * cw + fs * .8;
  const band = (W - axisW) / cols.length;
  const gap = band >= 6 ? Math.min(band * .25, rem()) : band >= 3 ? 1 : 0;
  const bw = Math.min(band - gap, rem() * 4);
  const x = i => axisW + i * band + (band - bw) / 2;
  const y = v => padT + ph - v / top * ph;
  let s = "";
  for (const t of ticks) {
    s += `<line x1="${axisW}" x2="${W}" y1="${y(t)}" y2="${y(t)}" stroke="${t ? COLOR.grid : COLOR.baseline}"/>`;
    s += `<text x="${axisW - fs * .8}" y="${y(t)}" font-size="${fs}" text-anchor="end" dominant-baseline="middle">${fmtTick(t)}</text>`;
  }
  cols.forEach((c, i) => {
    const h = c.v / top * ph;
    if (h > 0) s += `<path d="${roundTop(x(i), y(c.v), bw, h)}" fill="${c.now ? COLOR.now : COLOR.bar}"/>`;
  });
  if (avg > 0) {
    s += `<line x1="${axisW}" x2="${W}" y1="${y(avg)}" y2="${y(avg)}" stroke="${COLOR.muted}" stroke-dasharray="4 4"/>`;
    // The label sits at the left end: the right end is today's bar.
    s += `<text x="${axisW + fs * .4}" y="${y(avg) - fs * .4}" font-size="${fs}">avg ${fmtValue(avg)}</text>`;
  }
  const peak = cols.findIndex(c => c.v === max);
  if (max > 0) s += `<text class="value" x="${x(peak) + bw / 2}" y="${y(max) - fs * .5}" font-size="${fs}" text-anchor="middle">${fmtValue(max)}</text>`;
  // Labels from the last column backward, one per step wide enough for the widest label.
  const labelW = Math.max(...cols.map(c => c.label.length)) * cw + fs;
  const step = Math.max(1, Math.ceil(labelW / band));
  for (let i = cols.length - 1; i >= 0; i -= step) {
    const cx = axisW + (i + .5) * band;
    if (cx - labelW / 2 < axisW - fs) break;
    s += `<text x="${cx}" y="${H - fs * .3}" font-size="${fs}" text-anchor="middle">${esc(cols[i].label)}</text>`;
  }
  cols.forEach((c, i) => {
    s += `<rect class="hit" x="${axisW + i * band}" y="${padT}" width="${band}" height="${ph}" data-tip="${esc(c.tip)}"/>`;
  });
  svg(host, W, H, s);
}

// Five steps of the sequential orange; 0 only for no activity at all.
const heatLevel = (v, max) => v <= 0 ? 0 : Math.min(4, 1 + Math.floor(v / max * 4 - 1e-9));
const heatLegend = () => `<span class="legend">less ${HEAT.map(c => `<i style="background:${c}"></i>`).join("")} more</span>`;

// Weekday rows by hour columns, cells stretched to fill the box.
function heatMap(host, grid, tip) {
  const [W, H] = size(host);
  if (!W || !H) return;
  const fs = rem() * .85, labW = fs * 2.8, padB = fs * 1.6;
  const cw = (W - labW) / 24, ch = (H - padB) / 7, g = ch > 10 ? 2 : 1;
  const max = Math.max(...grid.flat());
  // Every nth weekday label, n chosen so labels never overlap.
  const every = Math.ceil(fs * 1.15 / ch);
  const labelled = [0, 1, 2, 3, 4, 5, 6].filter(r => r % every === 0);
  let s = "";
  for (const r of labelled) s += `<text x="0" y="${r * ch + (ch - g) / 2}" font-size="${fs}" dominant-baseline="middle">${WEEKDAYS[r]}</text>`;
  grid.forEach((row, r) => row.forEach((v, h) => {
    s += `<rect class="cell" x="${labW + h * cw}" y="${r * ch}" width="${cw - g}" height="${ch - g}" rx="2" fill="${HEAT[heatLevel(v, max)]}" data-tip="${esc(tip(r, h, v))}"/>`;
  }));
  for (const h of [0, 6, 12, 18]) s += `<text x="${labW + h * cw}" y="${H - fs * .3}" font-size="${fs}">${pad(h)}:00</text>`;
  svg(host, W, H, s);
}

// Name, a bar against the biggest value, the value; rows past the box fold into one "+N more" row.
// Renders with the most rows that fit the box: starts from an estimate and drops rows while the content overflows.
// Stacked layouts size boxes to content, so there the count is fixed.
function fitRows(host, estimate, draw) {
  if (STACKED.matches) return draw(STACKED_ROWS);
  let count = Math.max(2, estimate);
  draw(count);
  while (count > 2 && host.firstElementChild?.scrollHeight > host.clientHeight + 1) draw(--count);
}

// Name, a bar against the biggest value, the value; rows past the box fold into one "+N more" row. With top, exactly
// the first rows that many, no fold.
function meters(host, rows, { total, of, top }) {
  if (!rows.length) { host.innerHTML = `<div class="none">nothing in range</div>`; return; }
  fitRows(host, top ?? Math.ceil(host.clientHeight / (1.7 * rem())), fit => {
    let shown = top ? rows.slice(0, Math.min(top, fit)) : rows;
    if (!top && rows.length > fit) {
      const rest = rows.slice(fit - 1);
      shown = [...rows.slice(0, fit - 1), { name: `+${rest.length} more`, v: sum(rest.map(x => x.v)), fmt: rows[0].fmt, other: true }];
    }
    // The fold row carries no bar: the long tail summed would dwarf the rows it follows.
    const max = Math.max(...shown.filter(x => !x.other).map(x => x.v), 0);
    host.innerHTML = `<div class="meters">${shown.map(x => `
      <div class="meter${x.other ? " other" : ""}" data-tip="${esc(`${x.tipName ?? x.name}\n${x.fmt(x.v)} · ${pct(total ? x.v / total : 0)} of ${of}`)}">
        <span>${x.color ? `<i style="background:${x.color}"></i>` : ""}${x.prefix ?? ""}${esc(x.name)}</span>
        ${x.other ? "<span></span>" : `<div class="track"><div style="width:${max ? x.v / max * 100 : 0}%"></div></div>`}
        <span>${x.fmt(x.v)}</span>
      </div>`).join("")}</div>`;
  });
}

// ---------- cards

function spendCard(el, dates, range) {
  const cost = d => days[d]?.cost ?? 0;
  const total = sum(dates.map(cost));
  const active = dates.filter(d => cost(d) > 0);
  const best = active.reduce((b, d) => cost(d) > cost(b) ? d : b, active[0]);
  // The change compares full days only, today being partial, and only against days the history holds completely.
  const full = dates.slice(0, -1);
  const prevDates = full.map(d => addDays(d, -full.length));
  const historyFrom = DATA.completeFrom > firstDay ? DATA.completeFrom : firstDay;
  const prev = range[1] && full.length && prevDates[0] >= historyFrom ? sum(prevDates.map(cost)) : null;
  const change = prev ? Math.round((sum(full.map(cost)) / prev - 1) * 100) : null;
  const head = change != null
    ? `<b>${change > 0 ? "+" : change < 0 ? "−" : ""}${Math.abs(change)}%</b> vs prior ${full.length === 1 ? "day" : `${full.length} days`}, today excluded`
    : best ? `best day <b>${usd(cost(best))}</b> · ${dayLabel(best)}` : "";
  el.innerHTML = `
    <div class="head"><h2>Spend · ${range[3]}</h2><div>${head}</div></div>
    <div class="body">
      <div class="main">
        <div class="sub"><span class="hero">${usd(total)}</span><span><b>${usd(active.length ? total / active.length : 0)}</b> per active day</span></div>
        <div class="fill chart"></div>
      </div>
    </div>`;
  const chart = el.querySelector(".chart");
  if (!total) {
    chart.innerHTML = `<div class="none">no spend in range</div>`;
  } else {
    barChart(chart, dates.map(date => ({
      v: cost(date),
      now: date === today,
      label: date === today ? "today" : dayLabel(date),
      tip: [`${fullDay(date)}`, `${usd(cost(date))}`, ...FAMILIES.filter(f => days[date]?.fam[f] > 0).map(f => `${f} · ${usd(days[date].fam[f])}`)].join("\n"),
    })), { fmtTick: usdTick, fmtValue: usd, avg: active.length > 1 ? total / active.length : 0 });
  }
}

// Plan usage from serve.mjs, refreshed every minute; a file:// page has no server to ask.
let plan = { state: "loading" };
async function loadPlan() {
  if (location.protocol === "file:") plan = { state: "file" };
  else {
    try {
      const res = await fetch("/api/limits", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      plan = { state: "ok", data };
    } catch (e) {
      // A failed poll keeps the last answer, marked stale; only without one does the card show the error.
      plan = plan.data ? { ...plan, failed: true } : { state: "error", message: e.message };
    }
  }
  planCard($("#plan"));
}

function resetLabel(t) {
  const d = new Date(t);
  return t - Date.now() < 86_400_000 ? hhmm(d) : `${d.toLocaleDateString("en-US", { weekday: "short" })} ${hhmm(d)}`;
}

const WINDOW_TITLES = { "5h": "5-Hour Window", week: "Weekly Window" };

function planCard(el) {
  const data = plan.data;
  const stale = data && (plan.failed || Date.now() - data.updatedAt > LIMIT_STALE_MS);
  const head = data ? `<b>${esc(data.plan)}</b> plan${stale ? ` · <span class="stale">as of ${hhmm(data.updatedAt)}</span>` : ""}` : "";
  const body = {
    loading: `<div class="none">loading…</div>`,
    file: `<div class="none">Run <code>just</code> to see plan usage</div>`,
    error: `<div class="none">Couldn't load plan usage: ${esc(plan.message ?? "")}</div>`,
  }[plan.state] ?? `<div class="windows">${data.windows.map(w => {
    const used = Number(w.percent) || 0;
    const pace = w.seconds > 0 ? Math.min(1, Math.max(0, 1 - (w.resetsAt - Date.now()) / (w.seconds * 1000))) : 0;
    const over = used > pace * 100 + PACE_MARGIN;
    return `<div class="window${over ? " over" : ""}" data-tip="${esc(`${used}% used\n${pct(pace)} of the window elapsed\nresets ${resetLabel(w.resetsAt)}`)}">
      <div class="title"><span class="figure">${used}%</span><h3>${esc(WINDOW_TITLES[w.label] ?? w.label)}</h3></div>
      <span class="state">${over ? "ahead of pace" : "on pace"}</span>
      <div class="gauge"><div class="used" style="width:${Math.min(100, used)}%"></div><i class="pace" style="left:${pace * 100}%"></i></div>
      <div class="meta">resets ${resetLabel(w.resetsAt)} · ${pct(pace)} elapsed</div>
    </div>`;
  }).join("")}</div>`;
  el.innerHTML = `<div class="head"><h2>Plan Usage</h2><div>${head}</div></div>${body}`;
}

function toolsCard(el, dates, range) {
  const grid = WEEKDAYS.map(() => Array(24).fill(0));
  const tools = {}, commands = {};
  let prompts = 0;
  for (const d of dates) {
    const a = DATA.activity[d];
    if (!a) continue;
    prompts += a.prompts;
    (a.toolHours ?? []).forEach((v, h) => { grid[weekday(d)][h] += v; });
    for (const [t, v] of Object.entries(a.tools)) add(tools, t, v);
    for (const [c, v] of Object.entries(a.commands ?? {})) add(commands, c, v);
  }
  const total = sum(Object.values(tools));
  // Bash is most of the calls, so it is shown by the program each command ran, ranked with the other tools.
  const rows = [
    ...Object.entries(tools).filter(([t]) => t !== "Bash").map(([t, v]) => ({ name: toolName(t), v, fmt: compact })),
    ...Object.entries(commands).map(([c, v]) => ({ name: c, tipName: `$ ${c} (Bash)`, prefix: `<span class="shell">$ </span>`, v, fmt: compact })),
  ].sort((a, b) => b.v - a.v);
  el.innerHTML = `
    <div class="head"><h2>Tool Calls · ${range[3]}</h2></div>
    <div class="sub"><span class="figure">${compact(total)}</span><span>calls · ${counted(prompts, "prompt")} · <b>${prompts ? (total / prompts).toFixed(1) : "–"}</b> per prompt</span></div>
    <div class="body">
      <div class="map"><div class="head"><h3>By Weekday and Hour</h3>${heatLegend()}</div><div class="fill chart"></div></div>
      <div class="mix"><h3>Top Commands and Tools</h3><div class="fill list"></div></div>
    </div>`;
  const map = el.querySelector(".chart");
  if (total) heatMap(map, grid, (r, h, v) => `${WEEKDAYS[r]} ${pad(h)}:00–${pad((h + 1) % 24)}:00\n${n(v)} tool calls`);
  else map.innerHTML = `<div class="none">no tool calls in range</div>`;
  meters(el.querySelector(".list"), rows, { total, of: "tool calls" });
}

// Per project over the range: spend, tokens and models from ccusage's days; sessions, active time and last activity
// from the sessions whose last activity falls in the range.
function projectsCard(el, dates, range) {
  const projects = {};
  const project = name => (projects[name] ??= { name, cost: 0, tokens: 0, models: {}, sessions: 0, active: 0, last: 0 });
  for (const d of dates) {
    for (const [name, v] of Object.entries(days[d]?.projects ?? {})) project(name).cost += v;
    for (const [name, v] of Object.entries(days[d]?.projTokens ?? {})) project(name).tokens += v;
    for (const [name, models] of Object.entries(days[d]?.projModels ?? {})) for (const [m, v] of Object.entries(models)) add(project(name).models, m, v);
  }
  for (const s of DATA.sessions) {
    if (iso(new Date(s.last)) < dates[0]) continue;
    const p = project(projectName(s.project));
    p.sessions++;
    p.active += s.active ?? Date.parse(s.last) - Date.parse(s.first);
    p.last = Math.max(p.last, Date.parse(s.last));
  }
  const list = Object.values(projects).filter(p => p.cost > 0).sort((a, b) => b.cost - a.cost);
  const total = sum(list.map(p => p.cost));
  el.innerHTML = `
    <div class="head"><h2>Top Projects · ${range[3]}</h2><div>${counted(list.length, "project")}</div></div>
    <div class="fill list"></div>`;
  const host = el.querySelector(".list");
  if (!list.length) { host.innerHTML = `<div class="none">no projects in range</div>`; return; }
  fitRows(host, Math.ceil(host.clientHeight / (2 * rem())), rows => { host.innerHTML = `<table>
    <thead><tr><th class="c-proj">Project</th><th class="c-n num">Sessions</th><th class="c-dur num">Active</th><th class="c-last">Last Active</th><th class="c-model">Model</th><th class="c-tok num">Tokens</th><th class="c-cost num">Cost</th></tr></thead>
    <tbody>${list.slice(0, rows).map(p => {
      const models = sorted(p.models).map(([m]) => m);
      const last = p.last ? `${dayLabel(iso(new Date(p.last)))} ${hhmm(p.last)}` : "–";
      return `<tr data-tip="${esc(`${p.name}\n${usd(p.cost)} · ${pct(total ? p.cost / total : 0)} of spend\n${models.map(m => `${modelName(m)} · ${usd(p.models[m])}`).join("\n")}`)}">
        <td class="c-proj">${esc(p.name)}</td>
        <td class="c-n num dim">${n(p.sessions)}</td>
        <td class="c-dur num dim">${duration(p.active)}</td>
        <td class="c-last dim">${last}</td>
        <td class="c-model"><i style="background:${COLOR[family(models[0] ?? "")]}"></i>${esc(modelName(models[0] ?? "–"))}${models.length > 1 ? `<span class="dim"> +${models.length - 1}</span>` : ""}</td>
        <td class="c-tok num dim">${compact(p.tokens)}</td>
        <td class="c-cost num">${usd(p.cost)}</td></tr>`;
    }).join("")}</tbody></table>`; });
}

const MODEL_ROWS = 3;
function modelsCard(el, dates, range) {
  const by = {};
  const tok = { "cache read": 0, "cache write": 0, input: 0, output: 0 };
  for (const d of dates) {
    for (const [m, v] of Object.entries(days[d]?.models ?? {})) add(by, m, v);
    for (const k in tok) tok[k] += days[d]?.tok[k] ?? 0;
  }
  const total = sum(Object.values(by));
  const read = tok["cache read"] + tok["cache write"] + tok.input;
  el.innerHTML = `
    <div class="head"><h2>Models &amp; Tokens · ${range[3]}</h2><div>${counted(Object.keys(by).length, "model")}</div></div>
    <div class="sub"><span class="hero">${compact(sum(Object.values(tok)))}</span><span>tokens</span></div>
    <div class="stats">
      <div class="stat" data-tip="Share of input tokens read from the prompt cache"><b>${pct(read ? tok["cache read"] / read : 0)}</b><span>cache hit</span></div>
      <div class="stat" data-tip="Input tokens read from the prompt cache"><b>${compact(tok["cache read"])}</b><span>cache reads</span></div>
      <div class="stat" data-tip="Input tokens written to the prompt cache"><b>${compact(tok["cache write"])}</b><span>cache writes</span></div>
      <div class="stat" data-tip="Input tokens neither read from nor written to the cache"><b>${compact(tok.input)}</b><span>uncached</span></div>
      <div class="stat"><b>${compact(tok.output)}</b><span>output</span></div>
    </div>
    <h3>Top Models by Spend</h3>
    <div class="fill list"></div>`;
  meters(el.querySelector(".list"), sorted(by).map(([m, v]) => ({ name: modelName(m), v, fmt: usd, color: COLOR[family(m)] })), { total, of: "spend", top: MODEL_ROWS });
}

// Up to a year of weeks, Monday on top, today at the right edge, filling in as the history grows. Days before the
// first data are outlines. Cells stretch up to 2.5 times their height to fill the width; a wider card ends the year
// short of the left edge.
const CALENDAR_WEEKS = 53;
const CALENDAR_ASPECT = 2.5;
function calendarCard(el) {
  const costs = Object.values(days).map(d => d.cost).filter(v => v > 0).sort((a, b) => a - b);
  const quantile = q => costs[Math.floor(q * (costs.length - 1))] ?? 0;
  const thresholds = [.25, .5, .75].map(quantile);
  const level = v => v <= 0 ? 0 : 1 + thresholds.filter(t => v > t).length;
  el.innerHTML = `
    <div class="head"><h2>Spend Calendar</h2><div class="legend">${counted(costs.length, "active day")} since ${dayLabel(firstDay)}<span style="width:1rem"></span>${heatLegend()}</div></div>
    <div class="fill chart"></div>`;
  const host = el.querySelector(".chart");
  const [W, H] = size(host);
  if (!W || !H) return;
  const fs = rem() * .85, labW = fs * 2.8, padT = fs * 1.6, g = 3;
  const ch = (H - padT) / 7;
  const avail = W - labW;
  const weeks = Math.min(CALENDAR_WEEKS, Math.max(8, Math.floor(avail / Math.max(ch * .9, 8))));
  const cw = Math.min(avail / weeks, ch * CALENDAR_ASPECT);
  const left = W - weeks * cw;
  const end = addDays(today, 6 - weekday(today));
  const start = addDays(end, -weeks * 7 + 1);
  let s = "", lastLabel = -9, lastMonth = "";
  for (const r of [0, 2, 4]) s += `<text x="${left - labW}" y="${padT + r * ch + (ch - g) / 2}" font-size="${fs}" dominant-baseline="middle">${WEEKDAYS[r]}</text>`;
  for (let w = 0; w < weeks; w++) {
    const x = left + w * cw, monday = addDays(start, w * 7);
    const month = parseDay(monday).toLocaleDateString("en-US", { month: "short" });
    if (month !== lastMonth) {
      if (w - lastLabel >= 3 && w < weeks - 2) { s += `<text x="${x}" y="${fs}" font-size="${fs}">${month}</text>`; lastLabel = w; }
      lastMonth = month;
    }
    for (let r = 0; r < 7; r++) {
      const d = addDays(monday, r);
      if (d > today) continue;
      const y = padT + r * ch;
      if (d < firstDay) {
        s += `<rect x="${x + .5}" y="${y + .5}" width="${cw - g - 1}" height="${ch - g - 1}" rx="2" fill="none" stroke="${COLOR.grid}"/>`;
        continue;
      }
      const v = days[d]?.cost ?? 0;
      s += `<rect class="cell" x="${x}" y="${y}" width="${cw - g}" height="${ch - g}" rx="2" fill="${HEAT[level(v)]}"${d === today ? ` stroke="${COLOR.fg}"` : ""} data-tip="${esc(`${fullDay(d)}\n${usd(v)}`)}"/>`;
    }
  }
  svg(host, W, H, s);
}

// ---------- header

// Claude Code's spinner glyphs, played forward and back as in the CLI.
const SPARKS = ["·", "✢", "✳", "✶", "✻", "✽"];
const SPARK_MS = 120;
function brand() {
  $("#brand").innerHTML = `<span class="spark" aria-hidden="true">${SPARKS[0]}</span><span class="name">Claude Code</span><span class="unit">usage</span>`;
  const spark = $("#brand .spark"), frames = [...SPARKS, ...SPARKS.slice(1, -1).reverse()];
  let frame = 0;
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    setInterval(() => { spark.textContent = frames[++frame % frames.length]; }, SPARK_MS);
  }
}

function counts() {
  const all = Object.keys(days).sort();
  const todayCost = days[today]?.cost ?? 0;
  const month = sum(all.filter(d => d.startsWith(today.slice(0, 7))).map(d => days[d].cost));
  let streak = 0;
  for (let d = todayCost > 0 ? today : addDays(today, -1); days[d]?.cost > 0; d = addDays(d, -1)) streak++;
  const best = all.reduce((b, d) => days[d].cost > (days[b]?.cost ?? 0) ? d : b, all[0]);
  const age = Date.now() - Date.parse(DATA.generatedAt);
  const updated = new Date(DATA.generatedAt);
  $("#counts").innerHTML = `
    <div>today <b>${usd(todayCost)}</b></div>
    ${month !== todayCost ? `<div>this month <b>${usd(month)}</b></div>` : ""}
    <div>all time <b>${usd(sum(all.map(d => days[d].cost)))}</b></div>
    ${best ? `<div>best day <b>${usd(days[best].cost)}</b> · ${dayLabel(best)}</div>` : ""}
    <div>streak <b>${n(streak)}</b> ${streak === 1 ? "day" : "days"}</div>
    <div class="${age > STALE_MS ? "stale" : ""}">updated ${age > STALE_MS ? `${dayLabel(iso(updated))} ` : ""}${hhmm(updated)}</div>
    <div class="clock">${hhmm(Date.now())}</div>`;
}

let range = RANGES.find(r => r[0] === "30d");
try { range = RANGES.find(r => r[0] === localStorage.getItem(RANGE_KEY)) ?? range; } catch { /* storage blocked: default range */ }

function buildRanges() {
  const el = $("#ranges");
  el.innerHTML = RANGES.map(r => `<button type="button" data-range="${r[0]}" aria-pressed="${r === range}">${r[2]}</button>`).join("");
  el.addEventListener("click", e => {
    const next = RANGES.find(r => r[0] === e.target.closest("button")?.dataset.range);
    if (!next || next === range) return;
    range = next;
    try { localStorage.setItem(RANGE_KEY, next[0]); } catch { /* storage blocked: range lasts for this page view */ }
    for (const b of el.children) b.setAttribute("aria-pressed", b.dataset.range === range[0]);
    render();
  });
}

function render() {
  tip.hidden = true;
  const dates = rangeDates(range);
  counts();
  spendCard($("#spend"), dates, range);
  toolsCard($("#tools"), dates, range);
  modelsCard($("#models"), dates, range);
  calendarCard($("#cal"));
  projectsCard($("#proj"), dates, range);
}

// ---------- tooltip

const tip = $("#tip");
function showTip(e) {
  const t = e.target.closest?.("[data-tip]");
  if (!t) { tip.hidden = true; return; }
  tip.textContent = t.dataset.tip;
  tip.hidden = false;
  const { width, height } = tip.getBoundingClientRect();
  const x = e.clientX + 16 + width > innerWidth ? e.clientX - 16 - width : e.clientX + 16;
  const y = e.clientY + 16 + height > innerHeight ? e.clientY - 16 - height : e.clientY + 16;
  tip.style.left = `${Math.max(4, x)}px`;
  tip.style.top = `${Math.max(4, y)}px`;
}
// Touch shows the tip on tap; a tap elsewhere or a scroll hides it.
document.addEventListener("pointermove", e => { if (e.pointerType !== "touch") showTip(e); });
document.addEventListener("pointerdown", showTip);
document.addEventListener("scroll", () => { tip.hidden = true; }, { passive: true });
root.addEventListener("mouseleave", () => { tip.hidden = true; });

// ---------- start

brand();
if (!DATA) {
  $("#ranges").hidden = true;
  $("#main").outerHTML = `<div class="empty">No data yet<br>Run <code>just collect</code>, then reload</div>`;
} else {
  buildRanges();
  render();
  planCard($("#plan"));
  loadPlan();
  let frame;
  const later = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(render); };
  // Cards change size when the window does, when plan usage arrives and when the fonts load; contents follow.
  const observer = new ResizeObserver(later);
  for (const card of document.querySelectorAll(".card")) observer.observe(card);
  document.fonts.ready.then(later);
  STACKED.addEventListener("change", later);
  // The page's days are fixed at load; a new day needs fresh data, so the page reloads.
  setInterval(() => (iso(new Date()) === today ? counts() : location.reload()), 30_000);
  setInterval(loadPlan, 60_000);
  // serve.mjs collects every few minutes; newer data reloads the page, which keeps the range.
  if (location.protocol !== "file:") setInterval(async () => {
    try {
      const { generatedAt } = await (await fetch("/api/data", { cache: "no-store" })).json();
      if (generatedAt && generatedAt !== DATA.generatedAt) location.reload();
    } catch { /* server stopped: keep the page as it is */ }
  }, 60_000);
}
