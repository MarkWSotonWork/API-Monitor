# API Monitor

A small dependency-free Node.js gateway for monitoring API calls, tracking usage, and limiting request volume per client.

## What it does

- Proxies API requests to an upstream API.
- Identifies callers by `x-api-key`, bearer token, `x-forwarded-for`, or IP address.
- Hashes API keys and bearer tokens before storing them as client IDs.
- Enforces fixed-window rate limits.
- Tracks request bytes, response bytes, and total data usage.
- Writes one JSON event per request to `data/api-calls.jsonl`.
- Exposes monitor endpoints for health, limits, usage summaries, and live events.

## Configure

Copy the example config:

```powershell
Copy-Item api-monitor.config.example.json api-monitor.config.json
```

Edit `api-monitor.config.json`:

```json
{
  "port": 7934,
  "upstreamBaseUrl": "http://127.0.0.1:7935",
  "publicBaseUrl": "http://10.1.2.4:7934",
  "adminKey": "change-me",
  "https": {
    "enabled": false,
    "keyPath": "certs/localhost-key.pem",
    "certPath": "certs/localhost-cert.pem"
  },
  "corsAllowedOrigins": [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://10.1.2.4:3000",
    "http://10.1.2.4:3001",
    "http://10.1.2.4:7934",
    "https://localhost:3000",
    "https://127.0.0.1:3000",
    "https://10.1.2.4:3000",
    "https://10.1.2.4:3001",
    "https://10.1.2.4:7934"
  ],
  "defaultLimit": {
    "windowSeconds": 60,
    "maxRequests": 60
  },
  "clientLimits": {
    "demo-key": {
      "windowSeconds": 60,
      "maxRequests": 10
    }
  }
}
```

Environment variables can override the main settings:

- `PORT`
- `UPSTREAM_BASE_URL`
- `ADMIN_KEY`
- `RATE_LIMIT_WINDOW_SECONDS`
- `RATE_LIMIT_MAX`

## Run

```powershell
npm start
```

Run the monitor as the customer-facing reverse proxy:

```text
Customer URL: http://10.1.2.4:7934
Monitor:      http://10.1.2.4:7934
Real API:     http://127.0.0.1:7935
```

The customer-facing URL stays the same. The real API runs privately on `127.0.0.1:7935`, and the monitor forwards customer requests to it.

If you use the API's test Swagger page, open it through the monitor:

```text
http://10.1.2.4:7934/docs/swagger
```

The monitor rewrites proxied OpenAPI `servers` URLs to `publicBaseUrl`, so Swagger's `Try it out` requests go through the externally visible monitored address instead of `localhost`.

Send API traffic through the monitor:

```powershell
Invoke-RestMethod http://10.1.2.4:7934/v1/example -Headers @{ "x-api-key" = "demo-key" }
```

The gateway will forward that request to:

```text
http://127.0.0.1:7935/v1/example
```

## HTTPS

The monitor can listen over HTTPS while still forwarding to your API over HTTP.

Create a local certificate and key in `certs/`. With `mkcert`:

```powershell
mkdir certs
mkcert -key-file certs/localhost-key.pem -cert-file certs/localhost-cert.pem localhost 127.0.0.1
```

Or with OpenSSL:

```powershell
mkdir certs
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 365 -keyout certs/localhost-key.pem -out certs/localhost-cert.pem -subj "/CN=localhost"
```

Then enable HTTPS in `api-monitor.config.json`:

```json
"https": {
  "enabled": true,
  "keyPath": "certs/localhost-key.pem",
  "certPath": "certs/localhost-cert.pem"
}
```

Restart the monitor and use:

```text
https://10.1.2.4:7934/_monitor/dashboard
https://10.1.2.4:7934/docs/swagger
```

## Monitor Endpoints

If `adminKey` is configured, include `x-admin-key` on these requests.

```powershell
Invoke-RestMethod http://10.1.2.4:7934/_monitor/health -Headers @{ "x-admin-key" = "change-me" }
Invoke-RestMethod http://10.1.2.4:7934/_monitor/limits -Headers @{ "x-admin-key" = "change-me" }
Invoke-RestMethod http://10.1.2.4:7934/_monitor/usage -Headers @{ "x-admin-key" = "change-me" }
```

Filter usage:

```powershell
Invoke-RestMethod "http://10.1.2.4:7934/_monitor/usage?clientId=demo-key&since=2026-05-14T00:00:00Z" -Headers @{ "x-admin-key" = "change-me" }
```

Usage summaries include data totals:

```json
{
  "totalCalls": 12,
  "limitedCalls": 1,
  "bytesReceived": 2048,
  "bytesSent": 98304,
  "totalBytes": 100352,
  "dataByClient": {
    "demo-key": {
      "bytesReceived": 2048,
      "bytesSent": 98304,
      "totalBytes": 100352
    }
  }
}
```

## Realtime Monitoring

Open the dashboard in a browser:

```text
http://10.1.2.4:7934/_monitor/dashboard
```

Enter the admin key from `api-monitor.config.json`, then click `Connect`.

The dashboard shows live call counts, rate-limit hits, errors, and total data used.

You can also stream raw live events in PowerShell:

```powershell
curl.exe -N http://10.1.2.4:7934/_monitor/events -H "x-admin-key: change-me"
```

Each API call is streamed as a Server-Sent Events message and is also still written to `data/api-calls.jsonl`.

## Rate Limit Responses

When a client exceeds the allowed calls, the gateway returns `429`:

```json
{
  "error": "rate_limit_exceeded",
  "clientId": "demo-key",
  "limit": 10,
  "windowSeconds": 60,
  "retryAfterSeconds": 42
}
```

Responses include standard-ish rate limit headers:

- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset`
- `Retry-After` on limited requests
