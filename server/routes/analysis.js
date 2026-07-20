import { Router } from "express"
import multer from "multer"
import crypto from "crypto"
import fetch from "node-fetch"
import { getDb } from "../db.js"
import { authenticateToken } from "../middleware/auth.js"
import { canAccessAnalysis, getOwnedAnalysis, getOwnedResume } from "../access.js"
import { pollLimiter } from "../middleware/rateLimit.js"
import { fetchEngineWithRetry } from "../engineClient.js"

const router = Router()
const ANALYSIS_CACHE_TTL_MINUTES = parseInt(process.env.ANALYSIS_CACHE_TTL_MINUTES || "60", 10)

// Re-running the exact same resume + job description + provider/model +
// critic setting produces the exact same result, so we key a short-lived
// cache on all of it — re-clicking "Analyse" without changing anything skips
// the LLM entirely instead of burning API quota on identical output.
function analysisContentHash({ resumeId, jobDescription, provider, model, useCritic }) {
    return crypto.createHash("sha256")
        .update(`${resumeId}|${provider || ""}|${model || ""}|${useCritic ? "1" : "0"}|${jobDescription || ""}`)
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
        if (!parseRes.ok) {
            throw new Error((await parseRes.json()).error || "The file could not be parsed.")
        }
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
        res.status(500).json({ error: `Parse failed: ${err.message}` })
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
        // fetchEngineWithRetry rides out a transient provider rate limit (the
        // engine already retries individual LLM calls internally — this
        // covers the case where the whole analysis exhausts those retries)
        // with exponential backoff + jitter, so a busy provider doesn't fail
        // the job outright and force the user to manually retry.
        const analyseRes = await fetchEngineWithRetry(`${engineUrl}/analyse`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        })
        if (!analyseRes.ok) throw new Error((await analyseRes.json()).error || "Analysis failed.")
        const results = await analyseRes.json()
        results.parsed_resume = payload.resume_json
        results.job_description = payload.job_description || ""
        const scoreTotal = typeof results.score === "object" ? results.score.total || 0 : results.score || 0
        const contentHash = analysisContentHash({
            resumeId: payload.resume_id, jobDescription: payload.job_description,
            provider: payload.provider, model: payload.model, useCritic: payload.use_critic,
        })
        const row = db.prepare(
            "INSERT INTO analyses (resume_id, user_id, results_json, job_description, provider, model, score_total, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
        ).run(
            payload.resume_id, payload.user_id, JSON.stringify(results), payload.job_description || "",
            payload.provider || "", payload.model || "", scoreTotal, contentHash,
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

router.post("/run", authenticateToken, (req, res) => {
    const { resume_json, job_description, provider, model, use_critic, local_endpoint, resume_id } = req.body
    const resumeId = parseInt(resume_id)
    if (!resumeId || !getOwnedResume(resumeId, req.user.id)) {
        return res.status(404).json({ error: "Resume not found." })
    }
    if (provider === "local" && process.env.ALLOW_LOCAL_PROVIDER !== "true") {
        return res.status(403).json({ error: "Local model endpoints are disabled for this deployment." })
    }

    const payload = { resume_id: resumeId, user_id: req.user.id, resume_json, job_description, provider, model, use_critic, local_endpoint }
    const db = getDb()

    if (ANALYSIS_CACHE_TTL_MINUTES > 0) {
        const contentHash = analysisContentHash({ resumeId, jobDescription: job_description, provider, model, useCritic: use_critic })
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

router.get("/jobs/:jobId", pollLimiter, authenticateToken, (req, res) => {
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

router.post("/highlight", pollLimiter, authenticateToken, async (req, res) => {
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
        res.status(500).json({ error: `PDF highlighting failed: ${err.message}` })
    }
})

router.get("/history", authenticateToken, (req, res) => {
    const db = getDb()
    const rows = db.prepare(
        "SELECT id, resume_id, score_total, provider, model, created_at FROM analyses WHERE user_id = ? ORDER BY created_at DESC LIMIT 50"
    ).all(req.user.id)

    res.json(rows.map(r => ({
        id: r.id,
        resume_id: r.resume_id,
        score: r.score_total,
        provider: r.provider,
        model: r.model,
        created_at: r.created_at,
    })))
})

router.get("/analytics/overview", authenticateToken, (req, res) => {
    const db = getDb()
    const rows = db.prepare(
        "SELECT id, resume_id, results_json, score_total, provider, model, created_at FROM analyses WHERE user_id = ? ORDER BY created_at ASC LIMIT 50"
    ).all(req.user.id)
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

router.get("/analytics/delta", authenticateToken, (req, res) => {
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
    res.json({ id: row.id, resume_id: row.resume_id, score: row.score_total, provider: row.provider, model: row.model, created_at: row.created_at, results })
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
