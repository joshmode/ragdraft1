import crypto from "crypto"
import { getDb } from "./db.js"

// Every user's own key is decrypted fresh, per request, from their own row
// in user_api_keys — it is never written into a shared file or a process
// env var, which is exactly the bug this replaces: the old /save-api-key
// flow overwrote one shared os.environ value for every visitor at once, so
// whichever user saved a key last silently became the key everyone's
// requests used. Encryption at rest (AES-256-GCM) means a DB leak alone
// doesn't leak keys — you'd also need KEY_ENCRYPTION_SECRET, which only
// lives in server env, never in the database.
const ALGO = "aes-256-gcm"

const KEY_ENCRYPTION_SECRET = process.env.KEY_ENCRYPTION_SECRET ||
    (process.env.NODE_ENV === "production" ? "" : "ragstoriches_dev_key_encryption_secret")

if (!KEY_ENCRYPTION_SECRET) {
    throw new Error("KEY_ENCRYPTION_SECRET is required in production to store user API keys.")
}

// AES-256-GCM needs a 32-byte key; hash the configured secret down to that
// length regardless of how long/short the operator's raw secret is.
const MASTER_KEY = crypto.createHash("sha256").update(KEY_ENCRYPTION_SECRET).digest()

export const BYOK_PROVIDERS = new Set(["gemini", "claude", "chatgpt"])

function encrypt(plaintext) {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv(ALGO, MASTER_KEY, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
    return {
        encryptedKey: ciphertext.toString("base64"),
        iv: iv.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
    }
}

function decrypt({ encryptedKey, iv, authTag }) {
    const decipher = crypto.createDecipheriv(ALGO, MASTER_KEY, Buffer.from(iv, "base64"))
    decipher.setAuthTag(Buffer.from(authTag, "base64"))
    const plaintext = Buffer.concat([decipher.update(Buffer.from(encryptedKey, "base64")), decipher.final()])
    return plaintext.toString("utf8")
}

export function saveUserApiKey(userId, provider, plaintextKey) {
    if (!BYOK_PROVIDERS.has(provider)) throw new Error("Unsupported provider for personal API keys.")
    const { encryptedKey, iv, authTag } = encrypt(plaintextKey)
    getDb().prepare(`
        INSERT INTO user_api_keys (user_id, provider, encrypted_key, iv, auth_tag, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(user_id, provider) DO UPDATE SET
            encrypted_key = excluded.encrypted_key,
            iv = excluded.iv,
            auth_tag = excluded.auth_tag,
            updated_at = datetime('now')
    `).run(userId, provider, encryptedKey, iv, authTag)
}

export function deleteUserApiKey(userId, provider) {
    getDb().prepare("DELETE FROM user_api_keys WHERE user_id = ? AND provider = ?").run(userId, provider)
}

export function hasUserApiKey(userId, provider) {
    return !!getDb().prepare("SELECT 1 FROM user_api_keys WHERE user_id = ? AND provider = ?").get(userId, provider)
}

function getUserApiKey(userId, provider) {
    const row = getDb().prepare(
        "SELECT encrypted_key, iv, auth_tag FROM user_api_keys WHERE user_id = ? AND provider = ?"
    ).get(userId, provider)
    if (!row) return null
    return decrypt({ encryptedKey: row.encrypted_key, iv: row.iv, authTag: row.auth_tag })
}

class ProviderResolutionError extends Error {
    constructor(message, status = 400) {
        super(message)
        this.status = status
    }
}

// Single place that turns a UI-facing provider choice into what the engine
// actually needs to make the call: the internal provider name, and (for
// BYOK providers) that one user's own decrypted key. The returned apiKey
// must only ever be used to build the outbound engine request — never
// logged, never stored, never echoed back to any client.
export function resolveProviderForRequest(userId, providerChoice) {
    if (providerChoice === "default") {
        // pooled free tier — always the operator's own Groq key, held as a
        // normal env var on the engine, never a per-user secret.
        return { engineProvider: "groq", apiKey: "" }
    }
    if (providerChoice === "local") {
        return { engineProvider: "local", apiKey: "" }
    }
    if (!BYOK_PROVIDERS.has(providerChoice)) {
        throw new ProviderResolutionError("Unknown provider.")
    }
    const apiKey = getUserApiKey(userId, providerChoice)
    if (!apiKey) {
        throw new ProviderResolutionError(
            `No ${providerChoice} API key saved for your account. Add one below, or choose Default (Free).`
        )
    }
    return { engineProvider: providerChoice, apiKey }
}

export { ProviderResolutionError }
