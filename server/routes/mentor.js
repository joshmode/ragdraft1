import { Router } from "express"
import { getDb } from "../db.js"
import { authenticateToken, requireRole } from "../middleware/auth.js"
import { canAccessAnalysis, mentorSessionForCandidate } from "../access.js"
import crypto from "crypto"

const router = Router()

// classic LCS line diff — enough to show a resume revision like a small PR
function diffLines(before, after) {
    const n = before.length, m = after.length
    const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
        }
    }
    const out = []
    let i = 0, j = 0
    while (i < n && j < m) {
        if (before[i] === after[j]) {
            out.push({ type: "same", text: before[i] }); i++; j++
        } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
            out.push({ type: "removed", text: before[i] }); i++
        } else {
            out.push({ type: "added", text: after[j] }); j++
        }
    }
    while (i < n) out.push({ type: "removed", text: before[i++] })
    while (j < m) out.push({ type: "added", text: after[j++] })
    return out
}

// resume text with accepted rewrites applied, so the diff shows real revisions
function appliedSections(results) {
    const sections = results?.parsed_resume?.sections || results?.sections || {}
    const rewrites = results?.rewrites || {}
    const decisions = results?.decisions || {}
    const out = {}
    for (const [sec, lines] of Object.entries(sections)) {
        const bySuggestion = {}
        for (const item of rewrites[sec] || []) {
            if (decisions[item.id] === true && Array.isArray(item.line_indices) && item.line_indices.length) {
                bySuggestion[item.line_indices[0]] = item
            }
        }
        const applied = []
        let skipUntil = -1
        lines.forEach((line, idx) => {
            if (idx <= skipUntil) return
            const item = bySuggestion[idx]
            if (item) {
                applied.push(item.rewritten || line)
                skipUntil = Math.max(...item.line_indices)
            } else {
                applied.push(line)
            }
        })
        out[sec] = applied
    }
    return out
}

function loadAnalysisWithDecisions(db, analysisId) {
    const row = db.prepare("SELECT * FROM analyses WHERE id = ?").get(analysisId)
    if (!row) return null
    let results = {}
    try { results = JSON.parse(row.results_json) } catch {}
    const decisions = {}
    for (const r of db.prepare("SELECT suggestion_key, decision FROM rewrite_decisions WHERE analysis_id = ?").all(analysisId)) {
        decisions[r.suggestion_key] = r.decision === 1
    }
    results.decisions = decisions
    return { row, results }
}

router.get("/dashboard", authenticateToken, requireRole("mentor"), (req, res) => {
    const db = getDb()

    const sessions = db.prepare(
        "SELECT id, session_code, active, created_at FROM review_sessions WHERE mentor_id = ? ORDER BY created_at DESC"
    ).all(req.user.id)

    const candidates = {}
    for (const sess of sessions) {
        const parts = db.prepare(
            "SELECT u.id, u.username, u.display_name FROM users u JOIN session_participants sp ON sp.user_id = u.id WHERE sp.session_id = ? AND u.role = 'candidate'"
        ).all(sess.id)

        for (const u of parts) {
            if (!candidates[u.id]) {
                const analyses = db.prepare(
                    "SELECT id, score_total, provider, model, created_at FROM analyses WHERE user_id = ? ORDER BY created_at DESC LIMIT 20"
                ).all(u.id)

                const scores = analyses.map(a => a.score_total)
                candidates[u.id] = {
                    id: u.id,
                    name: u.display_name,
                    username: u.username,
                    total_analyses: analyses.length,
                    latest_score: scores[0] || 0,
                    best_score: scores.length ? Math.max(...scores) : 0,
                    scores,
                    analyses,
                }
            }
        }
    }

    const sessionData = sessions.map(s => {
        const participants = db.prepare(
            "SELECT u.id, u.username, u.display_name, u.role FROM users u JOIN session_participants sp ON sp.user_id = u.id WHERE sp.session_id = ?"
        ).all(s.id)
        return { ...s, participants }
    })

    res.json({
        sessions: sessionData,
        candidates: Object.values(candidates),
    })
})

router.post("/session", authenticateToken, requireRole("mentor"), (req, res) => {
    const code = crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 8)
    const db = getDb()
    db.prepare(
        "INSERT INTO review_sessions (mentor_id, session_code, active, created_at) VALUES (?, ?, 1, datetime('now'))"
    ).run(req.user.id, code)

    res.status(201).json({ code })
})

router.post("/session/join", authenticateToken, requireRole("candidate"), (req, res) => {
    const { code } = req.body
    if (!code?.trim()) {
        return res.status(400).json({ error: "Session code is required." })
    }

    const db = getDb()
    const session = db.prepare(
        "SELECT id FROM review_sessions WHERE session_code = ? AND active = 1"
    ).get(code.trim().toUpperCase())

    if (!session) {
        return res.status(404).json({ error: "Invalid or inactive session code." })
    }

    const existing = db.prepare(
        "SELECT id FROM session_participants WHERE session_id = ? AND user_id = ?"
    ).get(session.id, req.user.id)

    if (!existing) {
        db.prepare(
            "INSERT INTO session_participants (session_id, user_id, joined_at) VALUES (?, ?, datetime('now'))"
        ).run(session.id, req.user.id)
    }

    res.json({ ok: true, session_id: session.id })
})

