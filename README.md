# RAGsToRiches

RAGsToRiches now runs as a React single-page application served by an Express REST API. The Python analysis engine remains private to the API and is not exposed to the browser.

## Run with Docker

Copy `.env.example` to `.env`, set a long `JWT_SECRET`, and add at least one provider key. Then start the full application:

```bash
docker compose up --build
```

Open `http://localhost:3000`.

The development compose setup allows a signed-in user to add a provider key through the UI. The key is stored in `data/.env`, which is mounted as persistent local application data. The production overlay disables this local key-write route and local model endpoints:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
```

Use environment variables or your host's secret manager for production credentials. Keep `.env`, `data/`, and `chroma_db/` out of source control.

## Services

- `client/` contains the Vite/React frontend.
- `server/` contains the Express REST API, JWT accounts, SQLite persistence, review sessions, analytics records, and job description history.
- `engine_api.py` provides the private Python analysis, retrieval, parsing, document export, and PDF highlighting service.

The compose deployment persists application records in `data/` and ChromaDB data in `chroma_db/`.

## Included capabilities

- asynchronous analysis jobs, per-provider limits, critic timeouts, critic status reporting, and a paired critic benchmark runner;
- PDF, DOCX, ODT, text, Markdown, and LinkedIn export ZIP parsing;
- score history, section scores, readability heatmaps, accepted-rewrite records, and consented evaluation feedback;
- mentor accounts, candidate review sessions, annotations, revision snapshots, and mentor reports;
- saved job descriptions, job matching, LinkedIn public-profile import, tailored CV/cover-letter generation, and DOCX/PDF export.

Run the critic benchmark with a JSON fixture:

```bash
python3 critic_benchmark.py path/to/fixture.json
```

`app.py` is a legacy standalone Streamlit prototype kept for reference. It is
not used by Docker, `docker-compose.yml`, or any deploy path below — the
supported app is `client/` + `server/` + `engine_api.py`.

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
   # set a long random JWT_SECRET, and at least one provider key
   # (GEMINI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY)
   ```
   Set `FRONTEND_URL` in `.env` (or the compose file's `api` environment) to
   your real domain, e.g. `FRONTEND_URL=https://resumes.example.com`. It
   accepts a comma-separated list if you need more than one origin (e.g. a
   staging domain).
3. **Start the production stack** (disables local-key-write and local model
   endpoints, which only make sense for a single trusted local user):
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
   ```
   This exposes the `api` service on port 3000, which serves both the built
   React app and `/api/*`.
4. **Put TLS in front of it.** The simplest option is
   [Caddy](https://caddyserver.com/), which handles Let's Encrypt
   certificates automatically. A minimal `Caddyfile`:
   ```
   resumes.example.com {
       reverse_proxy localhost:3000
   }
   ```
   Run Caddy on the host (or as another container on the same Docker
   network) and open ports 80/443 instead of 3000 to the public internet.
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
