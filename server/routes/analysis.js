import { Router } from "express"
import multer from "multer"
import crypto from "crypto"
import fetch from "node-fetch"
import { getDb } from "../db.js"
import { authenticateToken } from "../middleware/auth.js"
import { canAccessAnalysis, getOwnedAnalysis, getOwnedResume } from "../access.js"
import { pollLimiter, llmLimiter } from "../middleware/rateLimit.js"
import { fetchEngineWithRetry } from "../engineClient.js"
import { resolveProviderForRequest, ProviderResolutionError } from "../userKeys.js"

const router = Router()
const ANALYSIS_CACHE_TTL_MINUTES = parseInt(process.env.ANALYSIS_CACHE_TTL_MINUTES || "60", 10)
const PROVIDER_CHOICES = new Set(["default", "gemini", "claude", "chatgpt", "local"])

// same resume+jd+provider+critic+endpoint = same result, so cache on it and skip the LLM.
// localEndpoint has to be part of the key: for provider "local" it's what actually picks
// the model, and two different endpoints must never share a cached result.
function analysisContentHash({ resumeId, jobDescription, provider, model, useCritic, localEndpoint }) {
    return crypto.createHash("sha256")
        .update(`${resumeId}|${provider || ""}|${model || ""}|${useCritic ? "1" : "0"}|${localEndpoint || ""}|${jobDescription || ""}`)
        .digest("hex")
}
const allowedExtensions = new Set([".pdf", ".docx", ".doc", ".odt", ".txt", ".md", ".zip"])
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const name = file.originalname.toLowerCase()
        const ext = name.slice(name.lastIndexOf("."))
        cb(allowedExtensions.has(ext) ? null : new Error("Unsupported resume format."), allowedExtensions.has(ext))
    },
})

router.post("/upload", authenticateToken, upload.single("file"), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No file uploaded." })
    }

    const engineUrl = req.app.locals.engineUrl
    const fileB64 = req.file.buffer.toString("base64")

    try {
        const parseRes = await fetch(`${engineUrl}/parse`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file: fileB64, filename: req.file.originalname }),
        })
        // forward the engine's own curated error response directly (same pattern as every
        // other engine-backed route below) instead of re-wrapping it in a generic Error,
        // so a genuinely unexpected failure (network/DB) below isn't confused with one
        if (!parseRes.ok) return res.status(parseRes.status).json(await parseRes.json())
        const parsed = await parseRes.json()

        const db = getDb()
        const stmt = db.prepare(
            "INSERT INTO resumes (user_id, filename, raw_bytes, parsed_json, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        )
        const result = stmt.run(req.user.id, req.file.originalname, req.file.buffer, JSON.stringify(parsed.sections))

        res.json({
            resume_id: result.lastInsertRowid,
            parsed,
            filename: req.file.originalname,
        })
    } catch (err) {
        res.status(500).json({ error: "The file could not be parsed. Please try a different file." })
    }
})

router.use((err, _req, res, next) => {
    if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "Resume files must be 25 MB or smaller." : err.message })
    }
    if (err) return res.status(400).json({ error: err.message || "Upload failed." })
    next()
})

