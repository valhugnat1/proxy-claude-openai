# codex-router

Standalone Node.js server that converts between Anthropic and OpenAI API formats, with TLS bypass for internal CA certificates.

Replaces the wrangler/workerd-based y-router that can't handle internal TLS certs.

## Architecture

```
Claude Code (Anthropic format)
    ↓ HTTP
codex-router (localhost:8787) — Anthropic→OpenAI + TLS bypass
    ↓ HTTPS (rejectUnauthorized: false)
Staging: codex-srr-staging.atl.internal.scaleway.com ✅
```

## Requirements

- Node.js ≥ 18 (uses native `fetch`-era APIs, but only `http`/`https` modules)
- Zero npm dependencies

## Quick start

```bash
# Start the router pointing at your staging backend
UPSTREAM_BASE_URL=https://codex-srr-staging.atl.internal.scaleway.com \
  node server.mjs

# Or with verbose logging
UPSTREAM_BASE_URL=https://codex-srr-staging.atl.internal.scaleway.com \
  LOG_REQUESTS=true node server.mjs
```

## Configure Claude Code

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
```

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `UPSTREAM_BASE_URL` | ✅ | — | Full URL of the OpenAI-compatible backend |
| `PORT` | | `8787` | Listen port |
| `LOG_REQUESTS` | | `false` | Log truncated request/response bodies |

## Endpoints

| Path | Method | Description |
|---|---|---|
| `/v1/messages` | POST | Anthropic Messages API (converts & proxies to upstream) |
| `/health` | GET | Health check (returns upstream URL) |

## What it does

1. Receives Anthropic-format requests from Claude Code
2. Converts messages, tools, and system prompts to OpenAI format
3. Forwards to the upstream backend with `rejectUnauthorized: false` (bypasses internal CA)
4. Converts the OpenAI response back to Anthropic format (both streaming SSE and non-streaming)
5. Returns to Claude Code in the expected Anthropic format

## Differences from y-router

- **No Docker** — runs directly on your machine
- **No wrangler/workerd** — plain Node.js, no Cloudflare runtime restrictions
- **TLS bypass** — `rejectUnauthorized: false` works natively in Node.js
- **Zero dependencies** — only Node.js built-in modules (`http`, `https`, `url`)# proxy-claude-openai
