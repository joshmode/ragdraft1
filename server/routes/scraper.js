import { Router } from "express"
import fetch from "node-fetch"
import { authenticateToken } from "../middleware/auth.js"
import { getDb } from "../db.js"
import { getOwnedAnalysis } from "../access.js"

const router = Router()

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
        res.status(500).json({ error: `Scrape failed: ${err.message}` })
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
        const analysisId = req.body.analysis_id ? Number(req.body.analysis_id) : null
        if (analysisId && !getOwnedAnalysis(analysisId, req.user.id)) {
            return res.status(404).json({ error: "Analysis not found." })
        }
        const jobId = req.body.job_id ? Number(req.body.job_id) : null
        if (jobId) {
            const job = getDb().prepare("SELECT id FROM job_descriptions WHERE id = ? AND user_id = ?").get(jobId, req.user.id)
            if (!job) return res.status(404).json({ error: "Job description not found." })
        }
        const saved = getDb().prepare(
            "INSERT INTO job_matches (user_id, job_description_id, analysis_id, result_json, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run(req.user.id, jobId, analysisId, JSON.stringify(data))
        res.json({ ...data, match_id: saved.lastInsertRowid })
    } catch (err) {
        res.status(500).json({ error: `LinkedIn scrape failed: ${err.message}` })
    }
})

router.post("/compare", authenticateToken, async (req, res) => {
    if (req.body.provider === "local" && process.env.ALLOW_LOCAL_PROVIDER !== "true") {
        return res.status(403).json({ error: "Local model endpoints are disabled for this deployment." })
    }
    const analysisId = req.body.analysis_id ? Number(req.body.analysis_id) : null
    if (analysisId && !getOwnedAnalysis(analysisId, req.user.id)) {
        return res.status(404).json({ error: "Analysis not found." })
    }
    const jobId = req.body.job_id ? Number(req.body.job_id) : null
    if (jobId) {
        const job = getDb().prepare("SELECT id FROM job_descriptions WHERE id = ? AND user_id = ?").get(jobId, req.user.id)
        if (!job) return res.status(404).json({ error: "Job description not found." })
    }
    const engineUrl = req.app.locals.engineUrl
    try {
        const engineRes = await fetch(`${engineUrl}/compare-resume-jd`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(req.body),
        })
        if (!engineRes.ok) return res.status(engineRes.status).json(await engineRes.json())
        const data = await engineRes.json()
        const saved = getDb().prepare(
            "INSERT INTO job_matches (user_id, job_description_id, analysis_id, result_json, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run(req.user.id, jobId, analysisId, JSON.stringify(data))
        res.json({ ...data, match_id: saved.lastInsertRowid })
    } catch (err) {
        res.status(500).json({ error: `Comparison failed: ${err.message}` })
    }
})

export default router
