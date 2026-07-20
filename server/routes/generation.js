import { Router } from "express"
import fetch from "node-fetch"
import { authenticateToken } from "../middleware/auth.js"
import { getDb } from "../db.js"
import { getOwnedAnalysis } from "../access.js"
import { fetchEngineWithRetry } from "../engineClient.js"

const router = Router()

function rejectLocalProvider(req, res) {
    if (req.body.provider === "local" && process.env.ALLOW_LOCAL_PROVIDER !== "true") {
        res.status(403).json({ error: "Local model endpoints are disabled for this deployment." })
        return true
    }
    return false
}

router.post("/cv", authenticateToken, async (req, res) => {
    if (rejectLocalProvider(req, res)) return
    if (req.body.analysis_id && !getOwnedAnalysis(req.body.analysis_id, req.user.id)) {
        return res.status(404).json({ error: "Analysis not found." })
    }
    const engineUrl = req.app.locals.engineUrl
    try {
        const engineRes = await fetchEngineWithRetry(`${engineUrl}/gen-cv`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(req.body),
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

router.post("/cover-letter", authenticateToken, async (req, res) => {
    if (rejectLocalProvider(req, res)) return
    if (req.body.analysis_id && !getOwnedAnalysis(req.body.analysis_id, req.user.id)) {
        return res.status(404).json({ error: "Analysis not found." })
    }
    const engineUrl = req.app.locals.engineUrl
    try {
        const engineRes = await fetchEngineWithRetry(`${engineUrl}/gen-cover-letter`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(req.body),
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

router.post("/docx", authenticateToken, (req, res) => exportDocument(req, res, "export-docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
router.post("/pdf", authenticateToken, (req, res) => exportDocument(req, res, "export-pdf", "application/pdf"))

export default router
