import { Router } from "express"
import fetch from "node-fetch"
import { authenticateToken } from "../middleware/auth.js"
import { BYOK_PROVIDERS, saveUserApiKey, deleteUserApiKey, hasUserApiKey } from "../userKeys.js"

const router = Router()

// Reports what's usable for THIS signed-in user: their own saved BYOK keys
// (per-user, from the database) plus the shared/global state that's the
// same for everyone (whether the pooled free tier is configured, whether
// LinkedIn OAuth is set up). Local LLM never needs a key, so it's always
// reported available — whether it actually works depends on the endpoint
// the user points it at.
router.get("/env-status", authenticateToken, async (req, res) => {
    const status = {}
    for (const provider of BYOK_PROVIDERS) {
        status[provider] = hasUserApiKey(req.user.id, provider)
    }
    status.local = true

    const engineUrl = req.app.locals.engineUrl
    try {
        const engineRes = await fetch(`${engineUrl}/env-status`)
        const engineStatus = await engineRes.json()
        status.default = !!engineStatus.groq
        status.linkedin = !!engineStatus.linkedin
    } catch {
        status.default = false
        status.linkedin = false
    }
    res.json(status)
})

router.post("/api-key", authenticateToken, (req, res) => {
    const provider = String(req.body.provider || "")
    const key = String(req.body.key || "").trim()

    if (!BYOK_PROVIDERS.has(provider)) {
        return res.status(400).json({ error: "Unknown provider." })
    }
    if (!key) {
        return res.status(400).json({ error: "Key cannot be empty." })
    }
    if (/[\r\n]/.test(key)) {
        return res.status(400).json({ error: "Key contains invalid characters." })
    }

    try {
        saveUserApiKey(req.user.id, provider, key)
        res.json({ ok: true })
    } catch (err) {
        res.status(500).json({ error: `Failed to save key: ${err.message}` })
    }
})

router.delete("/api-key/:provider", authenticateToken, (req, res) => {
    if (!BYOK_PROVIDERS.has(req.params.provider)) {
        return res.status(400).json({ error: "Unknown provider." })
    }
    deleteUserApiKey(req.user.id, req.params.provider)
    res.json({ ok: true })
})

router.get("/feedback-status", async (req, res) => {
    const engineUrl = req.app.locals.engineUrl
    try {
        const engineRes = await fetch(`${engineUrl}/feedback-status`)
        const data = await engineRes.json()
        res.json(data)
    } catch (err) {
        res.json({ silenced: false })
    }
})

router.post("/silence-feedback", async (req, res) => {
    const engineUrl = req.app.locals.engineUrl
    try {
        await fetch(`${engineUrl}/silence-feedback`, { method: "POST" })
        res.json({ ok: true })
    } catch {
        res.json({ ok: false })
    }
})

router.get("/forms-url", async (req, res) => {
    const engineUrl = req.app.locals.engineUrl
    try {
        const engineRes = await fetch(`${engineUrl}/forms-url`)
        const data = await engineRes.json()
        res.json(data)
    } catch {
        res.json({ url: "https://forms.gle/YOUR_FORM_ID_HERE" })
    }
})

export default router
