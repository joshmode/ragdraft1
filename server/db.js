import Database from "better-sqlite3"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DB_PATH = path.resolve(__dirname, "..", "data", "ragstoriches.db")

let _db = null

function initDb(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            display_name TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'candidate',
            email TEXT DEFAULT '',
            is_guest INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS resumes (
            id INTEGER PRIMARY KEY,
            user_id INTEGER NOT NULL,
            filename TEXT DEFAULT '',
            raw_bytes BLOB,
            parsed_json TEXT DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS analyses (
            id INTEGER PRIMARY KEY,
            resume_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            results_json TEXT DEFAULT '{}',
            job_description TEXT DEFAULT '',
            provider TEXT DEFAULT '',
            model TEXT DEFAULT '',
            score_total INTEGER DEFAULT 0,
            content_hash TEXT DEFAULT '',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (resume_id) REFERENCES resumes(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS analysis_jobs (
            id INTEGER PRIMARY KEY,
            resume_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            request_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued',
            error TEXT DEFAULT '',
            analysis_id INTEGER,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (resume_id) REFERENCES resumes(id),
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (analysis_id) REFERENCES analyses(id)
        );
        CREATE TABLE IF NOT EXISTS rewrite_decisions (
            id INTEGER PRIMARY KEY,
            analysis_id INTEGER NOT NULL,
            suggestion_key TEXT NOT NULL,
            decision INTEGER,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (analysis_id) REFERENCES analyses(id)
        );
        CREATE TABLE IF NOT EXISTS annotations (
            id INTEGER PRIMARY KEY,
            analysis_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            suggestion_key TEXT NOT NULL,
            comment TEXT DEFAULT '',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (analysis_id) REFERENCES analyses(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS review_sessions (
            id INTEGER PRIMARY KEY,
            mentor_id INTEGER NOT NULL,
            session_code TEXT UNIQUE NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (mentor_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS session_participants (
            id INTEGER PRIMARY KEY,
            session_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (session_id, user_id),
            FOREIGN KEY (session_id) REFERENCES review_sessions(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS revision_snapshots (
            id INTEGER PRIMARY KEY,
            resume_id INTEGER NOT NULL,
            analysis_id INTEGER NOT NULL,
            decisions_json TEXT DEFAULT '{}',
            score_total INTEGER DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (resume_id) REFERENCES resumes(id),
            FOREIGN KEY (analysis_id) REFERENCES analyses(id)
        );
        CREATE TABLE IF NOT EXISTS generated_documents (
            id INTEGER PRIMARY KEY,
            analysis_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            document_type TEXT NOT NULL,
            content TEXT NOT NULL,
            company TEXT DEFAULT '',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (analysis_id) REFERENCES analyses(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS job_descriptions (
            id INTEGER PRIMARY KEY,
            user_id INTEGER NOT NULL,
            source_url TEXT DEFAULT '',
            source_name TEXT DEFAULT '',
            content TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS job_matches (
            id INTEGER PRIMARY KEY,
            user_id INTEGER NOT NULL,
            job_description_id INTEGER,
            analysis_id INTEGER,
            result_json TEXT NOT NULL,
            content_hash TEXT DEFAULT '',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (job_description_id) REFERENCES job_descriptions(id),
            FOREIGN KEY (analysis_id) REFERENCES analyses(id)
        );
        CREATE TABLE IF NOT EXISTS evaluation_feedback (
            id INTEGER PRIMARY KEY,
            user_id INTEGER NOT NULL,
            analysis_id INTEGER,
            consent INTEGER NOT NULL DEFAULT 0,
            confidence INTEGER,
            comment TEXT DEFAULT '',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (analysis_id) REFERENCES analyses(id)
        );
        CREATE TABLE IF NOT EXISTS mentor_feedback (
            id INTEGER PRIMARY KEY,
            session_id INTEGER NOT NULL,
            mentor_id INTEGER NOT NULL,
            candidate_id INTEGER NOT NULL,
            analysis_id INTEGER,
            suggestion_key TEXT DEFAULT '',
            feedback_type TEXT NOT NULL DEFAULT 'comment',
            section TEXT DEFAULT '',
            original_text TEXT DEFAULT '',
            suggested_text TEXT DEFAULT '',
            comment TEXT DEFAULT '',
            status TEXT NOT NULL DEFAULT 'open',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (session_id) REFERENCES review_sessions(id),
            FOREIGN KEY (mentor_id) REFERENCES users(id),
            FOREIGN KEY (candidate_id) REFERENCES users(id),
            FOREIGN KEY (analysis_id) REFERENCES analyses(id)
        );
        CREATE INDEX IF NOT EXISTS idx_mentor_feedback_candidate ON mentor_feedback(candidate_id, status);
        CREATE INDEX IF NOT EXISTS idx_mentor_feedback_mentor ON mentor_feedback(mentor_id);
        CREATE TABLE IF NOT EXISTS user_api_keys (
            id INTEGER PRIMARY KEY,
            user_id INTEGER NOT NULL,
            provider TEXT NOT NULL,
            encrypted_key TEXT NOT NULL,
            iv TEXT NOT NULL,
            auth_tag TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (user_id, provider),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
    `)

    // CREATE TABLE is a no-op on an existing analyses table, so migrate content_hash in here
    const columns = db.prepare("PRAGMA table_info(analyses)").all().map(col => col.name)
    if (!columns.includes("content_hash")) {
        db.exec("ALTER TABLE analyses ADD COLUMN content_hash TEXT DEFAULT ''")
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_analyses_content_hash ON analyses(content_hash)")

    const userColumns = db.prepare("PRAGMA table_info(users)").all().map(col => col.name)
    if (!userColumns.includes("is_guest")) {
        db.exec("ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0")
    }

    const genDocColumns = db.prepare("PRAGMA table_info(generated_documents)").all().map(col => col.name)
    if (!genDocColumns.includes("company")) {
        db.exec("ALTER TABLE generated_documents ADD COLUMN company TEXT DEFAULT ''")
    }

    const jobMatchColumns = db.prepare("PRAGMA table_info(job_matches)").all().map(col => col.name)
    if (!jobMatchColumns.includes("content_hash")) {
        db.exec("ALTER TABLE job_matches ADD COLUMN content_hash TEXT DEFAULT ''")
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_job_matches_content_hash ON job_matches(content_hash)")

    // the collaborative discussion system (candidate comments/questions + mentor replies on a
    // specific rewrite suggestion) is built on this existing per-suggestion annotations table
    // rather than a new one - section lets the mentor UI show which extracted section a thread
    // belongs to without re-deriving it from the suggestion id every time
    const annotationColumns = db.prepare("PRAGMA table_info(annotations)").all().map(col => col.name)
    if (!annotationColumns.includes("section")) {
        db.exec("ALTER TABLE annotations ADD COLUMN section TEXT DEFAULT ''")
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_annotations_analysis_suggestion ON annotations(analysis_id, suggestion_key)")

    // Fast Cover Letter Workflow (Phase Y): a 'cover_letter_only' attempt skips the whole
    // rewrite/scoring/keyword-gap pipeline and only ever calls the engine's single
    // gen-cover-letter LLM call - it still gets a real (minimal) analyses row so it can
    // reuse generated_documents/history/attempt-numbering unmodified rather than forking
    // a parallel storage path for it
    const analysisTypeColumns = db.prepare("PRAGMA table_info(analyses)").all().map(col => col.name)
    if (!analysisTypeColumns.includes("attempt_type")) {
        db.exec("ALTER TABLE analyses ADD COLUMN attempt_type TEXT NOT NULL DEFAULT 'resume_analysis'")
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_analyses_attempt_type ON analyses(user_id, attempt_type)")
}

const GUEST_RETENTION_HOURS = parseInt(process.env.GUEST_RETENTION_HOURS || "24", 10)

// guests get a real DB row (see server/routes/auth.js) so every existing per-user feature
// works unmodified, but that means their resume/analysis content actually is written to
// disk - unlike a real account, nothing ever points back at it (no password, token only in
// sessionStorage), so it's swept away after GUEST_RETENTION_HOURS instead of lingering
// forever. Runs lazily whenever a new guest session is created - no cron needed.
export function deleteExpiredGuests(db) {
    const expired = db.prepare(
        "SELECT id FROM users WHERE is_guest = 1 AND created_at < datetime('now', ?)"
    ).all(`-${GUEST_RETENTION_HOURS} hours`)

    for (const { id: userId } of expired) {
        deleteGuestUser(db, userId)
    }
}

// every DELETE below uses a subquery (never a precomputed id list) so it always sees the
// current state of the guest's own rows, and runs before the analyses/resumes rows it
// depends on are removed further down - order matters, children before parents
function deleteGuestUser(db, userId) {
    const del = db.transaction(() => {
        db.prepare("DELETE FROM rewrite_decisions WHERE analysis_id IN (SELECT id FROM analyses WHERE user_id = ?)").run(userId)
        db.prepare("DELETE FROM annotations WHERE analysis_id IN (SELECT id FROM analyses WHERE user_id = ?) OR user_id = ?").run(userId, userId)
        db.prepare(
            "DELETE FROM revision_snapshots WHERE resume_id IN (SELECT id FROM resumes WHERE user_id = ?) OR analysis_id IN (SELECT id FROM analyses WHERE user_id = ?)"
        ).run(userId, userId)
        db.prepare("DELETE FROM generated_documents WHERE analysis_id IN (SELECT id FROM analyses WHERE user_id = ?) OR user_id = ?").run(userId, userId)
        db.prepare("DELETE FROM job_matches WHERE analysis_id IN (SELECT id FROM analyses WHERE user_id = ?) OR user_id = ?").run(userId, userId)
        db.prepare("DELETE FROM evaluation_feedback WHERE analysis_id IN (SELECT id FROM analyses WHERE user_id = ?) OR user_id = ?").run(userId, userId)
        db.prepare("DELETE FROM mentor_feedback WHERE analysis_id IN (SELECT id FROM analyses WHERE user_id = ?) OR candidate_id = ? OR mentor_id = ?").run(userId, userId, userId)
        db.prepare("DELETE FROM session_participants WHERE user_id = ?").run(userId)
        db.prepare("DELETE FROM user_api_keys WHERE user_id = ?").run(userId)
        db.prepare("DELETE FROM analysis_jobs WHERE user_id = ? OR resume_id IN (SELECT id FROM resumes WHERE user_id = ?)").run(userId, userId)
        db.prepare("DELETE FROM job_descriptions WHERE user_id = ?").run(userId)
        db.prepare("DELETE FROM analyses WHERE user_id = ?").run(userId)
        db.prepare("DELETE FROM resumes WHERE user_id = ?").run(userId)
        db.prepare("DELETE FROM users WHERE id = ?").run(userId)
    })
    del()
}

export function getDb() {
    if (!_db) {
        _db = new Database(DB_PATH)
        _db.pragma("journal_mode = WAL")
        _db.pragma("foreign_keys = ON")
        initDb(_db)
    }
    return _db
}