async function processAnalysis(engineUrl, jobId, payload) {
    const db = getDb()
    db.prepare("UPDATE analysis_jobs SET status = 'running', updated_at = datetime('now') WHERE id = ?").run(jobId)
    try {
        // resolved fresh here, never stored - request_json only ever holds the provider choice
        const { engineProvider, apiKey } = resolveProviderForRequest(payload.user_id, payload.provider)
        const enginePayload = {
            resume_json: payload.resume_json,
            job_description: payload.job_description,
            provider: engineProvider,
            use_critic: payload.use_critic,
            local_endpoint: payload.local_endpoint,
            api_key: apiKey,
        }

        const analyseRes = await fetchEngineWithRetry(`${engineUrl}/analyse`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(enginePayload),
        })
        if (!analyseRes.ok) throw new Error((await analyseRes.json()).error || "Analysis failed.")
        const results = await analyseRes.json()
        results.parsed_resume = payload.resume_json
        results.job_description = payload.job_description || ""
        const scoreTotal = typeof results.score === "object" ? results.score.total || 0 : results.score || 0
        const contentHash = analysisContentHash({
            resumeId: payload.resume_id, jobDescription: payload.job_description,
            provider: payload.provider, model: "", useCritic: payload.use_critic,
            localEndpoint: payload.local_endpoint,
        })
        const row = db.prepare(
            "INSERT INTO analyses (resume_id, user_id, results_json, job_description, provider, model, score_total, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
        ).run(
            payload.resume_id, payload.user_id, JSON.stringify(results), payload.job_description || "",
            payload.provider || "", "", scoreTotal, contentHash,
        )
        results.analysis_id = row.lastInsertRowid
        results.resume_id = payload.resume_id
        db.prepare("UPDATE analyses SET results_json = ? WHERE id = ?").run(JSON.stringify(results), row.lastInsertRowid)
        db.prepare(
            "UPDATE analysis_jobs SET status = 'completed', analysis_id = ?, error = '', updated_at = datetime('now') WHERE id = ?"
        ).run(row.lastInsertRowid, jobId)
    } catch (err) {
        db.prepare(
            "UPDATE analysis_jobs SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(String(err.message || err).slice(0, 2000), jobId)
    }
}

router.post("/run", authenticateToken, llmLimiter, (req, res) => {
    const { resume_json, job_description, provider, use_critic, local_endpoint, resume_id } = req.body
    const resumeId = parseInt(resume_id)
    if (!resumeId || !getOwnedResume(resumeId, req.user.id)) {
        return res.status(404).json({ error: "Resume not found." })
    }
    if (!PROVIDER_CHOICES.has(provider)) {
        return res.status(400).json({ error: "Unknown provider." })
    }
    if (provider === "local" && process.env.ALLOW_LOCAL_PROVIDER !== "true") {
        return res.status(403).json({ error: "Local model endpoints are disabled for this deployment." })
    }
    // fail fast if a BYOK provider has no key, instead of queueing and failing later
    try {
        resolveProviderForRequest(req.user.id, provider)
    } catch (err) {
        if (err instanceof ProviderResolutionError) return res.status(err.status).json({ error: err.message })
        throw err
    }

    // model is fixed per provider server-side now — never client-selected.
    const payload = { resume_id: resumeId, user_id: req.user.id, resume_json, job_description, provider, use_critic, local_endpoint }
    const db = getDb()

    if (ANALYSIS_CACHE_TTL_MINUTES > 0) {
        const contentHash = analysisContentHash({ resumeId, jobDescription: job_description, provider, model: "", useCritic: use_critic, localEndpoint: local_endpoint })
        const cached = db.prepare(
            `SELECT id FROM analyses WHERE user_id = ? AND content_hash = ? AND content_hash != '' AND created_at >= datetime('now', ?) ORDER BY created_at DESC LIMIT 1`
        ).get(req.user.id, contentHash, `-${ANALYSIS_CACHE_TTL_MINUTES} minutes`)
        if (cached) {
            const cachedRow = db.prepare(
                "INSERT INTO analysis_jobs (resume_id, user_id, request_json, status, analysis_id, created_at, updated_at) VALUES (?, ?, ?, 'completed', ?, datetime('now'), datetime('now'))"
            ).run(resumeId, req.user.id, JSON.stringify(payload), cached.id)
            return res.status(202).json({ job_id: cachedRow.lastInsertRowid, status: "queued" })
        }
    }

    const row = db.prepare(
        "INSERT INTO analysis_jobs (resume_id, user_id, request_json, status, created_at, updated_at) VALUES (?, ?, ?, 'queued', datetime('now'), datetime('now'))"
    ).run(resumeId, req.user.id, JSON.stringify(payload))
    processAnalysis(req.app.locals.engineUrl, row.lastInsertRowid, payload)
    res.status(202).json({ job_id: row.lastInsertRowid, status: "queued" })
})

