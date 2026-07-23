import { getDb } from "./db.js"

export function getOwnedResume(resumeId, userId) {
    return getDb().prepare("SELECT * FROM resumes WHERE id = ? AND user_id = ?").get(resumeId, userId)
}

export function getOwnedAnalysis(analysisId, userId) {
    return getDb().prepare("SELECT * FROM analyses WHERE id = ? AND user_id = ?").get(analysisId, userId)
}

export function canAccessAnalysis(analysisId, user) {
    const owned = getOwnedAnalysis(analysisId, user.id)
    if (owned) return owned
    if (user.role !== "mentor") return null

    return getDb().prepare(`
        SELECT a.*
        FROM analyses a
        JOIN resumes r ON r.id = a.resume_id
        JOIN session_participants sp ON sp.user_id = a.user_id
        JOIN review_sessions rs ON rs.id = sp.session_id
        WHERE a.id = ? AND rs.mentor_id = ? AND rs.active = 1
        LIMIT 1
    `).get(analysisId, user.id)
}

// mentor <-> candidate trust = session membership, only see candidates in your own sessions
export function mentorSessionForCandidate(mentorId, candidateId, { activeOnly = true } = {}) {
    return getDb().prepare(`
        SELECT rs.id, rs.session_code, rs.active
        FROM review_sessions rs
        JOIN session_participants sp ON sp.session_id = rs.id
        WHERE rs.mentor_id = ? AND sp.user_id = ? ${activeOnly ? "AND rs.active = 1" : ""}
        ORDER BY rs.active DESC, rs.created_at DESC
        LIMIT 1
    `).get(mentorId, candidateId)
}

// reverse of mentorSessionForCandidate: every mentor currently serving this candidate in an
// active review session, so a candidate-side event (new attempt, new comment) can notify all
// of them - a candidate could in principle be in more than one mentor's session
export function mentorsForCandidate(candidateId) {
    return getDb().prepare(`
        SELECT DISTINCT rs.mentor_id
        FROM review_sessions rs
        JOIN session_participants sp ON sp.session_id = rs.id
        WHERE sp.user_id = ? AND rs.active = 1
    `).all(candidateId).map(r => r.mentor_id)
}
