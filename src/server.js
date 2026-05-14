import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const dataDir = resolve(rootDir, "data");
const logPath = resolve(dataDir, "api-calls.jsonl");
const configPath = resolve(rootDir, "api-monitor.config.json");

const config = loadConfig();
const port = numberFromEnv("PORT", config.port ?? 8080);
const upstreamBaseUrl = process.env.UPSTREAM_BASE_URL ?? config.upstreamBaseUrl;
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? config.publicBaseUrl ?? "";
const adminKey = process.env.ADMIN_KEY ?? config.adminKey ?? "";
const defaultLimit = {
  windowSeconds: numberFromEnv(
    "RATE_LIMIT_WINDOW_SECONDS",
    config.defaultLimit?.windowSeconds ?? 60
  ),
  maxRequests: numberFromEnv("RATE_LIMIT_MAX", config.defaultLimit?.maxRequests ?? 60)
};
const clientLimits = config.clientLimits ?? {};
const httpsConfig = config.https ?? {};
const listenProtocol = httpsConfig.enabled ? "https" : "http";
const corsAllowedOrigins = config.corsAllowedOrigins ?? [
  "http://localhost:3000",
  "http://127.0.0.1:3000"
];

if (!upstreamBaseUrl) {
  console.error(
    "Missing upstream API. Set UPSTREAM_BASE_URL or create api-monitor.config.json."
  );
  process.exit(1);
}

if (publicBaseUrl && sameOrigin(publicBaseUrl, upstreamBaseUrl)) {
  console.warn(
    "Warning: publicBaseUrl and upstreamBaseUrl use the same origin. If that public URL redirects to this monitor, requests will loop."
  );
}

mkdirSync(dataDir, { recursive: true });
const logStream = createWriteStream(logPath, { flags: "a" });
const limitWindows = new Map();
const eventClients = new Set();
const recentEvents = [];

const server = createAppServer(async (req, res) => {
  const startedAt = Date.now();
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);

  try {
    applyCors(req, res);

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (requestUrl.pathname.startsWith("/_monitor")) {
      await handleMonitorRequest(req, res, requestUrl);
      return;
    }

    const clientIdentity = getClientIdentity(req);
    const clientId = clientIdentity.id;
    const limit = limitForClient(clientIdentity);
    const decision = checkLimit(clientId, limit);

    if (!decision.allowed) {
      const requestBytes = estimateRequestBytes(req);
      const event = {
        timestamp: new Date().toISOString(),
        clientId,
        method: req.method,
        path: requestUrl.pathname,
        query: requestUrl.search,
        statusCode: 429,
        durationMs: Date.now() - startedAt,
        limited: true,
        upstreamStatusCode: null,
        bytesReceived: requestBytes,
        bytesSent: 0,
        totalBytes: requestBytes
      };
      writeEvent(event);
      sendJson(res, 429, {
        error: "rate_limit_exceeded",
        clientId,
        limit: limit.maxRequests,
        windowSeconds: limit.windowSeconds,
        retryAfterSeconds: decision.retryAfterSeconds
      }, {
        "Retry-After": String(decision.retryAfterSeconds),
        "X-RateLimit-Limit": String(limit.maxRequests),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(decision.resetAt)
      });
      return;
    }

    const proxyResult = await proxyToUpstream(req, res, requestUrl, limit, decision);
    writeEvent({
      timestamp: new Date().toISOString(),
      clientId,
      method: req.method,
      path: requestUrl.pathname,
      query: requestUrl.search,
      statusCode: proxyResult.statusCode,
      durationMs: Date.now() - startedAt,
      limited: false,
      upstreamStatusCode: proxyResult.upstreamStatusCode,
      bytesReceived: proxyResult.bytesReceived,
      bytesSent: proxyResult.bytesSent,
      totalBytes: proxyResult.totalBytes
    });
  } catch (error) {
    writeEvent({
      timestamp: new Date().toISOString(),
      clientId: getClientId(req),
      method: req.method,
      path: requestUrl.pathname,
      query: requestUrl.search,
      statusCode: 502,
      durationMs: Date.now() - startedAt,
      limited: false,
      upstreamStatusCode: null,
      bytesReceived: estimateRequestBytes(req),
      bytesSent: 0,
      totalBytes: estimateRequestBytes(req),
      error: error.message
    });
    sendJson(res, 502, { error: "upstream_error", message: error.message });
  }
});