// shared by the Fast Cover Letter Workflow and the JD-refresh path below: the lightweight
// keyword-gap the engine's /compare-resume-jd endpoint already produces for Job Matching,
// reshaped into the same jd_keywords/missing_keywords fields KeywordGap expects - this never
// touches analyse()'s own (separate, heavier) JD-keyword-extraction step
async function computeKeywordGapFields(engineUrl, resumeJson, jobDescription, engineProvider, localEndpoint, apiKey) {
    if (!jobDescription || !jobDescription.trim()) return {}
    try {
        const res = await fetchEngineWithRetry(`${engineUrl}/compare-resume-jd`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                resume_text: resumeJson?.raw_text || "", jd_text: jobDescription,
                provider: engineProvider, local_endpoint: localEndpoint || "", api_key: apiKey,
            }),
        })
        if (!res.ok) return {}
        const data = await res.json()
        return {
            jd_keywords: [...(data.strong_matches || []), ...(data.missing_skills || [])],
            missing_keywords: data.missing_skills || [],
            match_pct: data.match_pct || 0,
            strong_matches: data.strong_matches || [],
            tailoring_tips: data.tailoring_tips || [],
            company: data.company || "",
        }
    } catch {
        return {}
    }
}

// Fast Cover Letter Workflow (Phase Y): a "cover_letter_only" attempt never touches
// analyse() at all - no rewrite suggestions, no scoring, no keyword-gap, no embeddings - it's
// exactly the one gen-cover-letter LLM call /generate/cover-letter already makes, so this
// stays a plain synchronous request/response instead of inventing a job/polling flow. It still
// creates a real (minimal) analyses row so the result can reuse generated_documents/history/
// attempt-numbering unmodified rather than forking a parallel storage path for it.
router.post("/quick-cover-letter", authenticateToken, llmLimiter, async (req, res) => {
    const { resume_json, job_description, provider, local_endpoint, resume_id, company } = req.body
    const resumeId = parseInt(resume_id)
    if (!resumeId || !getOwnedResume(resumeId, req.user.id)) {
        return res.status(404).json({ error: "Resume not found." })
    }
    if (!PROVIDER_CHOICES.has(provider)) {
        return res.status(400).json({ error: "Unknown provider." })
    }
    if (provider === "local" && process.env.ALLOW_LOCAL_PROVIDER !== "true") {
        return res.status(403).json({ error: "Local model endpoints are disabled for this deployment." })
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
        const engineRes = await fetchEngineWithRetry(`${engineUrl}/gen-cover-letter`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                resume_json, job_description: job_description || "",
                provider: engineProvider, local_endpoint: local_endpoint || "", api_key: apiKey,
            }),
        })
        if (!engineRes.ok) return res.status(engineRes.status).json(await engineRes.json())
        const data = await engineRes.json()
        // the one other piece of data this workflow is explicitly allowed to produce -
        // Keyword Gap - via the same lightweight compare-resume-jd call Job Matching already
        // uses, never analyse()'s own (much heavier) JD-keyword-extraction step
        const keywordGap = await computeKeywordGapFields(engineUrl, resume_json, job_description, engineProvider, local_endpoint, apiKey)

        const db = getDb()
        // only what's actually derivable without running analyse() at all: the parsed
        // resume + its extracted sections (parsing already happened at upload time) plus the
        // lightweight keyword gap above - never rewrites/score/bullet data, since none of that
        // pipeline (or ATS scoring/analytics) ever ran for this attempt
        const resultsForStorage = {
            // contact/sections mirror the top-level shape a full analyse() response has (see
            // analyser.py), so ResultsSidebar/ExtractedSections/etc. work unmodified - both are
            // fully derivable from parsing alone, no analyse() run required
            contact: resume_json?.contact || {},
            sections: resume_json?.sections || {},
            parsed_resume: resume_json,
            job_description: job_description || "",
            attempt_type: "cover_letter_only",
            ...keywordGap,
        }
        const row = db.prepare(
            "INSERT INTO analyses (resume_id, user_id, results_json, job_description, provider, model, score_total, content_hash, attempt_type, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, '', 'cover_letter_only', datetime('now'))"
        ).run(resumeId, req.user.id, JSON.stringify(resultsForStorage), job_description || "", provider || "", "")
        const analysisId = row.lastInsertRowid
        resultsForStorage.analysis_id = analysisId
        resultsForStorage.resume_id = resumeId
        db.prepare("UPDATE analyses SET results_json = ? WHERE id = ?").run(JSON.stringify(resultsForStorage), analysisId)
        db.prepare(
            "INSERT INTO generated_documents (analysis_id, user_id, document_type, content, company, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
        ).run(analysisId, req.user.id, "cover_letter", data.cover_letter_text || "", String(company || "").slice(0, 200))

        res.json({ analysis_id: analysisId, cover_letter_text: data.cover_letter_text || "", results: resultsForStorage })
    } catch (err) {
        res.status(500).json({ error: "Cover letter generation failed. Please try again." })
    }
})

