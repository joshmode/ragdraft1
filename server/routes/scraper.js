import { Router } from "express"
import fetch from "node-fetch"
import crypto from "crypto"
import { authenticateToken } from "../middleware/auth.js"
import { getDb } from "../db.js"
import { getOwnedAnalysis } from "../access.js"
import { fetchEngineWithRetry } from "../engineClient.js"
import { resolveProviderForRequest, ProviderResolutionError } from "../userKeys.js"
import { llmLimiter } from "../middleware/rateLimit.js"

const router = Router()
const PROVIDER_CHOICES = new Set(["default", "gemini", "claude", "chatgpt", "local"])
const COMPARE_CACHE_TTL_MINUTES = parseInt(process.env.ANALYSIS_CACHE_TTL_MINUTES || "60", 10)

// identical resume+jd+provider text = an identical comparison prompt, so skip the LLM call
// entirely and replay the last result - same idea as /analysis/run's content-hash cache.
// localEndpoint must be part of the key: for provider "local" it's what actually picks the
// model, and two different endpoints must never share a cached result (see analysis.js).
function compareContentHash(resumeText, jdText, provider, localEndpoint) {
    return crypto.createHash("sha256").update(`${provider || ""}|${localEndpoint || ""}|${resumeText || ""}|${jdText || ""}`).digest("hex")
}

router.post("/jd", authenticateToken, async (req, res) => {
    const engineUrl = req.app.locals.engineUrl
    try {
        const engineRes = await fetch(`${engineUrl}/scrape-jd`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: req.body.url }),
        })
        if (!engineRes.ok) return res.status(engineRes.status).json(await engineRes.json())
        const data = await engineRes.json()
        const text = String(data.text || "")
        const sourceName = (() => {
            try { return new URL(req.body.url).hostname } catch { return "" }
        })()
        const saved = getDb().prepare(
            "INSERT INTO job_descriptions (user_id, source_url, source_name, content, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run(req.user.id, String(req.body.url || ""), sourceName, text)
        res.json({ ...data, job_id: saved.lastInsertRowid })
    } catch (err) {
        res.status(500).json({ error: "Scrape failed. Please try again." })
    }
})

router.post("/jobs", authenticateToken, (req, res) => {
    const content = String(req.body.content || "").trim()
    if (!content) return res.status(400).json({ error: "Job description content is required." })
    const saved = getDb().prepare(
        "INSERT INTO job_descriptions (user_id, source_url, source_name, content, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run(req.user.id, String(req.body.source_url || ""), String(req.body.source_name || "Manual entry"), content)
    res.status(201).json({ id: saved.lastInsertRowid, content })
})

router.get("/jobs", authenticateToken, (req, res) => {
    const rows = getDb().prepare(
        "SELECT id, source_url, source_name, content, created_at FROM job_descriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50"
    ).all(req.user.id)
    res.json(rows)
})

// Number(x) on a non-scalar body value (e.g. {}) yields NaN rather than throwing, unlike
// parseInt on an object - but a bare truthy-check on the raw value before coercing (the
// bug pattern this replaces) let a NaN slip past the falsy-check below and reach a SQL
// bind call, which better-sqlite3 rejects; Number.isFinite closes that gap
function toIdOrNull(raw) {
    if (!raw) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
}

router.post("/linkedin", authenticateToken, async (req, res) => {
    const engineUrl = req.app.locals.engineUrl
    try {
        const engineRes = await fetch(`${engineUrl}/scrape-linkedin`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: req.body.url }),
        })
        if (!engineRes.ok) return res.status(engineRes.status).json(await engineRes.json())
        const data = await engineRes.json()
        const analysisId = toIdOrNull(req.body.analysis_id)
        if (req.body.analysis_id && (!analysisId || !getOwnedAnalysis(analysisId, req.user.id))) {
            return res.status(404).json({ error: "Analysis not found." })
        }
        const jobId = toIdOrNull(req.body.job_id)
        if (req.body.job_id) {
            const job = getDb().prepare("SELECT id FROM job_descriptions WHERE id = ? AND user_id = ?").get(jobId, req.user.id)
            if (!job) return res.status(404).json({ error: "Job description not found." })
        }
        const saved = getDb().prepare(
            "INSERT INTO job_matches (user_id, job_description_id, analysis_id, result_json, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run(req.user.id, jobId, analysisId, JSON.stringify(data))
        res.json({ ...data, match_id: saved.lastInsertRowid })
    } catch (err) {
        res.status(500).json({ error: "LinkedIn scrape failed. Please try again." })
    }
})

router.post("/compare", authenticateToken, llmLimiter, async (req, res) => {
    const provider = req.body.provider
    if (!PROVIDER_CHOICES.has(provider)) {
        return res.status(400).json({ error: "Unknown provider." })
    }
    if (provider === "local" && process.env.ALLOW_LOCAL_PROVIDER !== "true") {
        return res.status(403).json({ error: "Local model endpoints are disabled for this deployment." })
    }
    const analysisId = toIdOrNull(req.body.analysis_id)
    if (req.body.analysis_id && (!analysisId || !getOwnedAnalysis(analysisId, req.user.id))) {
        return res.status(404).json({ error: "Analysis not found." })
    }
    const jobId = toIdOrNull(req.body.job_id)
    if (req.body.job_id) {
        const job = getDb().prepare("SELECT id FROM job_descriptions WHERE id = ? AND user_id = ?").get(jobId, req.user.id)
        if (!job) return res.status(404).json({ error: "Job description not found." })
    }

    const resumeText = req.body.resume_text || ""
    const jdText = req.body.jd_text || ""
    const localEndpoint = req.body.local_endpoint || ""
    const contentHash = compareContentHash(resumeText, jdText, provider, localEndpoint)
    const db = getDb()

    if (!req.body.force_refresh && COMPARE_CACHE_TTL_MINUTES > 0) {
        const cached = db.prepare(
            `SELECT result_json FROM job_matches WHERE user_id = ? AND content_hash = ? AND content_hash != '' AND created_at >= datetime('now', ?) ORDER BY created_at DESC LIMIT 1`
        ).get(req.user.id, contentHash, `-${COMPARE_CACHE_TTL_MINUTES} minutes`)
        if (cached) {
            let data = {}
            try { data = JSON.parse(cached.result_json) } catch {}
            return res.json({ ...data, cached: true })
        }
    }

    let engineProvider, apiKey
    try {
        ({ engineProvider, apiKey } = resolveProviderForRequest(req.user.id, provider))
    } catch (err) {
        if (err instanceof ProviderResolutionError) return res.status(err.status).json({ error: err.message })
        throw err
    }

    const engineUrl = req.app.locals.engineUrl
    try {
        const engineRes = await fetchEngineWithRetry(`${engineUrl}/compare-resume-jd`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                resume_text: resumeText,
                jd_text: jdText,
                provider: engineProvider,
                local_endpoint: localEndpoint,
                api_key: apiKey,
            }),
        })
        if (!engineRes.ok) return res.status(engineRes.status).json(await engineRes.json())
        const data = await engineRes.json()
        const saved = db.prepare(
            "INSERT INTO job_matches (user_id, job_description_id, analysis_id, result_json, content_hash, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
        ).run(req.user.id, jobId, analysisId, JSON.stringify(data), contentHash)
        res.json({ ...data, match_id: saved.lastInsertRowid })
    } catch (err) {
        res.status(500).json({ error: "Comparison failed. Please try again." })
    }
})

export default router