router.post("/session/:code/close", authenticateToken, requireRole("mentor"), (req, res) => {
    const db = getDb()
    const result = db.prepare(
        "UPDATE review_sessions SET active = 0 WHERE session_code = ? AND mentor_id = ?"
    ).run(req.params.code.toUpperCase(), req.user.id)
    if (!result.changes) return res.status(404).json({ error: "Session not found." })
    res.json({ ok: true })
})

router.get("/session/:code/participants", authenticateToken, requireRole("mentor"), (req, res) => {
    const db = getDb()
    const session = db.prepare("SELECT id FROM review_sessions WHERE session_code = ? AND mentor_id = ?").get(req.params.code.toUpperCase(), req.user.id)
    if (!session) {
        return res.status(404).json({ error: "Session not found." })
    }

    const rows = db.prepare(
        "SELECT u.id, u.username, u.display_name, u.role FROM users u JOIN session_participants sp ON sp.user_id = u.id WHERE sp.session_id = ?"
    ).all(session.id)

    res.json(rows)
})

// every analysis + revision snapshot for one candidate
router.get("/candidates/:candidateId/history", authenticateToken, requireRole("mentor"), (req, res) => {
    const candidateId = parseInt(req.params.candidateId)
    if (!mentorSessionForCandidate(req.user.id, candidateId, { activeOnly: false })) {
        return res.status(404).json({ error: "Candidate not found in your review sessions." })
    }
    const db = getDb()
    const analyses = db.prepare(
        "SELECT id, resume_id, score_total, provider, model, job_description, created_at FROM analyses WHERE user_id = ? ORDER BY created_at DESC LIMIT 50"
    ).all(candidateId)
    const snapshots = db.prepare(`
        SELECT rs.id, rs.resume_id, rs.analysis_id, rs.decisions_json, rs.score_total, rs.created_at
        FROM revision_snapshots rs JOIN analyses a ON a.id = rs.analysis_id
        WHERE a.user_id = ? ORDER BY rs.created_at DESC LIMIT 100
    `).all(candidateId)
    res.json({
        analyses,
        revisions: snapshots.map(s => ({ ...s, decisions: JSON.parse(s.decisions_json || "{}") })),
    })
})

// full analysis detail, same shape the candidate sees
router.get("/candidates/:candidateId/analyses/:analysisId", authenticateToken, requireRole("mentor"), (req, res) => {
    const candidateId = parseInt(req.params.candidateId)
    if (!mentorSessionForCandidate(req.user.id, candidateId, { activeOnly: false })) {
        return res.status(404).json({ error: "Candidate not found in your review sessions." })
    }
    const db = getDb()
    const loaded = loadAnalysisWithDecisions(db, parseInt(req.params.analysisId))
    if (!loaded || loaded.row.user_id !== candidateId) {
        return res.status(404).json({ error: "Analysis not found." })
    }
    res.json({
        id: loaded.row.id, score: loaded.row.score_total, provider: loaded.row.provider,
        model: loaded.row.model, created_at: loaded.row.created_at, results: loaded.results,
    })
})

// pr-style per-section diff between two analyses of the same candidate
router.get("/candidates/:candidateId/diff", authenticateToken, requireRole("mentor"), (req, res) => {
    const candidateId = parseInt(req.params.candidateId)
    if (!mentorSessionForCandidate(req.user.id, candidateId, { activeOnly: false })) {
        return res.status(404).json({ error: "Candidate not found in your review sessions." })
    }
    const db = getDb()
    const from = loadAnalysisWithDecisions(db, parseInt(req.query.from))
    const to = loadAnalysisWithDecisions(db, parseInt(req.query.to))
    if (!from || !to || from.row.user_id !== candidateId || to.row.user_id !== candidateId) {
        return res.status(404).json({ error: "Analysis not found." })
    }
    const beforeSections = appliedSections(from.results)
    const afterSections = appliedSections(to.results)
    const sectionNames = [...new Set([...Object.keys(beforeSections), ...Object.keys(afterSections)])]
    const sections = sectionNames.map(name => ({
        section: name,
        diff: diffLines(beforeSections[name] || [], afterSections[name] || []),
    }))
    res.json({
        from: { id: from.row.id, score: from.row.score_total, created_at: from.row.created_at },
        to: { id: to.row.id, score: to.row.score_total, created_at: to.row.created_at },
        sections,
    })
})