// Smart Cache Reuse, Case A (resume unchanged, JD changed): the resume is the source of
// truth for cache invalidation, not the JD - so changing only the JD never reruns the
// expensive Resume Analysis pipeline. This updates the SAME analyses row in place (same
// attempt, same id) and only regenerates the two things that actually depend on the JD -
// Keyword Gap and Cover Letter - while rewrites/score/sections/analytics stay exactly as
// they were. Used by both the Cover Letter page's "Change Job Description" action and Job
// Matching's "Generate Cover Letter" shortcut.
router.post("/:id/refresh-jd", authenticateToken, llmLimiter, async (req, res) => {
    const analysisId = parseInt(req.params.id)
    const row = getOwnedAnalysis(analysisId, req.user.id)
    if (!row) return res.status(404).json({ error: "Analysis not found." })
    const { job_description, provider, local_endpoint, company } = req.body
    if (!PROVIDER_CHOICES.has(provider)) {
        return res.status(400).json({ error: "Unknown provider." })
    }
    if (provider === "local" && process.env.ALLOW_LOCAL_PROVIDER !== "true") {
        return res.status(403).json({ error: "Local model endpoints are disabled for this deployment." })
    }
    let results = {}
    try { results = JSON.parse(row.results_json) } catch {}
    const resumeJson = results.parsed_resume
    if (!resumeJson) return res.status(409).json({ error: "This attempt has no stored resume data to regenerate against." })

    let engineProvider, apiKey
    try {
        ({ engineProvider, apiKey } = resolveProviderForRequest(req.user.id, provider))
    } catch (err) {
        if (err instanceof ProviderResolutionError) return res.status(err.status).json({ error: err.message })
        throw err
    }

    const engineUrl = req.app.locals.engineUrl
    try {
        const jd = job_description || ""
        const engineRes = await fetchEngineWithRetry(`${engineUrl}/gen-cover-letter`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ resume_json: resumeJson, job_description: jd, provider: engineProvider, local_endpoint: local_endpoint || "", api_key: apiKey }),
        })
        if (!engineRes.ok) return res.status(engineRes.status).json(await engineRes.json())
        const data = await engineRes.json()
        const keywordGap = await computeKeywordGapFields(engineUrl, resumeJson, jd, engineProvider, local_endpoint, apiKey)

        const db = getDb()
        const updatedResults = { ...results, job_description: jd, ...keywordGap }
        if (!jd.trim()) { updatedResults.jd_keywords = []; updatedResults.missing_keywords = [] }
        // only a resume_analysis row's content_hash feeds /run's cache-hit lookup - keep a
        // cover_letter_only row's hash untouched ('') since it was never eligible there anyway
        const newHash = row.attempt_type === "cover_letter_only" ? row.content_hash
            : analysisContentHash({ resumeId: row.resume_id, jobDescription: jd, provider, model: row.model, useCritic: false, localEndpoint: local_endpoint })
        db.prepare("UPDATE analyses SET job_description = ?, content_hash = ?, results_json = ? WHERE id = ?")
            .run(jd, newHash, JSON.stringify(updatedResults), analysisId)
        db.prepare(
            "INSERT INTO generated_documents (analysis_id, user_id, document_type, content, company, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
        ).run(analysisId, req.user.id, "cover_letter", data.cover_letter_text || "", String(company || "").slice(0, 200))

        res.json({ analysis_id: analysisId, cover_letter_text: data.cover_letter_text || "", results: updatedResults })
    } catch (err) {
        res.status(500).json({ error: "Cover letter regeneration failed. Please try again." })
    }
})

