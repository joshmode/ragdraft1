import { Router } from "express"
import { getDb } from "../db.js"
import { authenticateToken } from "../middleware/auth.js"
import { canAccessAnalysis } from "../access.js"

const router = Router()

// this is the collaborative discussion system's backing store: a flat, chronologically
// ordered thread per (analysis_id, suggestion_key) that both the candidate who owns the
// analysis and any mentor with canAccessAnalysis access can read and post to - a "reply" is
// just the next row in the same thread, so no parent_id/threading column is needed for the
// "leave a comment / respond to a reply" flow the discussion UI needs
router.get("/:analysisId", authenticateToken, (req, res) => {
    if (!canAccessAnalysis(req.params.analysisId, req.user)) {
        return res.status(404).json({ error: "Analysis not found." })
    }
    const db = getDb()
    const rows = db.prepare(
        "SELECT a.id, a.suggestion_key, a.section, a.comment, a.created_at, a.user_id, u.display_name, u.role FROM annotations a JOIN users u ON a.user_id = u.id WHERE a.analysis_id = ? ORDER BY a.created_at ASC, a.id ASC"
    ).all(req.params.analysisId)

    res.json(rows.map(r => ({
        id: r.id,
        key: r.suggestion_key,
        section: r.section,
        comment: r.comment,
        user: r.display_name,
        user_id: r.user_id,
        role: r.role,
        time: r.created_at,
    })))
})

router.post("/", authenticateToken, (req, res) => {
    const { analysis_id, suggestion_key, comment, section } = req.body
    // analysis_id is parsed JSON, not just a string/number - an object or array (e.g. a client
    // sending analysis_id: {}) passed straight into better-sqlite3's bind list throws a
    // RangeError synchronously instead of failing validation cleanly below
    const analysisId = (typeof analysis_id === "number" || typeof analysis_id === "string") ? parseInt(analysis_id) : NaN

    if (typeof suggestion_key !== "string" || typeof comment !== "string" ||
        !analysisId || !suggestion_key || !comment.trim()) {
        return res.status(400).json({ error: "analysis_id, suggestion_key, and comment are required." })
    }
    if (!canAccessAnalysis(analysisId, req.user)) {
        return res.status(404).json({ error: "Analysis not found." })
    }

    const db = getDb()
    const stmt = db.prepare(
        "INSERT INTO annotations (analysis_id, user_id, suggestion_key, comment, section, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    )
    const result = stmt.run(analysisId, req.user.id, suggestion_key, comment.trim(), typeof section === "string" ? section.slice(0, 100) : "")

    res.status(201).json({ id: result.lastInsertRowid, ok: true })
})

export default router
