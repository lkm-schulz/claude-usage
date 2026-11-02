// Collects Claude Code usage into data/ and regenerates data/dashboard.js for index.html.
//
// Claude Code deletes transcripts after `cleanupPeriodDays`, and ccusage reads only the transcripts that remain. Each
// run therefore merges the fresh reports into the stored history: a day, session or block keeps the larger of the stored
// and the fresh record (by tokens), so a record shrunk or removed by the cleanup never overwrites the full one.
import { execFile } from "node:child_process";
import { createReadStream, rmSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, "data");
const CCUSAGE = join(ROOT, "node_modules", ".bin", "ccusage");
const PROJECTS = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
const DAY_MS = 86_400_000;
// A transcript holds messages up to its mtime only, so the files modified since this many days before the last run
// hold every message of those days: the activity scan reads only them, except on the first run.
const RESCAN_DAYS = 2;
// A pause longer than this between two records of a session is idle time, not working time.
const IDLE_MS = 30 * 60_000;

const run = promisify(execFile);

// ccusage fetches model prices online; without a network (a run at login, say) it uses the prices it ships with.
async function ccusage(...args) {
  const call = async extra => JSON.parse((await run(CCUSAGE, ["claude", ...args, "--json", ...extra], { maxBuffer: 1 << 30 })).stdout);
  try {
    return await call([]);
  } catch (e) {
    console.error(`ccusage ${args[0]} failed online, retrying offline: ${e.message.split("\n")[0]}`);
    return call(["--offline"]);
  }
}