router.get("/jobs/:jobId", authenticateToken, pollLimiter, (req, res) => {
    const db = getDb()
    const job = db.prepare("SELECT * FROM analysis_jobs WHERE id = ? AND user_id = ?").get(req.params.jobId, req.user.id)
    if (!job) return res.status(404).json({ error: "Analysis job not found." })
    if (job.status === "completed" && job.analysis_id) {
        const analysis = getOwnedAnalysis(job.analysis_id, req.user.id)
        let results = {}
        try { results = JSON.parse(analysis.results_json) } catch {}
        return res.json({ id: job.id, status: job.status, analysis_id: job.analysis_id, results })
    }
    res.json({ id: job.id, status: job.status, error: job.error || "" })
})

router.post("/highlight", authenticateToken, pollLimiter, async (req, res) => {
    const engineUrl = req.app.locals.engineUrl
    try {
        const engineRes = await fetch(`${engineUrl}/highlight-pdf`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(req.body),
        })
        if (!engineRes.ok) return res.status(engineRes.status).json(await engineRes.json())
        const data = Buffer.from(await engineRes.arrayBuffer())
        res.setHeader("Content-Type", "application/pdf")
        res.setHeader("X-Active-Page", engineRes.headers.get("x-active-page") || "")
        res.send(data)
    } catch (err) {
        res.status(500).json({ error: "PDF highlighting failed. Please try again." })
    }
})

router.get("/history", authenticateToken, (req, res) => {
    const db = getDb()
    const rows = db.prepare(
        "SELECT id, resume_id, score_total, provider, model, attempt_type, created_at FROM analyses WHERE user_id = ? ORDER BY created_at DESC LIMIT 50"
    ).all(req.user.id)

    res.json(rows.map(r => ({
        id: r.id,
        resume_id: r.resume_id,
        score: r.score_total,
        provider: r.provider,
        model: r.model,
        attempt_type: r.attempt_type || "resume_analysis",
        created_at: r.created_at,
    })))
})

router.get("/insights/overview", authenticateToken, (req, res) => {
    const db = getDb()
    // the outer ORDER BY re-sorts back to ascending (oldest of the most-recent-50 first) -
    // the Insights view indexes this array assuming the LAST entry is the latest attempt
    // (see its "most improved section" comparison), so a plain "ORDER BY created_at ASC
    // LIMIT 50" would instead freeze on a user's *oldest* 50 attempts forever past that point
    // cover-letter-only attempts were never scored/rewritten/keyword-matched - they have no
    // trend data to contribute here and would otherwise show up as fake zero-score points
    const rows = db.prepare(`
        SELECT * FROM (
            SELECT id, resume_id, results_json, score_total, provider, model, created_at
            FROM analyses WHERE user_id = ? AND attempt_type != 'cover_letter_only' ORDER BY created_at DESC LIMIT 50
        ) ORDER BY created_at ASC
    `).all(req.user.id)
    const analyses = rows.map(row => {
        let results = {}
        try { results = JSON.parse(row.results_json) } catch {}
        return {
            id: row.id,
            resume_id: row.resume_id,
            score: results.score || { total: row.score_total },
            timing: results.timing || {},
            provider: row.provider,
            model: row.model,
            created_at: row.created_at,
        }
    })
    res.json({ analyses })
})

router.get("/insights/delta", authenticateToken, (req, res) => {
    const from = getOwnedAnalysis(req.query.from, req.user.id)
    const to = getOwnedAnalysis(req.query.to, req.user.id)
    if (!from || !to) return res.status(404).json({ error: "Analysis not found." })
    let fromResults = {}
    let toResults = {}
    try { fromResults = JSON.parse(from.results_json) } catch {}
    try { toResults = JSON.parse(to.results_json) } catch {}
    const before = fromResults.score || {}
    const after = toResults.score || {}
    const keys = ["total", "base", "sections", "keywords", "bullet_quality", "action_verbs", "warnings"]
    const delta = Object.fromEntries(keys.map(key => [key, (after[key] || 0) - (before[key] || 0)]))
    res.json({ from: from.id, to: to.id, delta })
})

