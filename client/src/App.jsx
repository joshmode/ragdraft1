import { useEffect, useMemo, useState } from "react"
import { useDropzone } from "react-dropzone"
import ReactMarkdown from "react-markdown"
import api from "./api/client"
import { useAuth } from "./context/AuthContext"

const PROVIDERS = {
    Gemini: ["gemma-4-31b-it", "gemini-3.5-flash", "gemini-3.1-pro"],
    Claude: ["claude-4-5-sonnet-latest", "claude-4-5-haiku-latest"],
    ChatGPT: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
    Local: ["llama3"],
}

const PROVIDER_KEYS = {
    Gemini: "gemini",
    Claude: "claude",
    ChatGPT: "chatgpt",
    Local: "local",
}

const NAV_ITEMS = [
    "Rewrite Suggestions", "Keyword Gap", "Extracted Sections", "Tailored CV",
    "Cover Letter", "Analytics", "Mentor Dashboard", "Job Matching",
]

function getScoreCfg(score) {
    if (score >= 70) return { color: "#15C39A", label: "Strong" }
    if (score >= 50) return { color: "#E8A735", label: "Needs work" }
    return { color: "#E5534B", label: "Needs improvement" }
}

function getError(err) {
    return err.response?.data?.error || err.message || "Something went wrong."
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(",", 2)[1])
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
    })
}

function waitForAnalysis(jobId) {
    return new Promise((resolve, reject) => {
        let attempts = 0
        const poll = async () => {
            try {
                const response = await api.get(`/analysis/jobs/${jobId}`)
                if (response.data.status === "completed") return resolve(response.data.results)
                if (response.data.status === "failed") return reject(new Error(response.data.error || "Analysis failed."))
                attempts += 1
                if (attempts >= 600) return reject(new Error("Analysis timed out."))
                window.setTimeout(poll, 1000)
            } catch (err) {
                reject(err)
            }
        }
        poll()
    })
}

function AuthPage() {
    const { login, register } = useAuth()
    const [tab, setTab] = useState("login")
    const [form, setForm] = useState({ username: "", password: "", display_name: "", email: "", confirm: "", role: "candidate" })
    const [error, setError] = useState("")
    const [busy, setBusy] = useState(false)

    function update(key, value) {
        setForm({ ...form, [key]: value })
    }

    async function submit(e) {
        e.preventDefault()
        setError("")
        if (tab === "register" && form.password !== form.confirm) {
            setError("Passwords do not match.")
            return
        }
        setBusy(true)
        try {
            if (tab === "login") await login(form.username, form.password)
            else await register(form.username, form.password, form.display_name, form.role, form.email)
        } catch (err) {
            setError(getError(err))
        } finally {
            setBusy(false)
        }
    }

    return (
        <main className="app-container auth-page">
            <section className="auth-card">
                <h2>Welcome to RAGsToRiches</h2>
                <p className="auth-sub">Sign in or create an account to get started.</p>
                <div className="auth-tabs">
                    <button className={`auth-tab ${tab === "login" ? "active" : ""}`} onClick={() => setTab("login")}>Sign In</button>
                    <button className={`auth-tab ${tab === "register" ? "active" : ""}`} onClick={() => setTab("register")}>Register</button>
                </div>
                <form onSubmit={submit}>
                    {tab === "register" && <>
                        <Field label="Display Name" value={form.display_name} onChange={v => update("display_name", v)} required />
                        <Field label="Email (optional)" type="email" value={form.email} onChange={v => update("email", v)} />
                    </>}
                    <Field label="Username" value={form.username} onChange={v => update("username", v)} required />
                    <Field label="Password" type="password" value={form.password} onChange={v => update("password", v)} required />
                    {tab === "register" && <>
                        <Field label="Confirm Password" type="password" value={form.confirm} onChange={v => update("confirm", v)} required />
                        <label className="form-group">I am a...
                            <select className="input-field" value={form.role} onChange={e => update("role", e.target.value)}>
                                <option value="candidate">Candidate</option>
                                <option value="mentor">Mentor</option>
                            </select>
                        </label>
                    </>}
                    {error && <p className="error-msg">{error}</p>}
                    <button className="btn-primary full-width" disabled={busy}>{busy ? "Please wait..." : tab === "login" ? "Sign In" : "Create Account"}</button>
                </form>
            </section>
        </main>
    )
}

