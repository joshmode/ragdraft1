import { Router } from "express"
import fetch from "node-fetch"
import { authenticateToken } from "../middleware/auth.js"
import { getDb } from "../db.js"
import { getOwnedAnalysis } from "../access.js"
import { fetchEngineWithRetry } from "../engineClient.js"
import { llmLimiter } from "../middleware/rateLimit.js"
import { resolveProviderForRequest, ProviderResolutionError } from "../userKeys.js"

const router = Router()
const PROVIDER_CHOICES = new Set(["default", "gemini", "claude", "chatgpt", "local"])

// builds the payload fresh so a client can't smuggle its own api_key/model in
function buildEnginePayload(req, res, extraFields) {
    const provider = req.body.provider
    if (!PROVIDER_CHOICES.has(provider)) {
        res.status(400).json({ error: "Unknown provider." })
        return null
    }
    if (provider === "local" && process.env.ALLOW_LOCAL_PROVIDER !== "true") {
        res.status(403).json({ error: "Local model endpoints are disabled for this deployment." })
        return null
    }
    try {
        const { engineProvider, apiKey } = resolveProviderForRequest(req.user.id, provider)
        return {
            resume_json: req.body.resume_json,
            job_description: req.body.job_description || "",
            provider: engineProvider,
            local_endpoint: req.body.local_endpoint || "",
            api_key: apiKey,
            ...extraFields,
        }
    } catch (err) {
        if (err instanceof ProviderResolutionError) {
            res.status(err.status).json({ error: err.message })
            return null
        }
        throw err
    }
}

router.post("/cv", llmLimiter, authenticateToken, async (req, res) => {
    if (req.body.analysis_id && !getOwnedAnalysis(req.body.analysis_id, req.user.id)) {
        return res.status(404).json({ error: "Analysis not found." })
    }
    const enginePayload = buildEnginePayload(req, res, {
        acc_map: req.body.acc_map || {},
        rewrite_suggestions: req.body.rewrite_suggestions || null,
        rewrite_decisions: req.body.rewrite_decisions || null,
    })
    if (!enginePayload) return

    const engineUrl = req.app.locals.engineUrl
    try {
        const engineRes = await fetchEngineWithRetry(`${engineUrl}/gen-cv`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(enginePayload),
        })
        if (!engineRes.ok) return res.status(engineRes.status).json(await engineRes.json())
        const data = await engineRes.json()
        if (req.body.analysis_id) {
            getDb().prepare(
                "INSERT INTO generated_documents (analysis_id, user_id, document_type, content, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
            ).run(req.body.analysis_id, req.user.id, "cv", data.cv_text || "")
        }
        res.json(data)
    } catch (err) {
        res.status(500).json({ error: `CV generation failed: ${err.message}` })
    }
})

router.post("/cover-letter", llmLimiter, authenticateToken, async (req, res) => {
    if (req.body.analysis_id && !getOwnedAnalysis(req.body.analysis_id, req.user.id)) {
        return res.status(404).json({ error: "Analysis not found." })
    }
    const enginePayload = buildEnginePayload(req, res, {})
    if (!enginePayload) return

    const engineUrl = req.app.locals.engineUrl
    try {
        const engineRes = await fetchEngineWithRetry(`${engineUrl}/gen-cover-letter`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(enginePayload),
        })
        if (!engineRes.ok) return res.status(engineRes.status).json(await engineRes.json())
        const data = await engineRes.json()
        if (req.body.analysis_id) {
            getDb().prepare(
                "INSERT INTO generated_documents (analysis_id, user_id, document_type, content, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
            ).run(req.body.analysis_id, req.user.id, "cover_letter", data.cover_letter_text || "")
        }
        res.json(data)
    } catch (err) {
        res.status(500).json({ error: `Cover letter generation failed: ${err.message}` })
    }
})

async function exportDocument(req, res, path, type) {
    const engineUrl = req.app.locals.engineUrl
    try {
        const engineRes = await fetch(`${engineUrl}/${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: req.body.text || "" }),
        })
        if (!engineRes.ok) return res.status(engineRes.status).json(await engineRes.json())
        const data = Buffer.from(await engineRes.arrayBuffer())
        res.setHeader("Content-Type", type)
        const filename = String(req.body.filename || "ragstoriches_document").replace(/[^a-zA-Z0-9._-]/g, "_")
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`)
        res.send(data)
    } catch (err) {
        res.status(500).json({ error: `Document export failed: ${err.message}` })
    }
}

// so switching tabs restores the last generated doc instead of forcing a regenerate
router.get("/latest", authenticateToken, (req, res) => {
    const analysisId = parseInt(req.query.analysis_id)
    if (!analysisId || !getOwnedAnalysis(analysisId, req.user.id)) {
        return res.status(404).json({ error: "Analysis not found." })
    }
    const db = getDb()
    const docs = {}
    for (const type of ["cv", "cover_letter"]) {
        const row = db.prepare(
            "SELECT content, created_at FROM generated_documents WHERE analysis_id = ? AND user_id = ? AND document_type = ? ORDER BY created_at DESC, id DESC LIMIT 1"
        ).get(analysisId, req.user.id, type)
        if (row) docs[type] = { content: row.content, created_at: row.created_at }
    }
    res.json(docs)
})

router.post("/docx", authenticateToken, (req, res) => exportDocument(req, res, "export-docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
router.post("/pdf", authenticateToken, (req, res) => exportDocument(req, res, "export-pdf", "application/pdf"))

export default router
