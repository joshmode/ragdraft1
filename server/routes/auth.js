import { Router } from "express"
import bcrypt from "bcrypt"
import { getDb } from "../db.js"
import { generateToken, authenticateToken } from "../middleware/auth.js"

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
    }

    const token = generateToken(user)
    res.json({ token, user })
})

router.get("/me", authenticateToken, (req, res) => {
    res.json({ user: req.user })
})

export default router
