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