function Field({ label, type = "text", value, onChange, required }) {
    return <label className="form-group">{label}<input className="input-field" type={type} value={value} onChange={e => onChange(e.target.value)} required={required} /></label>
}

function Hero() {
    return <section className="hero-wrap">
        <div className="hero-eyebrow">Resume intelligence, reimagined</div>
        <h1 className="hero-title"><span className="title-prefix">RagsToRiches:</span><br /><span className="accent">Smarter resumes, smarter opportunities.</span></h1>
        <p className="hero-sub">Review rewrite suggestions against the uploaded resume, apply the changes you trust, then generate a CV from those decisions with or without a job description.</p>
    </section>
}

function ResumeSetup({ file, setFile, jobDescription, setJobDescription, onAnalyse, busy }) {
    const { getRootProps, getInputProps, isDragActive } = useDropzone({
        multiple: false,
        accept: {
            "application/pdf": [".pdf"],
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
            "application/vnd.oasis.opendocument.text": [".odt"],
            "text/plain": [".txt", ".md"],
            "application/zip": [".zip"],
        },
        onDrop: files => setFile(files[0] || null),
    })

    return <section className="setup-band">
        <hr className="slim-divider" />
        <div className="two-col">
            <div>
                <span className="section-label">Resume PDF / DOCX / ODT / TXT / MD / LinkedIn ZIP</span>
                <div {...getRootProps()} className={`dropzone ${isDragActive ? "active" : ""}`}>
                    <input {...getInputProps()} />
                    {file ? <span className="success">{file.name}</span> : "Drop your resume here, or click to upload"}
                </div>
            </div>
            <div>
                <span className="section-label">Job Description <small>(optional for ATS matching)</small></span>
                <textarea className="input-field" value={jobDescription} onChange={e => setJobDescription(e.target.value)} placeholder="Paste a full job description for keyword matching, or leave blank to improve the CV from rewrite decisions only." />
            </div>
        </div>
        <button className="btn-primary analyse-btn" disabled={!file || busy} onClick={onAnalyse}>{busy ? "Analysing resume..." : "Analyse resume ✨"}</button>
    </section>
}

function ScoreCard({ scoreData }) {
    const score = typeof scoreData === "object" ? scoreData?.total || 0 : scoreData || 0
    const cfg = getScoreCfg(score)
    const lines = typeof scoreData === "object" ? [
        `Base: ${scoreData.base || 0}`,
        `Sections: +${scoreData.sections || 0}`,
        `Keywords: +${scoreData.keywords || 0}`,
        `Bullet Quality: +${scoreData.bullet_quality || 0}`,
        `Action Verbs: +${scoreData.action_verbs || 0}`,
        `Warnings: ${scoreData.warnings || 0}`,
        `Total: ${score}/100`,
    ].join("\n") : "Score breakdown not available"

    return <div className="card score-card"><span className="section-label">Resume Score</span><div className="score-tooltip-wrap"><div className="score-ring-wrap"><div className="score-number" style={{ color: cfg.color }}>{score}</div><div><span className="score-label-text">{cfg.label}</span><span className="score-sub">out of 100 · hover for breakdown</span></div></div><div className="score-tooltip">{lines}</div></div></div>
}

function ResultsSidebar({ result, user, onLogout }) {
    const sections = result.sections || {}
    return <aside className="sidebar open"><button className="sidebar-close" onClick={onLogout}>Sign out</button><ScoreCard scoreData={result.score} />
        {result.contact && Object.keys(result.contact).length > 0 && <div className="card"><span className="section-label">Contact Detected</span><div className="contact-grid">{Object.entries(result.contact).map(([key, value]) => <span className="contact-chip" key={key}><b>{key}</b>{value}</span>)}</div></div>}
        <div className="card"><span className="section-label">Parser Debug</span>{["EXPERIENCE", "EDUCATION", "SKILLS", "PROJECTS"].map(name => <p key={name} className={sections[name] ? "ok-text" : "error-text"}>{sections[name] ? "✓" : "✗"} {name[0] + name.slice(1).toLowerCase()}</p>)}</div>
        {user.role === "candidate" && <SessionJoin />}
        <div className="card muted">Signed in as {user.display_name}</div>
    </aside>
}

