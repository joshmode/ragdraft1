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

// bullets where the candidate accepted a mentor's suggested rewrite (an "edit"-type
// mentor_feedback row keyed to that bullet's suggestion_key) must win over the LLM's
// own rewrite in the generated CV - this is the candidate's own explicit decision,
// not the mentor's unilateral override, since it only applies once status='accepted'
function mentorOverridesFor(analysisId, candidateId) {
    if (!analysisId) return {}
    const rows = getDb().prepare(`
        SELECT suggestion_key, suggested_text FROM mentor_feedback
        WHERE analysis_id = ? AND candidate_id = ? AND feedback_type = 'edit'
          AND status = 'accepted' AND suggestion_key != ''
    `).all(analysisId, candidateId)
    return Object.fromEntries(rows.map(r => [r.suggestion_key, r.suggested_text]))
}

// a mentor's Section Edit the candidate has accepted becomes that section's sole source of
// truth (see mentor.js's Section Edit handling) - it takes precedence over every bullet-level
// mechanism above for that section, so the engine skips per-bullet rewrite application
// entirely there and uses this text verbatim instead
function mentorSectionOverridesFor(analysisId, candidateId) {
    if (!analysisId) return {}
    const rows = getDb().prepare(`
        SELECT section, suggested_text FROM mentor_feedback
        WHERE analysis_id = ? AND candidate_id = ? AND feedback_type = 'section_edit'
          AND status = 'accepted' AND section != ''
        ORDER BY updated_at ASC, id ASC
    `).all(analysisId, candidateId)
    // last accepted section edit per section wins if a section was edited more than once
    return Object.fromEntries(rows.map(r => [r.section, r.suggested_text]))
}

// the mentor workspace's "Rewritten Preview" editor (see mentor.js's /preview endpoint) can
// produce a whole-document edit, stored as a single mentor_feedback row keyed
// "preview:<analysisId>" rather than a per-bullet suggestion_key - _apply_rewrites has no
// bullet to match that key against, so a candidate-accepted preview edit has to be applied
// here directly as the entire generated CV, superseding the LLM/per-bullet path entirely
function acceptedPreviewOverride(analysisId, candidateId) {
    if (!analysisId) return null
    const row = getDb().prepare(`
        SELECT suggested_text FROM mentor_feedback
        WHERE analysis_id = ? AND candidate_id = ? AND feedback_type = 'edit'
          AND status = 'accepted' AND suggestion_key = ?
        ORDER BY updated_at DESC, id DESC LIMIT 1
    `).get(analysisId, candidateId, `preview:${analysisId}`)
    return row ? row.suggested_text : null
}

router.post("/cv", authenticateToken, llmLimiter, async (req, res) => {
    // coerced the same way /save and /latest already do below - passing the raw body
    // value straight to better-sqlite3 crashes the whole process if it's ever a non-scalar
    // (e.g. analysis_id: {}), since express doesn't catch a sync throw in an async handler
    const analysisId = req.body.analysis_id ? parseInt(req.body.analysis_id) : null
    if (req.body.analysis_id && (!analysisId || !getOwnedAnalysis(analysisId, req.user.id))) {
        return res.status(404).json({ error: "Analysis not found." })
    }

    const previewOverride = acceptedPreviewOverride(analysisId, req.user.id)
    if (previewOverride !== null) {
        if (analysisId) {
            getDb().prepare(
                "INSERT INTO generated_documents (analysis_id, user_id, document_type, content, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
            ).run(analysisId, req.user.id, "cv", previewOverride)
        }
        return res.json({ cv_text: previewOverride })
    }

    const enginePayload = buildEnginePayload(req, res, {
        acc_map: req.body.acc_map || {},
        rewrite_suggestions: req.body.rewrite_suggestions || null,
        rewrite_decisions: req.body.rewrite_decisions || null,
        mentor_overrides: mentorOverridesFor(analysisId, req.user.id),
        section_overrides: mentorSectionOverridesFor(analysisId, req.user.id),
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
        if (analysisId) {
            getDb().prepare(
                "INSERT INTO generated_documents (analysis_id, user_id, document_type, content, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
            ).run(analysisId, req.user.id, "cv", data.cv_text || "")
        }
        res.json(data)
    } catch (err) {
        res.status(500).json({ error: "CV generation failed. Please try again." })
    }
})

router.post("/cover-letter", authenticateToken, llmLimiter, async (req, res) => {
    const analysisId = req.body.analysis_id ? parseInt(req.body.analysis_id) : null
    if (req.body.analysis_id && (!analysisId || !getOwnedAnalysis(analysisId, req.user.id))) {
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
        if (analysisId) {
            getDb().prepare(
                "INSERT INTO generated_documents (analysis_id, user_id, document_type, content, company, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
            ).run(analysisId, req.user.id, "cover_letter", data.cover_letter_text || "", String(req.body.company || "").slice(0, 200))
        }
        res.json(data)
    } catch (err) {
        res.status(500).json({ error: "Cover letter generation failed. Please try again." })
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

// persists in-place edits to a generated document so the "Saved" indicator is honest
// and a refresh restores the edited text, not just the last-generated text
router.post("/save", authenticateToken, (req, res) => {
    const analysisId = parseInt(req.body.analysis_id)
    const documentType = req.body.document_type
    if (!["cv", "cover_letter"].includes(documentType)) {
        return res.status(400).json({ error: "Unknown document type." })
    }
    if (!analysisId || !getOwnedAnalysis(analysisId, req.user.id)) {
        return res.status(404).json({ error: "Analysis not found." })
    }
    getDb().prepare(
        "INSERT INTO generated_documents (analysis_id, user_id, document_type, content, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run(analysisId, req.user.id, documentType, String(req.body.content ?? ""))
    res.json({ ok: true })
})

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