server.on("error", (error) => {
  if (error.code === "EACCES") {
    console.error(`Permission denied while listening on port ${port}.`);
    console.error("Use a different port, for example set PORT=3000 or update api-monitor.config.json.");
    process.exit(1);
  }

  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use.`);
    console.error("Stop the other process or choose another port.");
    process.exit(1);
  }

  throw error;
});

server.listen(port, () => {
  console.log(`API monitor listening on ${listenProtocol}://localhost:${port}`);
  console.log(`Proxying requests to ${upstreamBaseUrl}`);
  console.log(`Usage log: ${logPath}`);
});

function createAppServer(handler) {
  if (!httpsConfig.enabled) {
    return http.createServer(handler);
  }

  if (!httpsConfig.keyPath || !httpsConfig.certPath) {
    console.error("HTTPS is enabled, but https.keyPath and https.certPath are required.");
    process.exit(1);
  }

  return https.createServer({
    key: readFileSync(resolve(rootDir, httpsConfig.keyPath)),
    cert: readFileSync(resolve(rootDir, httpsConfig.certPath))
  }, handler);
}

function applyCors(req, res) {
  const origin = headerValue(req, "origin");
  if (!origin || !corsAllowedOrigins.includes(origin)) {
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "authorization,content-type,x-api-key,x-admin-key"
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "x-ratelimit-limit,x-ratelimit-remaining,x-ratelimit-reset,retry-after"
  );
}

function loadConfig() {
  if (!existsSync(configPath)) {
    return {};
  }

  return JSON.parse(readFileSync(configPath, "utf8"));
}

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }

  return parsed;
}

function getClientId(req) {
  return getClientIdentity(req).id;
}

function getClientIdentity(req) {
  const apiKey = headerValue(req, "x-api-key");
  if (apiKey) {
    return {
      id: hashedClientId("api-key", apiKey),
      legacyId: apiKey
    };
  }

  const auth = headerValue(req, "authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice("bearer ".length).trim();
    return {
      id: hashedClientId("bearer", token),
      legacyId: token
    };
  }

  const forwardedFor = headerValue(req, "x-forwarded-for");
  if (forwardedFor) {
    const forwardedClient = forwardedFor.split(",")[0].trim();
    return {
      id: forwardedClient,
      legacyId: forwardedClient
    };
  }

  const socketClient = req.socket.remoteAddress ?? "unknown";
  return {
    id: socketClient,
    legacyId: socketClient
  };
}

