import { getDb } from "./db.js"

// creates one unread notification row per recipient - called from wherever an event that
// should raise an unread badge actually happens (a new attempt, mentor feedback, a discussion
// post), rather than each call site reimplementing the insert. analysisId may be null for
// events with no specific attempt (kept nullable to mirror mentor_feedback's own analysis_id).
export function notify(userId, { analysisId = null, attemptType = "resume_analysis", eventType }) {
    getDb().prepare(
        "INSERT INTO notifications (user_id, analysis_id, attempt_type, event_type, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run(userId, analysisId, attemptType, eventType)
}

export function notifyMany(userIds, opts) {
    for (const userId of userIds) notify(userId, opts)
}