function SessionJoin() {
    const [code, setCode] = useState("")
    const [message, setMessage] = useState("")
    async function join() {
        try {
            await api.post("/mentor/session/join", { code })
            setMessage("Joined review session.")
        } catch (err) { setMessage(getError(err)) }
    }
    return <div className="card"><span className="section-label">Collaborative Review</span><input className="input-field" value={code} onChange={e => setCode(e.target.value)} placeholder="Enter mentor session code" /><button className="btn-secondary" onClick={join}>Join Session</button>{message && <p className="muted">{message}</p>}</div>
}

function RewriteReview({ result, file, decisions, setDecisions, analysisId }) {
    const [active, setActive] = useState(0)
    const [annotations, setAnnotations] = useState([])
    const [comment, setComment] = useState("")
    const [pdfUrl, setPdfUrl] = useState("")
    const actionable = useMemo(() => Object.entries(result.rewrites || {}).flatMap(([section, items]) => items.map((item, index) => ({ section, item, index, key: item.id || `${section}_${index}` })).filter(({ item }) => item.framework_used !== "none" && item.framework_used !== "error" && item.original !== item.rewritten)), [result])
    const current = actionable[Math.min(active, Math.max(actionable.length - 1, 0))]

    useEffect(() => {
        if (!analysisId || !current) return
        api.get(`/annotations/${analysisId}`).then(res => setAnnotations(res.data.filter(item => item.key === current.key))).catch(() => setAnnotations([]))
    }, [analysisId, current?.key])

    useEffect(() => {
        let nextUrl = ""
        if (!file || file.type !== "application/pdf" || !current) {
            setPdfUrl("")
            return undefined
        }
        async function render() {
            try {
                const items = actionable.map(({ key, item }) => ({
                    id: key,
                    text: item.highlight_text || item.original || "",
                    severity: item.severity || "yellow",
                    reasoning: item.reasoning || "",
                    rewritten: item.rewritten || "",
                }))
                const res = await api.post("/analysis/highlight", { file: await fileToBase64(file), items, active_key: current.key }, { responseType: "blob" })
                nextUrl = URL.createObjectURL(res.data)
                setPdfUrl(nextUrl)
            } catch {
                nextUrl = URL.createObjectURL(file)
                setPdfUrl(nextUrl)
            }
        }
        render()
        return () => {
            if (nextUrl) URL.revokeObjectURL(nextUrl)
        }
    }, [file, current?.key, actionable])

    async function save(next) {
        setDecisions(next)
        if (analysisId) await api.post(`/analysis/${analysisId}/decisions`, { decisions: next })
    }

    async function postComment() {
        if (!comment.trim() || !analysisId || !current) return
        await api.post("/annotations", { analysis_id: analysisId, suggestion_key: current.key, comment })
        setComment("")
        const res = await api.get(`/annotations/${analysisId}`)
        setAnnotations(res.data.filter(item => item.key === current.key))
    }

    if (!actionable.length) return <div className="card muted">No rewrite-worthy sentences were detected. Header and label lines were skipped.</div>
    const state = decisions[current.key]
    return <><div className="review-toolbar"><span className="status-chip">{actionable.length} suggested changes</span><span className="status-chip">{Object.values(decisions).filter(v => v).length} accepted</span><span className="status-chip">{Object.values(decisions).filter(v => v === false).length} dismissed</span><button className="btn-secondary" onClick={() => save(Object.fromEntries(actionable.map(({ key }) => [key, true])))}>Accept all</button><button className="btn-secondary" onClick={() => save({})}>Clear decisions</button></div>
        <div className="two-col-pdf"><div><span className="section-label">Highlighted Resume</span>{pdfUrl ? <div className="pdf-shell"><iframe className="pdf-frame" src={pdfUrl} title="Uploaded resume" /></div> : <div className="card muted">Source preview is available for PDF uploads. Parsed content remains available under Extracted Sections.</div>}</div>
            <div><div className="review-nav"><button className="btn-secondary" disabled={!active} onClick={() => setActive(active - 1)}>←</button><span className="status-chip">Suggestion {active + 1} of {actionable.length}</span><button className="btn-secondary" disabled={active >= actionable.length - 1} onClick={() => setActive(active + 1)}>→</button></div><span className="section-label">Rewrite Decision</span><div className={`suggestion-card ${state === true ? "accepted" : state === false ? "dismissed" : ""}`}><div className="suggestion-head"><span className="suggestion-title">{current.section}</span><span className="fw-badge">{current.item.framework_used}</span></div><div className="rewrite-grid"><div className="rewrite-pane before"><span className="pane-label">Original</span><p className="rewrite-text">{current.item.original}</p></div><div className="rewrite-pane after"><span className="pane-label">Suggested rewrite</span><p className="rewrite-text">{current.item.rewritten}</p></div></div><div className="reasoning-row">💡 {current.item.reasoning}</div></div><div className="two-col"><button className="btn-primary" onClick={() => save({ ...decisions, [current.key]: true })}>Accept</button><button className="btn-secondary" onClick={() => save({ ...decisions, [current.key]: false })}>Dismiss</button></div><AnnotationThread annotations={annotations} comment={comment} setComment={setComment} postComment={postComment} /></div>
        </div></>
}

