FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    poppler-utils \
    libgl1 \
    libglib2.0-0 \
    curl \
 && rm -rf /var/lib/apt/lists/*

COPY requirements-engine.txt .

RUN pip install --no-cache-dir -r requirements-engine.txt

COPY . .

EXPOSE 5001

# Single worker process + threads, not multiple worker processes: the engine
# lazily loads a sentence-transformers embedding model (and, only if a scanned
# PDF triggers OCR, easyocr/torch) as process-wide singletons. Each extra
# gunicorn *worker* duplicates that memory and was the leading cause of the
# container being OOM-killed (SIGKILL) on memory-constrained hosts. Threads
# share that memory and are enough concurrency here since analysis is
# network-bound (waiting on LLM APIs), not CPU-bound. This also keeps the
# per-provider concurrency semaphores in router.py meaningful — they're
# in-process locks that multiple worker processes would silently multiply.
# --max-requests recycles the worker periodically to bound any slow memory
# creep from long-lived caches.
CMD ["gunicorn", "--bind", "0.0.0.0:5001", \
     "--workers", "1", "--threads", "8", "--worker-class", "gthread", \
     "--timeout", "300", "--max-requests", "200", "--max-requests-jitter", "50", \
     "engine_api:app"]
