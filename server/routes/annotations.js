import { Router } from "express"
import { getDb } from "../db.js"
import { authenticateToken } from "../middleware/auth.js"
import { canAccessAnalysis } from "../access.js"

const router = Router()

router.get("/:analysisId", authenticateToken, (req, res) => {
    if (!canAccessAnalysis(req.params.analysisId, req.user)) {
        return res.status(404).json({ error: "Analysis not found." })
    }
    const db = getDb()
    const rows = db.prepare(
        "SELECT a.id, a.suggestion_key, a.comment, a.created_at, u.display_name FROM annotations a JOIN users u ON a.user_id = u.id WHERE a.analysis_id = ? ORDER BY a.created_at ASC"
    ).all(req.params.analysisId)

    res.json(rows.map(r => ({
        id: r.id,
        key: r.suggestion_key,
        comment: r.comment,
        user: r.display_name,
        time: r.created_at,
    })))
})

router.post("/", authenticateToken, (req, res) => {
    const { analysis_id, suggestion_key, comment } = req.body

    if (!analysis_id || !suggestion_key || !comment?.trim()) {
        return res.status(400).json({ error: "analysis_id, suggestion_key, and comment are required." })
    }
    if (!canAccessAnalysis(analysis_id, req.user)) {
        return res.status(404).json({ error: "Analysis not found." })
    }

    const db = getDb()
    const stmt = db.prepare(
        "INSERT INTO annotations (analysis_id, user_id, suggestion_key, comment, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
    )
    const result = stmt.run(analysis_id, req.user.id, suggestion_key, comment.trim())

    res.status(201).json({ id: result.lastInsertRowid, ok: true })
})

export default router
