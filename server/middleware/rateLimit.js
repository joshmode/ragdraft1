import rateLimit from "express-rate-limit"

// Applied globally as a floor against basic abuse/scraping.
export const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please slow down and try again shortly." },
})

// Login/register are the classic brute-force targets — keep this tight.
export const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: "Too many authentication attempts. Please try again later." },
})

// Analysis/generation calls fan out to paid LLM providers — this is the
// endpoint most worth protecting once the app is public, since unbounded
// abuse here directly burns API budget rather than just server CPU.
export const llmLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many analysis requests. Please wait a few minutes before trying again." },
})