function AnnotationThread({ annotations, comment, setComment, postComment }) {
    return <div className="annotation-thread"><span className="section-label">Discussion</span>{annotations.map(annotation => <div className="annotation-card" key={annotation.id}><span className="ann-user">{annotation.user}</span><span className="ann-time">{String(annotation.time).slice(0, 16).replace("T", " ")}</span><div className="ann-body">{annotation.comment}</div></div>)}<div className="annotation-input"><input className="input-field" value={comment} onChange={e => setComment(e.target.value)} placeholder="Add a comment" /><button className="btn-secondary" onClick={postComment}>Post Comment</button></div></div>
}

function KeywordGap({ result }) {
    const keywords = result.jd_keywords || []
    if (!keywords.length) return <p className="muted">Paste a job description above and re-analyse to see keyword gaps.</p>
    const missing = result.missing_keywords || []
    const present = keywords.filter(item => !missing.includes(item))
    const coverage = Math.round(present.length / keywords.length * 100)
    return <><div className="card"><span className="section-label">Coverage</span><p className="metric-value">{coverage}%</p><p className="muted">{present.length} of {keywords.length} JD keywords present in your resume</p></div><div className="two-col"><div><span className="section-label">❌ Missing ({missing.length})</span><div className="kw-wrap">{missing.map(item => <span className="kw-missing" key={item}>{item}</span>)}</div></div><div><span className="section-label">✅ Present ({present.length})</span><div className="kw-wrap">{present.map(item => <span className="kw-present" key={item}>{item} ({result.keyword_frequencies?.[item] || 0})</span>)}</div></div></div></>
}

function ExtractedSections({ result }) {
    return <div>{Object.entries(result.sections || {}).map(([name, lines]) => <details className="card" key={name} open={name === "EXPERIENCE"}><summary>{name}</summary><pre className="section-pre">{lines.join("\n")}</pre></details>)}</div>
}

function downloadText(text, filename) {
    const href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }))
    const link = document.createElement("a")
    link.href = href
    link.download = filename
    link.click()
    URL.revokeObjectURL(href)
}

function DocumentGenerator({ type, result, provider, model, localEndpoint, decisions, analysisId }) {
    const [text, setText] = useState("")
    const [busy, setBusy] = useState(false)
    const title = type === "cv" ? "Tailored CV" : "Cover Letter"

    async function generate() {
        setBusy(true)
        try {
            const endpoint = type === "cv" ? "/generate/cv" : "/generate/cover-letter"
            const payload = {
                resume_json: result.parsed_resume,
                job_description: result.job_description || "",
                provider,
                model,
                local_endpoint: localEndpoint,
                analysis_id: analysisId || result.analysis_id,
            }
            if (type === "cv") {
                payload.rewrite_suggestions = result.rewrites
                payload.rewrite_decisions = decisions
                payload.acc_map = {}
            }
            const res = await api.post(endpoint, payload)
            setText(type === "cv" ? res.data.cv_text : res.data.cover_letter_text)
        } finally {
            setBusy(false)
        }
    }

    async function downloadExport(kind) {
        const res = await api.post(`/generate/${kind}`, { text, filename: type === "cv" ? `tailored_cv.${kind}` : `cover_letter.${kind}` }, { responseType: "blob" })
        const href = URL.createObjectURL(res.data)
        const link = document.createElement("a")
        link.href = href
        link.download = type === "cv" ? `tailored_cv.${kind}` : `cover_letter.${kind}`
        link.click()
        URL.revokeObjectURL(href)
    }

    return <section><span className="section-label">Generate {title}</span><p className="muted">{type === "cv" ? "The generated CV applies accepted rewrites and keeps dismissed original text." : "Generate a professional cover letter tailored to the job description."}</p><button className="btn-primary" disabled={busy} onClick={generate}>{busy ? "Generating..." : `Generate ${title}`}</button>{text && <><h3>✏️ Edit Your {title}</h3><textarea className="input-field document-editor" value={text} onChange={e => setText(e.target.value)} /><h3>Preview</h3><article className="card markdown-preview"><ReactMarkdown>{text}</ReactMarkdown></article><div className="export-row"><button className="btn-dark" onClick={() => downloadText(text, type === "cv" ? "tailored_cv.md" : "cover_letter.md")}>📄 Download Markdown</button><button className="btn-dark" onClick={() => downloadExport("docx")}>📝 Download DOCX</button><button className="btn-dark" onClick={() => downloadExport("pdf")}>📕 Download PDF</button></div></>}</section>
}

