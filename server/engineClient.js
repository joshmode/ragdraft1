import fetch from "node-fetch"

const MAX_RETRIES = 3
const BASE_DELAY_MS = 1500
const MAX_DELAY_MS = 20000

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

// retries a whole engine call with backoff+jitter on 429, on top of router.py's own per-call retries
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
