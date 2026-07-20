# RAGsToRiches

RAGsToRiches now runs as a React single-page application served by an Express REST API. The Python analysis engine remains private to the API and is not exposed to the browser.

## Run with Docker

Copy `.env.example` to `.env`, set a long `JWT_SECRET` and `KEY_ENCRYPTION_SECRET` (`openssl rand -hex 32` for each), and add a `GROQ_API_KEY` so the free tier works out of the box (see "Providers & API keys" below). Then start the full application:

```bash
docker compose up --build
```

Open `http://localhost:3000`.

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
```

Use environment variables or your host's secret manager for production credentials. Keep `.env`, `data/`, and `chroma_db/` out of source control.

## Providers & API keys

The provider dropdown has five options:

| Option | Who pays | Key source |
|---|---|---|
| **Default (Free)** | You (the operator), via a free tier | `GROQ_API_KEY` in `.env`, shared by every visitor |
| **Gemini / Claude / ChatGPT (Own Key)** | Each user, individually | That user's own key, saved to their account |
| **Local LLM** | Nobody (self-hosted model) | An endpoint the user provides |

**"Default (Free)" uses [Groq](https://console.groq.com/keys)**, not one of the big three — Groq has a genuinely free, generous rate-limited tier, which is what makes a public deployment usable by people with no API key of their own. Get a free key and set `GROQ_API_KEY` in `.env`; that one key is shared by every visitor who picks "Default." There's no meaningful free ongoing tier for Claude or OpenAI (only small trial credits), and Gemini's free tier is more restrictive than Groq's, which is why Groq is the pooled default rather than Gemini.

**Per-user "Own Key" storage is real bring-your-own-key, not shared state.** Each user's key is encrypted (AES-256-GCM, keyed by `KEY_ENCRYPTION_SECRET`) and stored against their account in SQLite. It's decrypted server-side only at the moment of an LLM call, for that one user's request, and is never written to a shared file, env var, or returned to any client. Two users can each save a different Gemini key and their requests never cross — this replaced an earlier design that wrote every saved key into one shared file, which meant whoever saved a key last silently became the key everyone's requests used.

There's no model dropdown anymore — each provider always uses its current flagship "latest" model, configured server-side (`GEMINI_DEFAULT_MODEL`, `CLAUDE_DEFAULT_MODEL`, `OPENAI_DEFAULT_MODEL`, `GROQ_DEFAULT_MODEL` in `.env`). Double-check these against each provider's current docs before deploying — model IDs are a moving target and the shipped defaults may drift out of date.

**Local LLM** only works if the *server* can reach the endpoint — not the visitor's own laptop. A website can't reach into a stranger's home network by default. Running the app locally, `localhost:11434` (Ollama's default port) resolves correctly since browser and server are the same machine. On a hosted deployment, a user who wants to use their own local model needs to expose it with a tunnel (ngrok, Tailscale Funnel, Cloudflare Tunnel) and paste that public URL into the endpoint field — the UI explains this inline.

## Services

- `client/` contains the Vite/React frontend.
- `server/` contains the Express REST API, JWT accounts, SQLite persistence, review sessions, analytics records, and job description history.
- `engine_api.py` provides the private Python analysis, retrieval, parsing, document export, and PDF highlighting service.

The compose deployment persists application records in `data/` and ChromaDB data in `chroma_db/`.

## Included capabilities

- asynchronous analysis jobs, per-provider limits, critic timeouts, critic status reporting, and a paired critic benchmark runner;
- PDF, DOCX, ODT, text, Markdown, and LinkedIn export ZIP parsing;
- score history, section scores, readability heatmaps, accepted-rewrite records, and consented evaluation feedback;
- mentor accounts with a full review workspace: candidate analysis history, per-analysis drill-down (rewrites + the candidate's accept/dismiss decisions), PR-style diffs between any two resume revisions, and a feedback channel where mentors send comments or concrete edit suggestions that candidates accept or dismiss from their inbox;
- saved job descriptions, job matching, LinkedIn public-profile import, tailored CV/cover-letter generation, and DOCX/PDF export.

Run the critic benchmark with a JSON fixture:

```bash
python3 critic_benchmark.py path/to/fixture.json
```

`app.py` is a legacy standalone Streamlit prototype kept for reference. It is
not used by Docker, `docker-compose.yml`, or any deploy path below — the
supported app is `client/` + `server/` + `engine_api.py`.

## How rate limiting works

If the UI shows "Too many requests. Please slow down and try again shortly."
— that message comes from `server/middleware/rateLimit.js`, i.e. the app's
*own* Express rate limiter, not a raw 429 from Gemini/OpenAI/Anthropic. It
has three separate buckets so unrelated traffic doesn't share one budget:

- `generalLimiter` — a floor on all `/api/*` traffic (600 req/15 min/IP).
- `pollLimiter` — a much tighter window (90 req/min) but its own separate
  budget for the cheap, high-frequency reads: job-status polling while an
  analysis runs, and PDF re-highlighting as you click through suggestions.
- `authLimiter` / `llmLimiter` — brute-force protection on login, and abuse
  protection on the endpoints that spend LLM API budget.

Every 429 from any of these includes a `retry_after` (seconds) in the JSON
body and a standard `Retry-After` header. The frontend's axios client
(`client/src/api/client.js`) automatically retries on 429 with exponential
backoff + jitter before ever surfacing an error, so a momentary limit is
invisible to the user in the common case. The same pattern exists at two
more layers for genuine upstream provider rate limits:

- `router.py`'s `llm_call` retries an individual LLM call up to 5 times with
  exponential backoff + jitter on a provider 429/5xx.
- `server/engineClient.js`'s `fetchEngineWithRetry` retries a whole
  `/analyse` (or `/gen-cv`, `/gen-cover-letter`, `/compare-resume-jd`) call
  if the engine itself reports a 429 after exhausting its own retries, so a
  transient provider outage doesn't fail the job outright.

Two more things reduce how often any of this gets exercised in the first
place: `analyser.py` batches bullets into one LLM call per chunk instead of
one per bullet (see below), and `POST /api/analysis/run` skips the LLM
entirely and returns an existing result if you re-run the exact same resume
+ job description + provider/model/critic combination within
`ANALYSIS_CACHE_TTL_MINUTES` (default 60) — set it to `0` to disable.

## Why analysis got faster

The engine used to send one LLM request per resume bullet — a 20-bullet
resume meant 20 sequential-ish round trips, each paying full network and
provider-queueing latency. `analyser.py` now batches bullets into chunks
(`REWRITE_CHUNK_SIZE`, default 6) and rewrites a whole chunk in a single
call, so the same resume takes ~4 calls instead of ~20, with no drop in
per-bullet quality: each bullet in a chunk still gets its own RAG framework
context and is rewritten independently in the response. If a chunk's
response can't be parsed back into one result per bullet, that chunk
automatically falls back to the original per-bullet calls, so batching only
ever adds speed, never a new failure mode. Tune batch size with:

```bash
REWRITE_CHUNK_SIZE=8   # larger batches = fewer calls, bigger prompts
```

## Why local runs were getting SIGKILL'd

`easyocr` (used only for scanned-PDF fallback) pulls in `torch`, which by
itself needs several hundred MB of RSS the moment it's imported — and it was
being imported unconditionally at module load, in every engine process,
whether or not any upload ever needed OCR. Combined with 2 gunicorn worker
*processes* each paying that cost independently, plus the embedding model
used for RAG retrieval, memory pressure would spike past what Docker
Desktop / the host had available, and the OS OOM-killer would SIGKILL the
container.

Two fixes:
- `parser.py` now only checks OCR *availability* at import time (via
  `importlib.util.find_spec`, which doesn't execute the module) and defers
  the actual `import easyocr` / `import torch` until a scanned PDF genuinely
  needs OCR. Every normal (non-scanned) resume upload never touches torch.
- The engine Dockerfile now runs gunicorn with **1 worker + 4 threads**
  instead of 2 worker processes. Analysis is network-bound (waiting on LLM
  APIs), so threads give the same concurrency without duplicating the
  embedding model (and, if OCR ever fires, torch) across processes. This
  also keeps the per-provider concurrency limits in `router.py` meaningful —
  those are in-process locks that multiple worker processes would silently
  multiply past their configured limit.

If you still hit OOM kills locally, give Docker Desktop more memory (Settings
→ Resources) — budget ~500MB–1GB for the engine under normal use, and up to
~1.5–2GB if resumes routinely need OCR (scanned/image-based PDFs).

## Deploying so it's reachable on the internet

The stack is already container-native and reads all secrets from
environment variables, so "host it" is: run the same `docker compose`
command on a public machine, put a reverse proxy with TLS in front of it,
and point a domain at it. This repo doesn't include cloud credentials or a
specific provider integration, so you'll run these steps against whichever
host you choose (a VPS is the most portable option; the same image also
runs on Render/Railway/Fly.io if you prefer a managed platform).

1. **Provision a machine** with Docker + Docker Compose installed (any VPS
   with ≥2GB RAM is enough; see memory notes above). Point a DNS A record
   at its IP.
2. **Copy the repo and configure secrets** on that machine:
   ```bash
   cp .env.example .env
   # set a long random JWT_SECRET and KEY_ENCRYPTION_SECRET (openssl rand -hex 32),
   # and GROQ_API_KEY so the free tier works for visitors with no key of their own
   ```
   Set `FRONTEND_URL` in `.env` (or the compose file's `api` environment) to
   your real domain, e.g. `FRONTEND_URL=https://resumes.example.com`. It
   accepts a comma-separated list if you need more than one origin (e.g. a
   staging domain).
3. **Set your domain** in `.env`:
   ```bash
   DOMAIN=resumes.example.com
   ```
4. **Start the production stack with HTTPS** — the bundled Caddy overlay
   terminates TLS with automatic Let's Encrypt certificates and proxies to
   the app (the API itself is bound to loopback, so only Caddy is public):
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.https.yml up -d --build
   ```
   Open ports 80 and 443 in your host's firewall/security group. Caddy
   obtains and renews certificates automatically as long as the DNS record
   points at the machine.
5. **Verify**: `curl https://resumes.example.com/api/health` should return
   `{"status":"ok",...}`.

Operational notes for running with real traffic:
- The Express API now sets security headers (helmet), rate-limits
  authentication (20 attempts/15 min/IP) and analysis/generation endpoints
  (30 requests/15 min/IP — these are the ones that spend your LLM API
  budget), and returns JSON errors consistently instead of ever falling
  through to an HTML error page.
- `data/` (SQLite + score history) and `chroma_db/` (framework embeddings)
  are the only stateful directories — back them up if you care about
  persisting user accounts and analysis history across redeploys.
- `docker-compose.prod.yml` sets `ALLOW_MENTOR_REGISTRATION=false` and
  `ALLOW_LOCAL_PROVIDER=false` by default; flip them back on deliberately if
  your deployment needs open mentor sign-ups or a locally-hosted model
  endpoint reachable from the server.

### Deploying on Oracle Cloud's Always Free tier

Oracle's Always Free VPS is a genuinely permanent $0 option and works fine
for this stack, with one thing to check first: their Ampere A1 instance is
**ARM64 (aarch64)**, not x86. Everything in this repo builds fine on ARM
*except* potentially `torch`, pulled in transitively by `easyocr` for the
scanned-PDF OCR fallback (`requirements-engine.txt`). Whether
`--extra-index-url https://download.pytorch.org/whl/cpu` publishes aarch64
wheels changes over time — if `docker compose build` fails inside the
`engine` build step, that's almost certainly why.

OCR is optional and already degrades gracefully — `parser.py` returns a
clear warning instead of crashing when it's unavailable (see "Why local
runs were getting SIGKILL'd" above), so the simplest fix if you hit this is
to drop `torch`, `torchvision`, `easyocr`, and `pdf2image` from
`requirements-engine.txt` entirely. You lose scanned-PDF support; a normal
text-based resume PDF/DOCX/TXT upload is unaffected. This also meaningfully
shrinks the image and build time, which matters more on a free-tier VPS's
modest CPU allocation.

If you'd rather keep OCR, Oracle's Always Free tier also includes x86 micro
instances (`VM.Standard.E2.1.Micro`) as an alternative — smaller (1GB RAM
each), but plain x86_64 with no wheel-availability question.
