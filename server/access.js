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
