// Serves the dashboard on localhost, plus /api/limits: the Claude plan usage windows (5-hour, week), which Anthropic's
// usage endpoint reports for the Claude Code login that Claude Code keeps in the macOS Keychain.
// Starts on PORT (default 4317). When this dashboard already runs there, it opens that one and exits; when another
// program holds the port, it takes the next free one. Either way it prints the URL and opens it in the browser.
// While it runs, it collects every COLLECT_MS; the page polls /api/data and reloads when the data is newer.
import { execFile } from "node:child_process";
import { open, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4317);
const PORT_TRIES = 20;
const COLLECT_MS = 10 * 60_000;
const DASHBOARD = join(ROOT, "data", "dashboard.js");
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const LIMITS_MS = 3 * 60_000;
const TYPES = { html: "text/html", js: "text/javascript", css: "text/css", woff2: "font/woff2", json: "application/json" };
// Only these paths are served; everything else in the project (node_modules, data/*.json) stays private.
const FILES = new Set([
  "/index.html", "/app.js", "/style.css", "/data/dashboard.js",
  "/fonts/space-grotesk-latin-wght-normal.woff2", "/fonts/jetbrains-mono-latin-wght-normal.woff2",
]);

const run = promisify(execFile);

function send(res, status, type, body) {
  res.writeHead(status, { "content-type": `${TYPES[type]}; charset=utf-8`, "cache-control": "no-store" });
  res.end(body);
}

// The access token stays in this process: it is never logged, written to disk or put in an error message.
async function claudeLogin() {
  let raw;
  try {
    raw = (await run("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])).stdout;
  } catch (e) {
    // security exits with 44 when the Keychain holds no such item.
    throw new Error(e.code === 44 ? "Claude Code is not logged in" : "the Keychain refused access to the Claude Code login");
  }
  const login = JSON.parse(raw).claudeAiOauth;
  if (!login?.accessToken) throw new Error("the Claude Code login in the Keychain holds no access token");
  // Claude Code refreshes the token while it runs. Refreshing it here would rotate the refresh token Claude Code holds.
  if (login.expiresAt < Date.now()) throw new Error("the Claude Code login has expired; start Claude Code to renew it");
  return login;
}

async function fetchLimits() {
  const login = await claudeLogin();
  const res = await fetch(USAGE_URL, {
    headers: { authorization: `Bearer ${login.accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401) throw new Error("Anthropic rejected the Claude Code login; start Claude Code to renew it");
  if (res.status === 429) throw new Error("Anthropic is rate-limiting usage requests");
  if (!res.ok) throw new Error(`Anthropic answered ${res.status}`);
  const usage = await res.json();
  const window = (label, w, seconds) => w && { label, percent: w.utilization, resetsAt: w.resets_at ? Date.parse(w.resets_at) : null, seconds };
  return {
    updatedAt: Date.now(),
    plan: login.subscriptionType,
    windows: [window("5h", usage.five_hour, 5 * 3600), window("week", usage.seven_day, 7 * 86400)].filter(Boolean),
  };
}

// Every open page polls every minute; one shared answer per LIMITS_MS keeps requests to Anthropic few, failures included.
let limitsCache = { at: 0, promise: null };
function limits() {
  if (Date.now() - limitsCache.at >= LIMITS_MS) limitsCache = { at: Date.now(), promise: fetchLimits() };
  return limitsCache.promise;
}

// A page on another site that rebinds its domain to 127.0.0.1 reaches this server with its own Host header; only
// requests addressed to this server by name get answers.
const ownHost = (host, port) => host === `127.0.0.1:${port}` || host === `localhost:${port}`;

const server = createServer(async (req, res) => {
  if (!ownHost(req.headers.host, server.address().port)) return send(res, 403, "json", JSON.stringify({ error: "forbidden" }));
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "json", JSON.stringify({ error: "method not allowed" }));
  const path = req.url.split("?")[0];
  try {
    if (path === "/api/limits") return send(res, 200, "json", JSON.stringify(await limits()));
    if (path === "/api/data") return send(res, 200, "json", JSON.stringify({ generatedAt: await generatedAt() }));
    if (path === "/api/app") return send(res, 200, "json", JSON.stringify({ app: "claude-usage", root: ROOT }));
    const file = path === "/" ? "/index.html" : path;
    if (!FILES.has(file)) return send(res, 404, "json", JSON.stringify({ error: "not found" }));
    send(res, 200, file.split(".").pop(), await readFile(join(ROOT, file)));
  } catch (e) {
    const reason = path !== "/api/limits" ? "server error"
      : e instanceof SyntaxError ? "Anthropic or the Keychain returned malformed JSON"
      : e.name === "TimeoutError" ? "Anthropic did not answer in time" : e.message;
    send(res, 503, "json", JSON.stringify({ error: reason }));
  }
});

// collect.mjs writes generatedAt as the first key, so the head of the file holds it.
async function generatedAt() {
  const file = await open(DASHBOARD);
  try {
    const { buffer, bytesRead } = await file.read({ buffer: Buffer.alloc(128) });
    return /"generatedAt":"([^"]+)"/.exec(buffer.toString("utf8", 0, bytesRead))?.[1] ?? null;
  } finally {
    await file.close();
  }
}

// collect.mjs refuses to start while another collection (the daily job) runs, so runs never overlap.
let collecting = false;
function collect() {
  if (collecting) return;
  collecting = true;
  execFile(process.execPath, [join(ROOT, "collect.mjs")], { cwd: ROOT }, (e, stdout, stderr) => {
    collecting = false;
    console.log(e ? (stderr.trim().split("\n")[0] || `Couldn't collect: ${e.message}`) : stdout.trim());
  });
}

async function startCollecting() {
  const age = await stat(DASHBOARD).then(s => Date.now() - s.mtimeMs, () => Infinity);
  if (age >= COLLECT_MS) collect();
  setInterval(collect, COLLECT_MS).unref();
}

const url = port => `http://127.0.0.1:${port}`;

function announce(port, note) {
  console.log(`${note}: ${url(port)}`);
  execFile("open", [url(port)], () => {});
}

// Whether the program on a port is this dashboard, served from this folder.
async function isThisDashboard(port) {
  try {
    const res = await fetch(`${url(port)}/api/app`, { signal: AbortSignal.timeout(1000) });
    const body = await res.json();
    return body.app === "claude-usage" && body.root === ROOT;
  } catch {
    return false;
  }
}

server.on("listening", () => {
  announce(server.address().port, "dashboard on");
  startCollecting();
});
server.on("error", async e => {
  const port = Number(e.port);
  if (e.code !== "EADDRINUSE") throw e;
  if (await isThisDashboard(port)) return announce(port, "dashboard already running");
  if (port - PORT + 1 >= PORT_TRIES) throw new Error(`no free port in ${PORT}-${port}`);
  server.listen(port + 1, "127.0.0.1");
});
server.listen(PORT, "127.0.0.1");