function hashedClientId(kind, value) {
  return `${kind}:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function headerValue(req, name) {
  const value = req.headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function limitForClient(clientIdentity) {
  const configuredLimit =
    clientLimits[clientIdentity.id] ?? clientLimits[clientIdentity.legacyId] ?? {};

  return {
    windowSeconds: configuredLimit.windowSeconds ?? defaultLimit.windowSeconds,
    maxRequests: configuredLimit.maxRequests ?? defaultLimit.maxRequests
  };
}

function checkLimit(clientId, limit) {
  const now = Date.now();
  const windowMs = limit.windowSeconds * 1000;
  const current = limitWindows.get(clientId);

  if (!current || now >= current.resetAt) {
    const resetAt = now + windowMs;
    limitWindows.set(clientId, { count: 1, resetAt });
    return {
      allowed: true,
      remaining: limit.maxRequests - 1,
      resetAt: Math.ceil(resetAt / 1000),
      retryAfterSeconds: limit.windowSeconds
    };
  }

  if (current.count >= limit.maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: Math.ceil(current.resetAt / 1000),
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000))
    };
  }

  current.count += 1;
  return {
    allowed: true,
    remaining: limit.maxRequests - current.count,
    resetAt: Math.ceil(current.resetAt / 1000),
    retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000))
  };
}

async function proxyToUpstream(req, res, requestUrl, limit, decision) {
  const targetUrl = new URL(requestUrl.pathname + requestUrl.search, upstreamBaseUrl);
  const body = await readRequestBody(req);
  const headers = copyProxyHeaders(req);

  if (body.length === 0) {
    headers.delete("content-length");
  } else {
    headers.set("content-length", String(body.length));
  }

  const upstreamResponse = await fetch(targetUrl, {
    method: req.method,
    headers,
    body: body.length === 0 || ["GET", "HEAD"].includes(req.method ?? "") ? undefined : body,
    redirect: "manual"
  });

  let responseBuffer = Buffer.from(await upstreamResponse.arrayBuffer());
  const rewritten = rewriteOpenApiResponse(req, requestUrl, upstreamResponse, responseBuffer);
  responseBuffer = rewritten.buffer;
  res.statusCode = upstreamResponse.status;

  for (const [name, value] of upstreamResponse.headers) {
    const lowerName = name.toLowerCase();
    if (
      !hopByHopHeaders.has(lowerName) &&
      !(rewritten.changed && ["content-length", "content-encoding"].includes(lowerName))
    ) {
      res.setHeader(name, value);
    }
  }

  res.setHeader("X-RateLimit-Limit", String(limit.maxRequests));
  res.setHeader("X-RateLimit-Remaining", String(decision.remaining));
  res.setHeader("X-RateLimit-Reset", String(decision.resetAt));
  res.end(responseBuffer);

  return {
    statusCode: upstreamResponse.status,
    upstreamStatusCode: upstreamResponse.status,
    bytesReceived: body.length,
    bytesSent: responseBuffer.length,
    totalBytes: body.length + responseBuffer.length
  };
}

function estimateRequestBytes(req) {
  const contentLength = Number(headerValue(req, "content-length") ?? 0);
  return Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0;
}

function rewriteOpenApiResponse(req, requestUrl, upstreamResponse, buffer) {
  if (upstreamResponse.status !== 200 || !isOpenApiPath(requestUrl.pathname)) {
    return { buffer, changed: false };
  }

  const upstreamOrigin = new URL(upstreamBaseUrl).origin;
  const monitorOrigin = publicBaseUrl || monitorOriginForRequest(req);
  const original = buffer.toString("utf8");
  const rewritten = original
    .replace(new RegExp(escapeRegExp(upstreamOrigin), "g"), monitorOrigin)
    .replace(/url:\s*http:\/\/localhost:\d+\/?/g, `url: ${monitorOrigin}/`)
    .replace(/url:\s*http:\/\/127\.0\.0\.1:\d+\/?/g, `url: ${monitorOrigin}/`)
    .replace(/url:\s*http:\/\/localhost:3000\/?/g, `url: ${monitorOrigin}/`)
    .replace(/url:\s*http:\/\/127\.0\.0\.1:3000\/?/g, `url: ${monitorOrigin}/`);

  if (rewritten === original) {
    return { buffer, changed: false };
  }

  return { buffer: Buffer.from(rewritten, "utf8"), changed: true };
}

function isOpenApiPath(pathname) {
  const lowerPath = pathname.toLowerCase();
  return (
    lowerPath.endsWith("/openapi.yaml") ||
    lowerPath.endsWith("/openapi.yml") ||
    lowerPath.endsWith("/openapi.json") ||
    lowerPath.endsWith("/swagger.json")
  );
}

function monitorOriginForRequest(req) {
  const forwardedProto = headerValue(req, "x-forwarded-proto");
  const proto = forwardedProto?.split(",")[0].trim() || "http";
  return `${proto}://${req.headers.host}`;
}

function sameOrigin(first, second) {
  try {
    return new URL(first).origin === new URL(second).origin;
  } catch {
    return false;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function copyProxyHeaders(req) {
  const headers = new Headers();

  for (const [name, value] of Object.entries(req.headers)) {
    if (hopByHopHeaders.has(name.toLowerCase()) || value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else {
      headers.set(name, value);
    }
  }

  return headers;
}

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host"
]);

function readRequestBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", rejectBody);
  });
}

