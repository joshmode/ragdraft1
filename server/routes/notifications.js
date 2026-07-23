import { Router } from "express"
import { getDb } from "../db.js"
import { authenticateToken } from "../middleware/auth.js"

const router = Router()

// single lightweight endpoint driving every unread badge (nav, sidebar buttons, mentor
// dashboard candidate names, per-row history highlighting) instead of one call per badge -
// the candidate_id comes from a join since a notification only ever stores analysis_id,
// but mentor-side badges need to group unread counts per candidate
router.get("/summary", authenticateToken, (req, res) => {
    const rows = getDb().prepare(`
        SELECT n.id, n.analysis_id, n.attempt_type, n.event_type, a.user_id AS candidate_id
        FROM notifications n LEFT JOIN analyses a ON a.id = n.analysis_id
        WHERE n.user_id = ? AND n.read = 0
    `).all(req.user.id)

    const byAttemptType = {}
    const byAnalysisId = {}
    const byCandidateId = {}
    // nested per-candidate, per-workflow breakdown - drives the mentor's "badge beside the
    // Resume Analysis / Cover Letter history toggle (only on the workflow with unread
    // activity)" requirement, which by_candidate_id alone (candidate-level total) can't
    const byCandidateAndType = {}
    for (const r of rows) {
        byAttemptType[r.attempt_type] = (byAttemptType[r.attempt_type] || 0) + 1
        if (r.analysis_id) byAnalysisId[r.analysis_id] = (byAnalysisId[r.analysis_id] || 0) + 1
        if (r.candidate_id) {
            byCandidateId[r.candidate_id] = (byCandidateId[r.candidate_id] || 0) + 1
            const perType = byCandidateAndType[r.candidate_id] || (byCandidateAndType[r.candidate_id] = {})
            perType[r.attempt_type] = (perType[r.attempt_type] || 0) + 1
        }
    }
    res.json({
        unread_total: rows.length,
        by_attempt_type: byAttemptType,
        by_analysis_id: byAnalysisId,
        by_candidate_id: byCandidateId,
        by_candidate_and_type: byCandidateAndType,
    })
})

// "viewing the attempt clears unread state" - marks every unread notification this user
// owns that's linked to that one attempt as read, so re-opening it later can raise a fresh
// unread badge if new activity happens after this view
router.post("/mark-read", authenticateToken, (req, res) => {
    const analysisId = req.body.analysis_id ? parseInt(req.body.analysis_id) : null
    if (!analysisId) return res.status(400).json({ error: "analysis_id is required." })
    getDb().prepare(
        "UPDATE notifications SET read = 1 WHERE user_id = ? AND analysis_id = ? AND read = 0"
    ).run(req.user.id, analysisId)
    res.json({ ok: true })
})

export default router