// a comment, or a suggested edit (original_text -> suggested_text)
router.post("/feedback", authenticateToken, requireRole("mentor"), (req, res) => {
    const { candidate_id, analysis_id, suggestion_key, feedback_type, section, original_text, suggested_text, comment } = req.body
    const candidateId = parseInt(candidate_id)
    const session = mentorSessionForCandidate(req.user.id, candidateId)
    if (!session) {
        return res.status(404).json({ error: "Candidate not found in your active review sessions." })
    }
    const type = feedback_type === "edit" ? "edit" : "comment"
    if (type === "edit" && !String(suggested_text || "").trim()) {
        return res.status(400).json({ error: "Edit suggestions need suggested text." })
    }
    if (type === "comment" && !String(comment || "").trim()) {
        return res.status(400).json({ error: "Comment cannot be empty." })
    }
    const analysisId = analysis_id ? parseInt(analysis_id) : null
    if (analysisId && !canAccessAnalysis(analysisId, req.user)) {
        return res.status(404).json({ error: "Analysis not found." })
    }
    const db = getDb()
    const row = db.prepare(`
        INSERT INTO mentor_feedback
            (session_id, mentor_id, candidate_id, analysis_id, suggestion_key, feedback_type, section, original_text, suggested_text, comment, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
        session.id, req.user.id, candidateId, analysisId, String(suggestion_key || ""),
        type, String(section || ""), String(original_text || ""), String(suggested_text || ""), String(comment || ""),
    )
    res.status(201).json({ id: row.lastInsertRowid })
})

// Mentor's sent feedback (optionally per candidate) with current status.
router.get("/feedback", authenticateToken, requireRole("mentor"), (req, res) => {
    const db = getDb()
    const candidateId = req.query.candidate_id ? parseInt(req.query.candidate_id) : null
    const rows = candidateId
        ? db.prepare(`
            SELECT mf.*, u.display_name AS candidate_name FROM mentor_feedback mf
            JOIN users u ON u.id = mf.candidate_id
            WHERE mf.mentor_id = ? AND mf.candidate_id = ? ORDER BY mf.created_at DESC LIMIT 200
          `).all(req.user.id, candidateId)
        : db.prepare(`
            SELECT mf.*, u.display_name AS candidate_name FROM mentor_feedback mf
            JOIN users u ON u.id = mf.candidate_id
            WHERE mf.mentor_id = ? ORDER BY mf.created_at DESC LIMIT 200
          `).all(req.user.id)
    res.json(rows)
})

// Candidate's inbox: all feedback addressed to them, newest first.
router.get("/feedback/inbox", authenticateToken, (req, res) => {
    const db = getDb()
    const rows = db.prepare(`
        SELECT mf.*, u.display_name AS mentor_name FROM mentor_feedback mf
        JOIN users u ON u.id = mf.mentor_id
        WHERE mf.candidate_id = ? ORDER BY mf.created_at DESC LIMIT 200
    `).all(req.user.id)
    res.json(rows)
})

// Candidate resolves a feedback item (accepted / dismissed / open).
router.post("/feedback/:id/status", authenticateToken, (req, res) => {
    const status = String(req.body.status || "")
    if (!["open", "accepted", "dismissed"].includes(status)) {
        return res.status(400).json({ error: "Status must be open, accepted, or dismissed." })
    }
    const db = getDb()
    const result = db.prepare(
        "UPDATE mentor_feedback SET status = ?, updated_at = datetime('now') WHERE id = ? AND candidate_id = ?"
    ).run(status, parseInt(req.params.id), req.user.id)
    if (!result.changes) return res.status(404).json({ error: "Feedback not found." })
    res.json({ ok: true })
})

router.get("/report", authenticateToken, requireRole("mentor"), (req, res) => {
    const db = getDb()
    const sessions = db.prepare("SELECT id FROM review_sessions WHERE mentor_id = ?").all(req.user.id)

    const candidates = {}
    for (const sess of sessions) {
        const parts = db.prepare(
            "SELECT u.id, u.username, u.display_name FROM users u JOIN session_participants sp ON sp.user_id = u.id WHERE sp.session_id = ? AND u.role = 'candidate'"
        ).all(sess.id)
        for (const u of parts) {
            if (!candidates[u.id]) {
                const analyses = db.prepare("SELECT score_total FROM analyses WHERE user_id = ? ORDER BY created_at DESC").all(u.id)
                const scores = analyses.map(a => a.score_total)
                candidates[u.id] = { name: u.display_name, username: u.username, scores, total: analyses.length, latest: scores[0] || 0, best: scores.length ? Math.max(...scores) : 0 }
            }
        }
    }

    let md = "# Mentor Review Report\n\n"
    for (const c of Object.values(candidates)) {
        md += `## ${c.name} (@${c.username})\n`
        md += `- Total analyses: ${c.total}\n`
        md += `- Latest score: ${c.latest}/100\n`
        md += `- Best score: ${c.best}/100\n`
        if (c.scores.length) md += `- Score history: ${[...c.scores].reverse().join(", ")}\n`
        md += "\n"
    }

    res.json({ report: md })
})

export default router