async function handleMonitorRequest(req, res, requestUrl) {
  if (requestUrl.pathname === "/_monitor/dashboard") {
    sendHtml(res, 200, dashboardHtml());
    return;
  }

  if (!isAdminAuthorized(req)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (requestUrl.pathname === "/_monitor/health") {
    sendJson(res, 200, {
      status: "ok",
      upstreamBaseUrl,
      logPath,
      defaultLimit
    });
    return;
  }

  if (requestUrl.pathname === "/_monitor/limits") {
    sendJson(res, 200, {
      defaultLimit,
      clientLimits,
      activeWindows: Array.from(limitWindows.entries()).map(([clientId, window]) => ({
        clientId,
        count: window.count,
        resetAt: new Date(window.resetAt).toISOString()
      }))
    });
    return;
  }

  if (requestUrl.pathname === "/_monitor/usage") {
    sendJson(res, 200, usageSummary(requestUrl));
    return;
  }

  if (requestUrl.pathname === "/_monitor/events") {
    handleEventStream(req, res);
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

function isAdminAuthorized(req) {
  if (!adminKey) {
    return true;
  }

  return headerValue(req, "x-admin-key") === adminKey;
}

function usageSummary(requestUrl) {
  const since = requestUrl.searchParams.get("since");
  const clientFilter = requestUrl.searchParams.get("clientId");
  const sinceTime = since ? Date.parse(since) : 0;
  const summary = {
    since: since || null,
    totalCalls: 0,
    limitedCalls: 0,
    bytesReceived: 0,
    bytesSent: 0,
    totalBytes: 0,
    byClient: {},
    byStatus: {},
    byPath: {},
    dataByClient: {},
    dataByPath: {}
  };

  if (!existsSync(logPath)) {
    return summary;
  }

  const lines = readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const event = safeJsonParse(line);
    if (!event) {
      continue;
    }

    if (sinceTime && Date.parse(event.timestamp) < sinceTime) {
      continue;
    }

    if (clientFilter && event.clientId !== clientFilter) {
      continue;
    }

    summary.totalCalls += 1;
    const bytesReceived = event.bytesReceived ?? 0;
    const bytesSent = event.bytesSent ?? 0;
    const totalBytes = event.totalBytes ?? bytesReceived + bytesSent;
    summary.bytesReceived += bytesReceived;
    summary.bytesSent += bytesSent;
    summary.totalBytes += totalBytes;

    if (event.limited) {
      summary.limitedCalls += 1;
    }

    addCount(summary.byClient, event.clientId);
    addCount(summary.byStatus, String(event.statusCode));
    addCount(summary.byPath, event.path);
    addBytes(summary.dataByClient, event.clientId, bytesReceived, bytesSent, totalBytes);
    addBytes(summary.dataByPath, event.path, bytesReceived, bytesSent, totalBytes);
  }

  return summary;
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function addCount(target, key) {
  target[key] = (target[key] ?? 0) + 1;
}

function addBytes(target, key, bytesReceived, bytesSent, totalBytes) {
  const current = target[key] ?? { bytesReceived: 0, bytesSent: 0, totalBytes: 0 };
  current.bytesReceived += bytesReceived;
  current.bytesSent += bytesSent;
  current.totalBytes += totalBytes;
  target[key] = current;
}

function writeEvent(event) {
  logStream.write(`${JSON.stringify(event)}\n`);
  recentEvents.push(event);
  if (recentEvents.length > 100) {
    recentEvents.shift();
  }

  broadcastEvent(event);
}

function sendJson(res, statusCode, payload, headers = {}) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }

  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function handleEventStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write("retry: 2000\n\n");

  for (const event of recentEvents.slice(-20)) {
    writeSseEvent(res, "api-call", event);
  }

  eventClients.add(res);
  req.on("close", () => {
    eventClients.delete(res);
  });
}

function broadcastEvent(event) {
  for (const client of eventClients) {
    writeSseEvent(client, "api-call", event);
  }
}

function writeSseEvent(res, name, payload) {
  res.write(`event: ${name}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendHtml(res, statusCode, html) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>API Monitor</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: Arial, sans-serif;
      line-height: 1.4;
      --bg: #f7f7f4;
      --panel: #ffffff;
      --text: #1d1f21;
      --muted: #656b73;
      --border: #d8d9d3;
      --accent: #0f766e;
      --danger: #b42318;
    }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
    }
    header, main {
      max-width: 1120px;
      margin: 0 auto;
      padding: 18px;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      border-bottom: 1px solid var(--border);
    }
    h1 {
      font-size: 22px;
      margin: 0;
    }
    .controls {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    input, button {
      font: inherit;
      min-height: 36px;
      border-radius: 6px;
      border: 1px solid var(--border);
      padding: 0 10px;
    }
    button {
      color: white;
      background: var(--accent);
      border-color: var(--accent);
      cursor: pointer;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 12px;
      margin: 18px 0;
    }
    .stat, .table-wrap {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    .stat {
      padding: 14px;
    }
    .label {
      color: var(--muted);
      font-size: 13px;
    }
    .value {
      font-size: 28px;
      font-weight: 700;
      margin-top: 4px;
    }
    .status {
      color: var(--muted);
      font-size: 14px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    th, td {
      padding: 10px;
      border-bottom: 1px solid var(--border);
      text-align: left;
      vertical-align: top;
      overflow-wrap: anywhere;
      font-size: 14px;
    }
    th {
      color: var(--muted);
      font-weight: 600;
    }
    .limited {
      color: var(--danger);
      font-weight: 700;
    }
    @media (max-width: 760px) {
      header {
        align-items: stretch;
        flex-direction: column;
      }
      .stats {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      input, button {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>API Monitor</h1>
      <div class="status" id="status">Disconnected</div>
    </div>
    <div class="controls">
      <input id="adminKey" type="password" placeholder="Admin key" autocomplete="current-password">
      <button id="connect">Connect</button>
      <button id="clear">Clear</button>
    </div>
  </header>
  <main>
    <section class="stats">
      <div class="stat"><div class="label">Total</div><div class="value" id="total">0</div></div>
      <div class="stat"><div class="label">Limited</div><div class="value" id="limited">0</div></div>
      <div class="stat"><div class="label">Errors</div><div class="value" id="errors">0</div></div>
      <div class="stat"><div class="label">Data</div><div class="value" id="dataUsed">0 B</div></div>
      <div class="stat"><div class="label">Last Status</div><div class="value" id="lastStatus">-</div></div>
    </section>
    <section class="table-wrap">
      <table>
        <thead>
          <tr>
            <th style="width: 180px">Time</th>
            <th style="width: 110px">Client</th>
            <th style="width: 80px">Status</th>
            <th>Path</th>
            <th style="width: 100px">Data</th>
            <th style="width: 100px">Duration</th>
          </tr>
        </thead>
        <tbody id="events"></tbody>
      </table>
    </section>
  </main>
  <script>
    const state = { total: 0, limited: 0, errors: 0, totalBytes: 0, abort: null };
    const statusEl = document.getElementById("status");
    const eventsEl = document.getElementById("events");

    document.getElementById("connect").addEventListener("click", connect);
    document.getElementById("clear").addEventListener("click", clearEvents);

    function clearEvents() {
      state.total = 0;
      state.limited = 0;
      state.errors = 0;
      state.totalBytes = 0;
      document.getElementById("lastStatus").textContent = "-";
      eventsEl.textContent = "";
      renderStats();
    }

    async function connect() {
      if (state.abort) {
        state.abort.abort();
      }

      const adminKey = document.getElementById("adminKey").value;
      state.abort = new AbortController();
      statusEl.textContent = "Connecting";

      try {
        const response = await fetch(new URL("/_monitor/events", window.location.origin), {
          headers: { "x-admin-key": adminKey },
          signal: state.abort.signal
        });

        if (!response.ok || !response.body) {
          statusEl.textContent = "Connection failed: HTTP " + response.status;
          return;
        }

        statusEl.textContent = "Connected";
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const result = await reader.read();
          if (result.done) {
            break;
          }

          buffer += decoder.decode(result.value, { stream: true });
          const parts = buffer.split("\\n\\n");
          buffer = parts.pop();

          for (const part of parts) {
            handleSseMessage(part);
          }
        }

        statusEl.textContent = "Disconnected";
      } catch (error) {
        if (error.name !== "AbortError") {
          statusEl.textContent = "Connection failed: " + error.message;
        }
      }
    }

    function handleSseMessage(message) {
      const dataLine = message.split("\\n").find((line) => line.startsWith("data: "));
      if (!dataLine) {
        return;
      }

      addEvent(JSON.parse(dataLine.slice(6)));
    }

    function addEvent(event) {
      state.total += 1;
      if (event.limited) {
        state.limited += 1;
      }
      if (event.statusCode >= 500) {
        state.errors += 1;
      }
      state.totalBytes += event.totalBytes ?? ((event.bytesReceived ?? 0) + (event.bytesSent ?? 0));

      document.getElementById("lastStatus").textContent = event.statusCode;
      renderStats();

      const row = document.createElement("tr");
      if (event.limited) {
        row.className = "limited";
      }
      row.innerHTML = [
        cell(new Date(event.timestamp).toLocaleTimeString()),
        cell(event.clientId),
        cell(event.statusCode),
        cell(event.path + (event.query || "")),
        cell(formatBytes(event.totalBytes ?? ((event.bytesReceived ?? 0) + (event.bytesSent ?? 0)))),
        cell(String(event.durationMs) + " ms")
      ].join("");
      eventsEl.prepend(row);

      while (eventsEl.children.length > 100) {
        eventsEl.lastElementChild.remove();
      }
    }

    function cell(value) {
      return "<td>" + escapeHtml(String(value ?? "")) + "</td>";
    }

    function escapeHtml(value) {
      return value.replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }

    function renderStats() {
      document.getElementById("total").textContent = state.total;
      document.getElementById("limited").textContent = state.limited;
      document.getElementById("errors").textContent = state.errors;
      document.getElementById("dataUsed").textContent = formatBytes(state.totalBytes);
    }

    function formatBytes(bytes) {
      if (bytes < 1024) {
        return bytes + " B";
      }

      const units = ["KB", "MB", "GB", "TB"];
      let value = bytes / 1024;
      let unitIndex = 0;

      while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
      }

      return value.toFixed(value >= 10 ? 1 : 2) + " " + units[unitIndex];
    }
  </script>
</body>
</html>`;
}
