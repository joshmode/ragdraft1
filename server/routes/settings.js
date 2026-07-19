import { Router } from "express"
import fetch from "node-fetch"
import { authenticateToken } from "../middleware/auth.js"

const router = Router()

router.get("/env-status", authenticateToken, async (req, res) => {
    const engineUrl = req.app.locals.engineUrl
    try {
        const engineRes = await fetch(`${engineUrl}/env-status`)
        const data = await engineRes.json()
        res.json(data)
    } catch (err) {
        res.status(500).json({ error: `Failed to check env status: ${err.message}` })
    }
})

router.post("/api-key", authenticateToken, async (req, res) => {
    const engineUrl = req.app.locals.engineUrl
    try {
        const engineRes = await fetch(`${engineUrl}/save-api-key`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(req.body),
        })
        const data = await engineRes.json()
        res.json(data)
    } catch (err) {
        res.status(500).json({ error: `Failed to save API key: ${err.message}` })
    }
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
