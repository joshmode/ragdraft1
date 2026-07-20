import rateLimit from "express-rate-limit"

// Every limiter reports how long the caller should wait, both as a
// standard Retry-After header and as JSON, so the frontend can back off and
// retry automatically instead of just surfacing a dead-end error.
function rateLimitHandler(message) {
    return (req, res) => {
        const resetMs = req.rateLimit?.resetTime ? req.rateLimit.resetTime.getTime() - Date.now() : 30000
        const retryAfterSec = Math.max(1, Math.ceil(resetMs / 1000))
        res.setHeader("Retry-After", String(retryAfterSec))
        res.status(429).json({ error: message, retry_after: retryAfterSec })
    }
}

// Applied globally as a floor against basic abuse/scraping. Sized generously
// because it counts every /api call a signed-in user makes, including
// status polling and PDF re-highlighting while reviewing suggestions.
export const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler("Too many requests. Please slow down and try again shortly."),
})

// Job-status polling and highlight re-rendering are cheap, idempotent reads
// that legitimately fire once a second or on every suggestion click — they
// need their own generous, short-window bucket so they don't eat into the
// budget shared with everything else and trip generalLimiter first.
export const pollLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 90,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler("Refreshing too frequently. Please wait a moment."),
})

// Login/register are the classic brute-force targets — keep this tight.
export const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: rateLimitHandler("Too many authentication attempts. Please try again later."),
})

// Analysis/generation calls fan out to paid LLM providers — this is the
// endpoint most worth protecting once the app is public, since unbounded
// abuse here directly burns API budget rather than just server CPU.
export const llmLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler("Too many analysis requests. Please wait a few minutes before trying again."),
})
