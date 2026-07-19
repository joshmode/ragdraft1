import { Router } from "express"
import { getDb } from "../db.js"
import { authenticateToken, requireRole } from "../middleware/auth.js"
import crypto from "crypto"

const router = Router()

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