function Analytics({ result, history }) {
    const score = result.score || {}
    const sectionScores = score.section_scores || {}
    const timing = result.timing || {}
    const [consent, setConsent] = useState(false)
    const [confidence, setConfidence] = useState("")
    const [comment, setComment] = useState("")
    const [submitted, setSubmitted] = useState(false)

    async function submitFeedback() {
        await api.post("/feedback", { analysis_id: result.analysis_id, consent, confidence, comment })
        setSubmitted(true)
    }

    return <section><span className="section-label">User Analytics Dashboard</span><h3>Resume Score History</h3><div className="card history-list">{history.length ? history.map((item, index) => <div key={item.id || index}><b>Attempt {history.length - index}</b><span>{item.score}/100</span><small>{String(item.created_at || "").slice(0, 16)}</small></div>) : <p className="muted">Run more analyses to see score progression.</p>}</div><h3>Readability &amp; Quality Heatmap</h3><div className="section-score-grid">{Object.entries(sectionScores).map(([section, data]) => <div className="metric-card card" key={section}><div className="metric-value">{data.quality}%</div><div className="metric-label">{section}</div></div>)}</div><h3>Performance Metrics</h3><div className="three-col">{Object.entries(timing).map(([key, value]) => <div className="metric-card card" key={key}><div className="metric-value">{value}ms</div><div className="metric-label">{key.replace("_ms", "")}</div></div>)}</div><div className="card evaluation-card"><span className="section-label">Optional Evaluation</span><p className="muted">Share anonymised confidence feedback without including your resume content.</p>{submitted ? <p className="success-msg">Thanks for your feedback.</p> : <><label className="toggle-wrap"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />I consent to store this evaluation response.</label><label className="form-group">Confidence in these recommendations<select className="input-field" value={confidence} onChange={e => setConfidence(e.target.value)}><option value="">Select a rating</option>{[1, 2, 3, 4, 5].map(value => <option value={value} key={value}>{value}</option>)}</select></label><textarea className="input-field" value={comment} onChange={e => setComment(e.target.value)} placeholder="Optional qualitative feedback" /><button className="btn-secondary" disabled={!consent} onClick={submitFeedback}>Submit Feedback</button></>}</div></section>
}

function MentorDashboard() {
    const [data, setData] = useState(null)
    const [error, setError] = useState("")
    async function load() {
        try { setData((await api.get("/mentor/dashboard")).data) } catch (err) { setError(getError(err)) }
    }
    useEffect(() => { load() }, [])
    async function createSession() {
        try {
            await api.post("/mentor/session")
            await load()
        } catch (err) { setError(getError(err)) }
    }
    if (error) return <p className="warning-strip">{error}</p>
    if (!data) return <p className="muted">Loading mentor dashboard...</p>
    return <section><span className="section-label">Mentor Dashboard</span><button className="btn-primary" onClick={createSession}>Create Review Session</button><div className="card"><span className="section-label">Active Sessions</span>{data.sessions.map(session => <p key={session.id}><b>{session.session_code}</b> · {session.participants.map(item => item.display_name).join(", ") || "No participants yet"}</p>)}</div><span className="section-label">Candidate Comparison</span><div className="card mentor-table"><table><thead><tr><th>Candidate</th><th>Analyses</th><th>Latest</th><th>Best</th></tr></thead><tbody>{data.candidates.map(candidate => <tr key={candidate.id}><td>{candidate.name}</td><td>{candidate.total_analyses}</td><td>{candidate.latest_score}</td><td>{candidate.best_score}</td></tr>)}</tbody></table></div></section>
}

