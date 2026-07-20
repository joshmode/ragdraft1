import fetch from "node-fetch"

const MAX_RETRIES = 3
const BASE_DELAY_MS = 1500
const MAX_DELAY_MS = 20000

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

// Wraps a call to the Python engine (analyse / gen-cv / gen-cover-letter /
// compare-resume-jd — the endpoints that fan out to a paid LLM provider) with
// exponential backoff + jitter on 429. The engine already retries individual
// LLM calls internally (router.py); this catches the case where an entire
// analysis exhausts those retries and the engine reports a 429 back to us —
// retrying the whole job once or twice with backoff is usually enough to
// ride out a transient provider rate limit without the user having to
// manually click "Analyse" again.
export async function fetchEngineWithRetry(url, options, attempt = 0) {
    const res = await fetch(url, options)

    if (res.status === 429 && attempt < MAX_RETRIES) {
        let retryAfterSec = 0
        try {
            const body = await res.clone().json()
            retryAfterSec = Number(body.retry_after) || 0
        } catch {
            // engine didn't return a JSON body we could read a retry_after from
        }
        const backoffMs = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt)
        const jitterMs = Math.random() * 500
        const delayMs = retryAfterSec > 0 ? retryAfterSec * 1000 + jitterMs : backoffMs + jitterMs
        await sleep(delayMs)
        return fetchEngineWithRetry(url, options, attempt + 1)
    }

    return res
}
