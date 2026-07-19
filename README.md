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
