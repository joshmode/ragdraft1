import { Router } from "express"
import bcrypt from "bcrypt"
import crypto from "crypto"
import { getDb, deleteExpiredGuests } from "../db.js"
import { generateToken, authenticateToken } from "../middleware/auth.js"
import { guestLimiter } from "../middleware/rateLimit.js"

const router = Router()

router.post("/register", async (req, res) => {
    const { username, password, display_name, role, email } = req.body

    if (!username?.trim() || !password?.trim() || !display_name?.trim()) {
        return res.status(400).json({ error: "Display name, username, and password are required." })
    }
    if (password.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters." })
    }

    const db = getDb()
    const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username.trim().toLowerCase())
    if (existing) {
        return res.status(409).json({ error: "Username already taken." })
    }

    const requestedRole = (role || "candidate").toLowerCase()
    const allowMentorRegistration = process.env.ALLOW_MENTOR_REGISTRATION === "true"
    if (!["candidate", "mentor"].includes(requestedRole)) {
        return res.status(400).json({ error: "Role must be candidate or mentor." })
    }
    if (requestedRole === "mentor" && !allowMentorRegistration) {
        return res.status(403).json({ error: "Mentor registration is not currently available." })
    }

    const hash = await bcrypt.hash(password, 12)
    const stmt = db.prepare(
        "INSERT INTO users (username, password_hash, display_name, role, email, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    )
    const result = stmt.run(username.trim().toLowerCase(), hash, display_name.trim(), requestedRole, (email || "").trim())

    const user = {
        id: result.lastInsertRowid,
        username: username.trim().toLowerCase(),
        display_name: display_name.trim(),
        role: requestedRole,
        is_guest: false,
    }

    const token = generateToken(user)
    res.status(201).json({ token, user })
})

router.post("/login", async (req, res) => {
    const { username, password } = req.body

    if (!username?.trim() || !password?.trim()) {
        return res.status(400).json({ error: "Username and password are required." })
    }

    const db = getDb()
    const row = db.prepare("SELECT * FROM users WHERE username = ?").get(username.trim().toLowerCase())
    if (!row) {
        return res.status(401).json({ error: "Invalid username or password." })
    }

    const valid = await bcrypt.compare(password, row.password_hash)
    if (!valid) {
        return res.status(401).json({ error: "Invalid username or password." })
    }

    const user = {
        id: row.id,
        username: row.username,
        display_name: row.display_name,
        role: row.role,
        is_guest: !!row.is_guest,
    }

    const token = generateToken(user)
    res.json({ token, user })
})

// lets the tool stay usable without registering: a real (but ephemeral, unlisted)
// account is created so every existing per-user feature - caching, decisions, generated
// docs, tab-switch restore - works unmodified. The frontend keeps this session in
// sessionStorage rather than localStorage, so nothing lets the guest come back to it
// later, and their DB rows are actually deleted after GUEST_RETENTION_HOURS (see db.js) -
// together that's what "no record kept for guests" means in practice here.
//
// guestLimiter (not just the shared authLimiter mounted on this whole router) matters:
// this endpoint has no credentials to get wrong, so it always "succeeds", and authLimiter
// skips successful requests - without a limiter that counts successes too, a client could
// trigger unlimited cost-12 bcrypt hashes and permanent row inserts.
router.post("/guest", guestLimiter, async (req, res) => {
    const db = getDb()
    deleteExpiredGuests(db)

    let username = ""
    for (let attempt = 0; attempt < 5 && !username; attempt++) {
        const candidate = `guest_${crypto.randomBytes(6).toString("hex")}`
        if (!db.prepare("SELECT id FROM users WHERE username = ?").get(candidate)) {
            username = candidate
        }
    }
    if (!username) {
        return res.status(500).json({ error: "Could not start a guest session. Please try again." })
    }

    const randomPassword = crypto.randomBytes(32).toString("hex")
    const hash = await bcrypt.hash(randomPassword, 12)
    const stmt = db.prepare(
        "INSERT INTO users (username, password_hash, display_name, role, email, is_guest, created_at) VALUES (?, ?, ?, ?, ?, 1, datetime('now'))"
    )
    const result = stmt.run(username, hash, "Guest", "candidate", "")

    const user = {
        id: result.lastInsertRowid,
        username,
        display_name: "Guest",
        role: "candidate",
        is_guest: true,
    }

    const token = generateToken(user)
    res.status(201).json({ token, user })
})

router.get("/me", authenticateToken, (req, res) => {
    res.json({ user: req.user })
})

export default router