// One run at a time: the daily job and a manual run would otherwise interleave their writes. A lock whose process
// has exited is stale and taken over.
const LOCK = join(DATA, ".lock");
async function lock() {
  try {
    await writeFile(LOCK, String(process.pid), { flag: "wx" });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const pid = Number(await readFile(LOCK, "utf8"));
    if (alive(pid)) {
      console.error(`Couldn't collect: another collection runs (pid ${pid})`);
      process.exit(1);
    }
    await writeFile(LOCK, String(process.pid));
  }
  process.on("exit", () => { try { rmSync(LOCK); } catch { /* already gone */ } });
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

async function load(name, fallback) {
  try {
    return JSON.parse(await readFile(join(DATA, name), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}

// Writes through a temporary file, so an interrupted run never leaves a truncated history.
async function save(name, value, text = JSON.stringify(value)) {
  const path = join(DATA, name);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

const tokens = r => r?.totalTokens ?? 0;
const sum = vs => vs.reduce((a, v) => a + v, 0);

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

// One page row per session: the rows of all its project directories summed, the project of its costliest row.
function mergeSessions(rows, active) {
  const by = {};
  for (const s of rows) (by[s.sessionId] ??= []).push(s);
  return Object.entries(by).map(([id, parts]) => {
    const main = parts.reduce((a, b) => (b.totalCost > a.totalCost ? b : a));
    return {
      id, project: main.projectPath,
      first: parts.map(p => p.firstActivity).sort()[0], last: parts.map(p => p.lastActivity).sort().at(-1),
      active: active[id] ?? null,
      cost: sum(parts.map(p => p.totalCost)), tokens: sum(parts.map(p => p.totalTokens)),
      models: [...new Set(parts.flatMap(p => p.modelsUsed))],
    };
  });
}

function keepMax(stored, fresh, size) {
  for (const [key, record] of Object.entries(fresh)) {
    if (size(record) >= size(stored[key])) stored[key] = record;
  }
  return stored;
}

// Claude Code names a project's transcript directory after the session's starting directory, every character other
// than a letter or digit replaced by "-".
const encodeDir = cwd => cwd.replace(/[^a-zA-Z0-9]/g, "-");

const localDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function* transcripts(dir, since) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* transcripts(path, since);
    else if (entry.name.endsWith(".jsonl") && (await stat(path)).mtimeMs >= since) yield path;
  }
}

// Per local day: assistant messages by hour, tool calls by hour and by tool name, shell commands by program, and
// prompts typed by the user. Per session: active time. Also each project directory's working directory, which the
// directory name encodes lossily. A session can change directory, so only a working directory whose encoding is the
// directory name counts.
async function scanActivity(since) {
  const days = {};
  const cwds = {};
  const active = {};
  const seenMessages = new Set();
  const seenTools = new Set();
  const seenPrompts = new Set();
  const day = date => (days[date] ??= { hours: Array(24).fill(0), toolHours: Array(24).fill(0), tools: {}, commands: {}, prompts: 0, messages: 0 });
  const projects = await readdir(PROJECTS).catch(e => { if (e.code === "ENOENT") return []; throw e; });
  for (const project of projects) {
    for await (const file of transcripts(join(PROJECTS, project), since)) {
      // Subagents run in parallel with their session, so only the main transcript adds to the session's active time.
      const main = !file.includes("/subagents/");
      let previous = null;
      for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
        const isAssistant = line.includes('"type":"assistant"');
        if (!isAssistant && !line.includes('"type":"user"')) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (record.cwd && !cwds[project] && encodeDir(record.cwd) === project) cwds[project] = record.cwd;
        const at = new Date(record.timestamp);
        if (Number.isNaN(at.getTime())) continue;
        const d = day(localDate(at));
        const message = record.message;
        if (main && record.sessionId) {
          const gap = previous ? at - previous : 0;
          if (gap > 0 && gap < IDLE_MS) active[record.sessionId] = (active[record.sessionId] ?? 0) + gap;
          previous = at;
        }
        if (record.type === "assistant" && message?.usage) {
          const id = `${message.id}:${record.requestId}`;
          if (!seenMessages.has(id)) {
            seenMessages.add(id);
            d.hours[at.getHours()]++;
            d.messages++;
          }
          for (const block of Array.isArray(message.content) ? message.content : []) {
            if (block.type !== "tool_use" || seenTools.has(block.id)) continue;
            seenTools.add(block.id);
            d.tools[block.name] = (d.tools[block.name] ?? 0) + 1;
            d.toolHours[at.getHours()]++;
            if (block.name === "Bash") add(d.commands, shellCommand(block.input?.command));
          }
        } else if (record.type === "user" && isPrompt(record) && !(record.uuid && seenPrompts.has(record.uuid))) {
          // A resumed session copies earlier prompts into its new transcript under the same uuid.
          if (record.uuid) seenPrompts.add(record.uuid);
          d.prompts++;
        }
      }
    }
  }
  return { days, cwds, active };
}

const add = (o, k) => { o[k] = (o[k] ?? 0) + 1; };

// The program a shell command runs: "cd repo && FOO=1 timeout 60 ./node_modules/.bin/vitest run" -> "vitest".
// Skipped in front: directory changes, variable assignments, grouping and wrappers that run another program.
const SHELL_PREFIX = new RegExp([
  /cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|\|\||;|\n)\s*/,
  /[A-Za-z_]\w*=("[^"]*"|'[^']*'|\$\([^)]*\)|\S*)\s+/,
  /(sudo|time|nohup|exec|env)\s+/,
  /timeout\s+\S+\s+/,
  /[({!]\s*/,
].map(r => `(${r.source})`).join("|").replace(/^/, "^(?:").concat(")"));
function shellCommand(command) {
  let s = String(command ?? "").trim();
  for (let prefix; (prefix = SHELL_PREFIX.exec(s)) && prefix[0];) s = s.slice(prefix[0].length);
  const program = (/^\S+/.exec(s)?.[0] ?? "").replace(/["']/g, "").split("/").pop().replace(/[;|&)]+$/, "");
  return SHELL_KEYWORDS.has(program) ? "shell script" : program || "other";
}
const SHELL_KEYWORDS = new Set(["for", "while", "until", "if", "case", "set", "export", "source", ".", "function", "[", "[["]);

// Claude Code marks a typed prompt with origin.kind "human". Older transcripts lack origin: there, a prompt is a string
// that is not a tag (tool results are arrays; injected command output starts with a tag) and not a compaction summary.
function isPrompt(record) {
  if (record.isSidechain || record.isMeta || record.isCompactSummary) return false;
  if (record.origin) return record.origin.kind === "human";
  const content = record.message?.content;
  return typeof content === "string" && !content.startsWith("<");
}

async function main() {
  await mkdir(join(DATA, "snapshots"), { recursive: true });
  await lock();
  const meta = await load("meta.json", {});
  const startedAt = new Date();

  const [daily, session, blocks] = await Promise.all([
    ccusage("daily", "--breakdown", "--instances"),
    ccusage("session"),
    ccusage("blocks"),
  ]);
  await writeFile(join(DATA, "snapshots", `${localDate(startedAt)}.json.gz`),
    gzipSync(JSON.stringify({ collectedAt: startedAt.toISOString(), daily, session, blocks })));

  // daily.json: {date: {project: day entry}}
  const freshDays = {};
  for (const [project, entries] of Object.entries(daily.projects ?? {})) {
    for (const e of entries) (freshDays[e.date] ??= {})[project] = e;
  }
  // Keep-max over the whole day, not per project: ccusage attributes a message that two transcripts share to whichever
  // it reads first, and per-project maxima would count such a message under both projects.
  const storedDays = await load("daily.json", {});
  const dayTokens = projects => sum(Object.values(projects ?? {}).map(tokens));
  for (const [date, projects] of Object.entries(freshDays)) {
    if (dayTokens(projects) >= dayTokens(storedDays[date])) storedDays[date] = projects;
  }

  // A subagent working in a worktree writes under the worktree's project directory with its parent's session ID, so
  // ccusage reports one row per project and session; the rows are kept apart here and summed for the page.
  const rowKey = s => `${s.projectPath}/${s.sessionId}`;
  const storedSessions = Object.fromEntries(Object.values(await load("sessions.json", {})).map(s => [rowKey(s), s]));
  const sessions = keepMax(storedSessions, Object.fromEntries(session.sessions.map(s => [rowKey(s), s])), tokens);
  const storedBlocks = keepMax(await load("blocks.json", {}),
    Object.fromEntries(blocks.blocks.filter(b => !b.isGap).map(b => [b.id, b])), tokens);
  // Only the fresh report's active block is active; one stored as active at the last run has ended since.
  const activeIds = new Set(blocks.blocks.filter(b => b.isActive).map(b => b.id));
  for (const [id, b] of Object.entries(storedBlocks)) if (!activeIds.has(id)) b.isActive = false;

  const since = meta.lastRun ? Date.parse(meta.lastRun) - RESCAN_DAYS * DAY_MS : 0;
  const scan = await scanActivity(since);
  const activity = await load("activity.json", {});
  const cutoff = localDate(new Date(since));
  for (const [date, d] of Object.entries(scan.days)) {
    // A day before the cutoff has messages in files the scan skipped, so its scan counts are partial.
    if ((date >= cutoff || !activity[date]) && d.messages >= (activity[date]?.messages ?? 0)) activity[date] = d;
  }
  const active = await load("active.json", {});
  for (const [id, ms] of Object.entries(scan.active)) if (ms >= (active[id] ?? 0)) active[id] = ms;
  const stored = Object.entries(await load("projects.json", {})).filter(([dir, cwd]) => encodeDir(cwd) === dir);
  const cwds = { ...scan.cwds, ...Object.fromEntries(stored) };

  await save("daily.json", storedDays);
  await save("sessions.json", sessions);
  await save("blocks.json", storedBlocks);
  await save("activity.json", activity);
  await save("projects.json", cwds);
  await save("active.json", active);

  // The days since the first run minus Claude Code's transcript retention at that time are complete; earlier days may
  // have lost transcripts before collection started. Fixed at the first run: a later, longer retention brings nothing back.
  const firstRun = meta.firstRun ?? startedAt.toISOString();
  const retention = (await readJson(join(PROJECTS, "..", "settings.json")))?.cleanupPeriodDays ?? 30;
  const completeFrom = meta.completeFrom ?? localDate(new Date(Date.parse(firstRun) - retention * DAY_MS));

  const dashboard = {
    generatedAt: new Date().toISOString(),
    home: homedir(),
    daily: storedDays,
    activity,
    cwds,
    completeFrom,
    sessions: mergeSessions(Object.values(sessions), active),
  };
  await save("dashboard.js", null, `window.USAGE = ${JSON.stringify(dashboard)};\n`);
  await save("meta.json", { firstRun, completeFrom, lastRun: startedAt.toISOString() });

  const days = Object.keys(storedDays).sort();
  console.log(`collected ${days.length} days (${days[0]} to ${days.at(-1)}), ${dashboard.sessions.length} sessions, `
    + `${Object.keys(storedBlocks).length} blocks in ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
}

await main();