router.get("/resumes", authenticateToken, (req, res) => {
    const db = getDb()
    const rows = db.prepare(
        "SELECT id, filename, created_at FROM resumes WHERE user_id = ? ORDER BY created_at DESC"
    ).all(req.user.id)
    res.json(rows)
})

// self-service raw file fetch, so a candidate reopening a past attempt from Attempt History
// can restore the exact resume file it was generated from (the live `file` state may
// currently hold a different upload) - mirrors mentor.js's candidate-file route, minus the
// PDF-only restriction since the caller here decides how to type/use the bytes
router.get("/resumes/:resumeId/file", authenticateToken, (req, res) => {
    const resume = getOwnedResume(req.params.resumeId, req.user.id)
    if (!resume) return res.status(404).json({ error: "Resume not found." })
    res.setHeader("Content-Type", "application/octet-stream")
    res.setHeader("Content-Disposition", `attachment; filename="${resume.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}"`)
    res.send(resume.raw_bytes)
})

router.get("/resumes/:resumeId/history", authenticateToken, (req, res) => {
    if (!getOwnedResume(req.params.resumeId, req.user.id)) {
        return res.status(404).json({ error: "Resume not found." })
    }
    const db = getDb()
    const rows = db.prepare(
        "SELECT id, analysis_id, decisions_json, score_total, created_at FROM revision_snapshots WHERE resume_id = ? ORDER BY created_at ASC"
    ).all(req.params.resumeId)
    res.json(rows.map(row => ({ ...row, decisions: JSON.parse(row.decisions_json || "{}") })))
})

router.get("/:id", authenticateToken, (req, res) => {
    const row = canAccessAnalysis(req.params.id, req.user)
    if (!row) {
        return res.status(404).json({ error: "Analysis not found." })
    }

    let results = {}
    try { results = JSON.parse(row.results_json) } catch {}
    res.json({ id: row.id, resume_id: row.resume_id, score: row.score_total, provider: row.provider, model: row.model, attempt_type: row.attempt_type || "resume_analysis", created_at: row.created_at, results })
})

router.post("/:id/decisions", authenticateToken, (req, res) => {
    const { decisions } = req.body
    const analysisId = parseInt(req.params.id)
    if (!getOwnedAnalysis(analysisId, req.user.id)) {
        return res.status(404).json({ error: "Analysis not found." })
    }
    const db = getDb()

    db.prepare("DELETE FROM rewrite_decisions WHERE analysis_id = ?").run(analysisId)

    const stmt = db.prepare(
        "INSERT INTO rewrite_decisions (analysis_id, suggestion_key, decision, created_at) VALUES (?, ?, ?, datetime('now'))"
    )
    const insertMany = db.transaction((items) => {
        for (const [key, val] of Object.entries(items)) {
            stmt.run(analysisId, key, val ? 1 : 0)
        }
    })
    insertMany(decisions || {})
    const analysis = getOwnedAnalysis(analysisId, req.user.id)
    db.prepare(
        "INSERT INTO revision_snapshots (resume_id, analysis_id, decisions_json, score_total, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run(analysis.resume_id, analysisId, JSON.stringify(decisions || {}), analysis.score_total)
    res.json({ ok: true })
})

router.get("/:id/decisions", authenticateToken, (req, res) => {
    if (!canAccessAnalysis(req.params.id, req.user)) {
        return res.status(404).json({ error: "Analysis not found." })
    }
    const db = getDb()
    const rows = db.prepare("SELECT suggestion_key, decision FROM rewrite_decisions WHERE analysis_id = ?").all(req.params.id)
    const decisions = {}
    for (const r of rows) {
        decisions[r.suggestion_key] = r.decision === 1
    }
    res.json(decisions)
})

router.get("/:id/revisions", authenticateToken, (req, res) => {
    const analysis = canAccessAnalysis(req.params.id, req.user)
    if (!analysis) return res.status(404).json({ error: "Analysis not found." })
    const db = getDb()
    const rows = db.prepare(
        "SELECT id, decisions_json, score_total, created_at FROM revision_snapshots WHERE analysis_id = ? ORDER BY created_at ASC"
    ).all(analysis.id)
    res.json(rows.map(row => ({ ...row, decisions: JSON.parse(row.decisions_json || "{}") })))
})

export default router