function JobMatching({ result, provider, model, localEndpoint }) {
    const [url, setUrl] = useState("")
    const [scraped, setScraped] = useState("")
    const [jobId, setJobId] = useState(null)
    const [comparison, setComparison] = useState(null)
    const [linkedinUrl, setLinkedinUrl] = useState("")
    const [linkedinProfile, setLinkedinProfile] = useState(null)
    const [error, setError] = useState("")
    async function scrape() {
        try {
            const res = await api.post("/scrape/jd", { url })
            setScraped(res.data.text || "")
            setJobId(res.data.job_id || null)
        } catch (err) { setError(getError(err)) }
    }
    async function compare() {
        try {
            const res = await api.post("/scrape/compare", { resume_text: result.raw_text || "", jd_text: scraped || result.job_description || "", provider, model, local_endpoint: localEndpoint, job_id: jobId, analysis_id: result.analysis_id })
            setComparison(res.data)
        } catch (err) { setError(getError(err)) }
    }
    async function scrapeLinkedIn() {
        try {
            const res = await api.post("/scrape/linkedin", { url: linkedinUrl })
            setLinkedinProfile(res.data)
        } catch (err) { setError(getError(err)) }
    }
    return <section><span className="section-label">Recruitment Integration</span><div className="two-col"><input className="input-field" value={url} onChange={e => setUrl(e.target.value)} placeholder="Enter Job Description URL" /><button className="btn-primary" onClick={scrape}>Scrape Job Description</button></div>{scraped && <textarea className="input-field document-editor" value={scraped} onChange={e => setScraped(e.target.value)} />}{error && <p className="error-msg">{error}</p>}<button className="btn-secondary" onClick={compare} disabled={!scraped && !result.job_description}>Compare Resume to Job</button>{comparison && <div className="card"><p className="metric-value">{comparison.match_pct || 0}%</p><p><b>Strong matches:</b> {(comparison.strong_matches || []).join(", ") || "None"}</p><p><b>Missing skills:</b> {(comparison.missing_skills || []).join(", ") || "None"}</p><p><b>Tailoring tips:</b> {(comparison.tailoring_tips || []).join(" · ") || "None"}</p></div>}<hr className="slim-divider" /><h3>LinkedIn Profile Import</h3><p className="muted">Import a LinkedIn ZIP export through the main upload area, or inspect a public profile URL.</p><div className="two-col"><input className="input-field" value={linkedinUrl} onChange={e => setLinkedinUrl(e.target.value)} placeholder="LinkedIn Profile URL (Public)" /><button className="btn-secondary" onClick={scrapeLinkedIn}>Scrape LinkedIn Profile</button></div>{linkedinProfile && <pre className="card section-pre">{JSON.stringify(linkedinProfile, null, 2)}</pre>}</section>
}

