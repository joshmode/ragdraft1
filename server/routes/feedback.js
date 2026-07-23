import { Router } from "express"
import { getDb } from "../db.js"
import { authenticateToken } from "../middleware/auth.js"
import { getOwnedAnalysis } from "../access.js"

const router = Router()

router.post("/", authenticateToken, (req, res) => {
    const { analysis_id, consent, confidence, comment } = req.body
    if (!consent) return res.status(400).json({ error: "Evaluation consent is required." })
    // analysis_id is parsed JSON, not just a string/number - an object or array (e.g. a client
    // sending analysis_id: {}) passed straight into better-sqlite3's bind list throws a
    // RangeError synchronously instead of failing the ownership check below cleanly
    const analysisId = analysis_id ? parseInt(analysis_id) : null
    if (analysis_id && (!analysisId || !getOwnedAnalysis(analysisId, req.user.id))) {
        return res.status(404).json({ error: "Analysis not found." })
    }
    const score = confidence === undefined || confidence === "" ? null : Number(confidence)
    if (score !== null && (!Number.isInteger(score) || score < 1 || score > 5)) {
        return res.status(400).json({ error: "Confidence must be between 1 and 5." })
    }
    const db = getDb()
    const result = db.prepare(
        "INSERT INTO evaluation_feedback (user_id, analysis_id, consent, confidence, comment, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).run(req.user.id, analysisId || null, 1, score, String(comment || "").trim().slice(0, 2000))
    res.status(201).json({ id: result.lastInsertRowid, ok: true })
})

export default router
