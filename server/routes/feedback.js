import { Router } from "express"
import { getDb } from "../db.js"
import { authenticateToken } from "../middleware/auth.js"
import { getOwnedAnalysis } from "../access.js"

const router = Router()

router.post("/", authenticateToken, (req, res) => {
    const { analysis_id, consent, confidence, comment } = req.body
    if (!consent) return res.status(400).json({ error: "Evaluation consent is required." })
    if (analysis_id && !getOwnedAnalysis(analysis_id, req.user.id)) {
        return res.status(404).json({ error: "Analysis not found." })
    }
    const score = confidence === undefined || confidence === "" ? null : Number(confidence)
    if (score !== null && (!Number.isInteger(score) || score < 1 || score > 5)) {
        return res.status(400).json({ error: "Confidence must be between 1 and 5." })
    }
    const db = getDb()
    const result = db.prepare(
        "INSERT INTO evaluation_feedback (user_id, analysis_id, consent, confidence, comment, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).run(req.user.id, analysis_id || null, 1, score, String(comment || "").trim().slice(0, 2000))
    res.status(201).json({ id: result.lastInsertRowid, ok: true })
})

export default router