function App() {
    const { user, logout } = useAuth()
    const [providerDisplay, setProviderDisplay] = useState("Gemini")
    const [model, setModel] = useState(PROVIDERS.Gemini[0])
    const [useCritic, setUseCritic] = useState(false)
    const [localEndpoint, setLocalEndpoint] = useState("http://localhost:11434/api/chat")
    const [status, setStatus] = useState({})
    const [apiKey, setApiKey] = useState("")
    const [file, setFile] = useState(null)
    const [jobDescription, setJobDescription] = useState("")
    const [result, setResult] = useState(null)
    const [analysisId, setAnalysisId] = useState(null)
    const [decisions, setDecisions] = useState({})
    const [view, setView] = useState("Rewrite Suggestions")
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState("")
    const [history, setHistory] = useState([])
    const provider = PROVIDER_KEYS[providerDisplay]
    const needsKey = provider !== "local" && status[provider] === false

    useEffect(() => {
        if (!user) return
        api.get("/settings/env-status").then(res => setStatus(res.data)).catch(() => setStatus({}))
        api.get("/analysis/history").then(res => setHistory(res.data)).catch(() => setHistory([]))
    }, [user])

    useEffect(() => {
        setModel(PROVIDERS[providerDisplay][0])
        setResult(null)
        setAnalysisId(null)
        setDecisions({})
    }, [providerDisplay, useCritic, file])

    async function saveKey() {
        try {
            await api.post("/settings/api-key", { provider, key: apiKey })
            setStatus({ ...status, [provider]: true })
            setApiKey("")
        } catch (err) { setError(getError(err)) }
    }

    async function analyse() {
        if (!file) return
        setBusy(true)
        setError("")
        try {
            const data = new FormData()
            data.append("file", file)
            const upload = await api.post("/analysis/upload", data)
            const run = await api.post("/analysis/run", {
                resume_id: upload.data.resume_id,
                resume_json: upload.data.parsed,
                job_description: jobDescription,
                provider,
                model,
                use_critic: useCritic,
                local_endpoint: provider === "local" ? localEndpoint : "",
            })
            const completed = await waitForAnalysis(run.data.job_id)
            setResult({ ...completed, parsed_resume: upload.data.parsed, job_description: jobDescription, raw_text: upload.data.parsed.raw_text })
            setAnalysisId(completed.analysis_id)
            setDecisions({})
            setView("Rewrite Suggestions")
            const hist = await api.get("/analysis/history")
            setHistory(hist.data)
        } catch (err) { setError(getError(err)) } finally { setBusy(false) }
    }

    if (!user) return <AuthPage />
    const navItems = user.role === "mentor" ? ["Mentor Dashboard", ...NAV_ITEMS.filter(item => item !== "Mentor Dashboard")] : NAV_ITEMS
    return <main className="app-container"><Hero /><div className="model-bar"><label>LLM Model<select className="input-field" value={`${providerDisplay}:${model}`} onChange={e => { const [display, nextModel] = e.target.value.split(":"); setProviderDisplay(display); setModel(nextModel) }}>{Object.entries(PROVIDERS).flatMap(([display, models]) => models.map(item => <option key={`${display}:${item}`} value={`${display}:${item}`}>{display} → {item}</option>))}</select></label><label className="toggle-wrap"><span className={`toggle-track ${useCritic ? "active" : ""}`} onClick={() => setUseCritic(!useCritic)}><span className="toggle-thumb" /></span>Agentic Self-Correction</label>{provider === "local" && <input className="input-field" value={localEndpoint} onChange={e => setLocalEndpoint(e.target.value)} placeholder="Local API Endpoint" />}</div>{needsKey && <div className="card key-card"><span className="section-label">{providerDisplay} API Key Required</span><p className="muted">Enter a key to continue locally. Hosted deployments may disable this in favour of managed credentials.</p><div className="two-col"><input className="input-field" type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={`Paste your ${providerDisplay} API key`} /><button className="btn-primary" onClick={saveKey}>Save API Key</button></div></div>}<ResumeSetup file={file} setFile={setFile} jobDescription={jobDescription} setJobDescription={setJobDescription} onAnalyse={analyse} busy={busy} />{error && <p className="warning-strip">{error}</p>}{result && <><ScoreCard scoreData={result.score} /><ResultsSidebar result={result} user={user} onLogout={logout} /><nav className="nav-bar">{navItems.map(item => <button className={`nav-pill ${view === item ? "active" : ""}`} key={item} onClick={() => setView(item)}>{item}</button>)}</nav>{view === "Rewrite Suggestions" && <RewriteReview result={result} file={file} decisions={decisions} setDecisions={setDecisions} analysisId={analysisId} />}{view === "Keyword Gap" && <KeywordGap result={result} />}{view === "Extracted Sections" && <ExtractedSections result={result} />}{view === "Tailored CV" && <DocumentGenerator type="cv" result={result} provider={provider} model={model} localEndpoint={localEndpoint} decisions={decisions} />}{view === "Cover Letter" && <DocumentGenerator type="cover-letter" result={result} provider={provider} model={model} localEndpoint={localEndpoint} decisions={decisions} />}{view === "Analytics" && <Analytics result={result} history={history} />}{view === "Mentor Dashboard" && (user.role === "mentor" ? <MentorDashboard /> : <p className="warning-strip">Mentor Dashboard is only available to mentor accounts.</p>)}{view === "Job Matching" && <JobMatching result={result} provider={provider} model={model} localEndpoint={localEndpoint} />}</>}</main>
}

export default App
