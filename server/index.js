import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import path from "path"
import { fileURLToPath } from "url"

import authRoutes from "./routes/auth.js"
import analysisRoutes from "./routes/analysis.js"
import generationRoutes from "./routes/generation.js"
import mentorRoutes from "./routes/mentor.js"
import annotationRoutes from "./routes/annotations.js"
import scraperRoutes from "./routes/scraper.js"
import settingsRoutes from "./routes/settings.js"
import feedbackRoutes from "./routes/feedback.js"
import { getDb } from "./db.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

dotenv.config({ path: path.resolve(__dirname, "..", ".env") })

const app = express()
const PORT = process.env.API_PORT || 3000
const ENGINE_URL = process.env.ENGINE_URL || "http://localhost:5001"

getDb()

app.use(cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
}))
app.use(express.json({ limit: "50mb" }))

app.locals.engineUrl = ENGINE_URL

app.use("/api/auth", authRoutes)
app.use("/api/analysis", analysisRoutes)
app.use("/api/generate", generationRoutes)
app.use("/api/mentor", mentorRoutes)
app.use("/api/annotations", annotationRoutes)
app.use("/api/scrape", scraperRoutes)
app.use("/api/settings", settingsRoutes)
app.use("/api/feedback", feedbackRoutes)

app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", engine: ENGINE_URL })
})

const clientDist = path.resolve(__dirname, "..", "client", "dist")
app.use(express.static(clientDist))
app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"))
})

app.listen(PORT, () => {
    console.log(`ragstoriches api listening on :${PORT}`)
    console.log(`engine url: ${ENGINE_URL}`)
})

export default app
