import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useDropzone } from "react-dropzone"
import ReactMarkdown from "react-markdown"
import {
    MessageSquareText, SearchCheck, FileText, FileEdit, Mail, Briefcase, BarChart3, Users,
    FileOutput, PanelLeftClose, PanelLeftOpen, IdCard, TrendingUp,
    TrendingDown, Check, X, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, UploadCloud, Sparkles,
    ClipboardCheck, Download, CheckCircle2, XCircle, LogIn, LogOut, Loader2, KeyRound, Lightbulb,
    File, RotateCw, Trash2, Clock, PenSquare, Building2, Ban,
} from "lucide-react"
import api from "./api/client"
import { useAuth } from "./context/AuthContext"

// model is fixed per provider server-side now, UI only picks the provider
const PROVIDER_OPTIONS = [
    { key: "default", label: "Default (Free)", byok: false },
    { key: "gemini", label: "Gemini (Own Key)", byok: true },
    { key: "claude", label: "Claude (Own Key)", byok: true },
    { key: "chatgpt", label: "ChatGPT (Own Key)", byok: true },
    { key: "local", label: "Local LLM", byok: false },
]

// the collapsed nav stays a single row of only the core review/generate workflow; the
// less-frequently-needed views live behind the More toggle instead of competing for space
const ALWAYS_NAV = [
    { key: "Suggestions", icon: MessageSquareText },
    { key: "Keyword Gap", icon: SearchCheck },
    { key: "Tailored CV", icon: FileEdit },
    { key: "Cover Letter", icon: Mail },
]
const MORE_NAV = [
    { key: "Insights", icon: BarChart3 },
    { key: "Mentor Feedback", icon: Users },
    { key: "Job Matching", icon: Briefcase },
    { key: "Extracted Sections", icon: FileText },
]
const NAV_ITEMS = [...ALWAYS_NAV, ...MORE_NAV].map(i => i.key)

const PIPELINE_STEPS = [
    { key: "upload", label: "Upload Resume", icon: UploadCloud },
    { key: "analyse", label: "AI Analysis", icon: Sparkles },
    { key: "review", label: "Review Suggestions", icon: ClipboardCheck },
    { key: "generate", label: "Generate Tailored Resume", icon: FileOutput },
    { key: "export", label: "Export", icon: Download },
]

function formatDuration(ms) {
    const totalSeconds = ms / 1000
    if (totalSeconds < 60) return `${totalSeconds.toFixed(1)} s`
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = Math.round(totalSeconds % 60)
    return `${minutes} min ${seconds} s`
}

function getScoreCfg(score) {
    if (score >= 70) return { color: "#3F8F6B", label: "Strong" }
    if (score >= 50) return { color: "#B8853B", label: "Needs work" }
    return { color: "#BC5B57", label: "Needs improvement" }
}

// muted, accessible semantic colors (sage/amber/rose) instead of a harsh continuous
// red-to-green hue ramp, plus a descriptive label so the heatmap never relies on color alone
function heatmapQuality(quality) {
    const q = quality || 0
    if (q >= 85) return { label: "Excellent", color: "#2F7D5C" }
    if (q >= 65) return { label: "Good", color: "#6FA37A" }
    if (q >= 40) return { label: "Fair", color: "#C17F3A" }
    return { label: "Needs Work", color: "#BC5B57" }
}

function getError(err) {
    return err.response?.data?.error || err.message || "Something went wrong."
}

// module-level pub/sub so any component can fire a toast (e.g. after a download) without
// prop-drilling a callback down through the whole tree
const toastListeners = new Set()
function toast(message, kind = "success") {
    const entry = { id: `${Date.now()}_${Math.random()}`, message, kind }
    toastListeners.forEach(fn => fn(entry))
}
function ToastHost() {
    const [toasts, setToasts] = useState([])
    useEffect(() => {
        function add(entry) {
            setToasts(prev => [...prev, entry])
            setTimeout(() => setToasts(prev => prev.filter(t => t.id !== entry.id)), 3200)
        }
        toastListeners.add(add)
        return () => toastListeners.delete(add)
    }, [])
    if (!toasts.length) return null
    return <div className="toast-host">{toasts.map(t => (
        <div className={`toast toast-${t.kind}`} key={t.id}>
            {t.kind === "error" ? <XCircle size={16} /> : <CheckCircle2 size={16} />}
            {t.message}
        </div>
    ))}</div>
}

// blob-typed requests get error responses back as a Blob too, decode it for the real message
async function getBlobError(err) {
    const data = err.response?.data
    if (data instanceof Blob && data.type.includes("json")) {
        try {
            return JSON.parse(await data.text()).error || getError(err)
        } catch {
            return getError(err)
        }
    }
    return getError(err)
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
    const deadline = Date.now() + 10 * 60 * 1000
    return new Promise((resolve, reject) => {
        let attempts = 0
        const poll = async () => {
            try {
                const response = await api.get(`/analysis/jobs/${jobId}`)
                if (response.data.status === "completed") return resolve(response.data.results)
                if (response.data.status === "failed") return reject(new Error(response.data.error || "Analysis failed."))
                if (Date.now() >= deadline) return reject(new Error("Analysis timed out."))
                attempts += 1
                // poll fast at first (batched analysis is usually quick), then back off
                const delay = attempts < 5 ? 1000 : attempts < 15 ? 2000 : 4000
                window.setTimeout(poll, delay)
            } catch (err) {
                reject(err)
            }
        }
        poll()
    })
}

function AuthPage() {
    const { login, register, continueAsGuest } = useAuth()
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

    async function guestContinue() {
        setError("")
        setBusy(true)
        try {
            await continueAsGuest()
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
                    <button className="btn-primary full-width auth-submit-btn" disabled={busy}>{busy ? "Please wait..." : tab === "login" ? "Sign In" : "Create Account"}</button>
                </form>
                <div className="auth-guest-row">
                    <button type="button" className="auth-guest-link" disabled={busy} onClick={guestContinue}>Continue without an account</button>
                    <p className="muted auth-guest-note">Guest sessions aren't tied to an account — you won't be able to sign back in to this session, and any uploaded resumes and analysis are automatically deleted from our servers within 24 hours.</p>
                </div>
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

// one consistent, always-visible sign-in/sign-out control above the Hero, replacing the
// sign-out button that used to appear in three different places (mentor topbar, the
// pre-analysis model bar, and the sidebar) depending on which screen you were on
function AuthBar({ user, onLogout }) {
    return <div className="auth-bar">
        {user ? <>
            <span className="auth-bar-status">{user.is_guest ? "Browsing as " : "Signed in as "}<b>{user.display_name}</b></span>
            <button className="btn-ghost btn-small" onClick={onLogout}>{user.is_guest ? <><LogIn size={13} /> Sign In</> : <><LogOut size={13} /> Sign Out</>}</button>
        </> : <span className="auth-bar-status">Sign In</span>}
    </div>
}

function TopNav({ view, setView, hidden, onShow }) {
    const [moreOpen, setMoreOpen] = useState(false)

    // scrolled far enough that the nav auto-hid itself - show only a floating toggle,
    // identical in style to the sidebar's collapsed toggle, so it never floats over content
    if (hidden) {
        return <button className="nav-floating-toggle" onClick={onShow} title="Show navigation"><PanelLeftOpen size={16} /></button>
    }

    return <nav className="top-nav">
        <div className="nav-row">
            {ALWAYS_NAV.map(({ key, icon: Icon }) => (
                <button className={`nav-pill ${view === key ? "active" : ""}`} key={key} onClick={() => setView(key)}>
                    <Icon size={14} /><span>{key}</span>
                </button>
            ))}
            {moreOpen && <span className="nav-more-label">More</span>}
            {moreOpen && MORE_NAV.map(({ key, icon: Icon }) => (
                <button className={`nav-pill ${view === key ? "active" : ""}`} key={key} onClick={() => setView(key)}>
                    <Icon size={14} /><span>{key}</span>
                </button>
            ))}
            <button className="nav-more-toggle" onClick={() => setMoreOpen(!moreOpen)} title={moreOpen ? "Collapse" : "More"}>
                {moreOpen ? <ChevronLeft size={16} /> : <ChevronDown size={16} />}
            </button>
        </div>
    </nav>
}

function PipelineStepper({ file, busy, result, docs, exported }) {
    let activeIndex = 0
    if (file) activeIndex = 1
    if (result) activeIndex = 2
    if (docs.cv || docs.cover_letter) activeIndex = 3
    if (exported) activeIndex = 4
    if (busy) activeIndex = Math.min(activeIndex, 1)

    return <div className="pipeline-stepper">
        {PIPELINE_STEPS.map((step, idx) => {
            const state = idx < activeIndex ? "done" : idx === activeIndex ? "active" : "upcoming"
            const Icon = step.icon
            return <div className={`pipeline-step ${state}`} key={step.key}>
                <span className="pipeline-step-icon">{state === "done" ? <Check size={13} /> : idx === activeIndex && busy ? <Loader2 size={13} className="spin-icon" /> : <Icon size={13} />}</span>
                <span className="pipeline-step-label">{step.label}</span>
                {idx < PIPELINE_STEPS.length - 1 && <span className="pipeline-step-connector" />}
            </div>
        })}
    </div>
}

// an illustrative sequence, not literal real-time telemetry - the engine returns one
// combined response, so this can't reflect true per-stage progress, but it gives a sense
// of the kind of work happening instead of a single static "please wait" message
const PROCESSING_STAGE_LABELS = ["Extracting keywords…", "Matching sections…", "Rewriting bullets…", "Scoring resume…"]
const BASE_ESTIMATE_SECONDS = 45

// tracks real elapsed time every second, and re-derives the remaining-time estimate every
// 15s - if we've already blown past the current estimate, that means the job is taking
// longer than expected, so nudge the estimate up instead of freezing at "0s remaining"
function useAnalysisProgress() {
    const [elapsed, setElapsed] = useState(0)
    const [estimate, setEstimate] = useState(BASE_ESTIMATE_SECONDS)
    const startRef = useRef(Date.now())
    useEffect(() => {
        const tickId = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000)
        const estimateId = setInterval(() => {
            const nowElapsed = Math.floor((Date.now() - startRef.current) / 1000)
            setEstimate(prev => (nowElapsed >= prev ? nowElapsed + 15 : prev))
        }, 15000)
        return () => { clearInterval(tickId); clearInterval(estimateId) }
    }, [])
    return { elapsed, remaining: Math.max(0, estimate - elapsed) }
}

function ProcessingStages() {
    const [idx, setIdx] = useState(0)
    const { elapsed, remaining } = useAnalysisProgress()
    useEffect(() => {
        const t = setInterval(() => setIdx(i => (i + 1) % PROCESSING_STAGE_LABELS.length), 3500)
        return () => clearInterval(t)
    }, [])
    return <span className="processing-stages">
        <span className="processing-stage-label">{PROCESSING_STAGE_LABELS[idx]}</span>
        <span className="processing-timer"><Clock size={12} /> {elapsed}s elapsed · ~{remaining}s remaining</span>
    </span>
}

function formatFileSize(bytes) {
    if (!bytes && bytes !== 0) return ""
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function ResumeSetup({ file, setFile, jobDescription, setJobDescription, onAnalyse, busy }) {
    const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
        multiple: false,
        noClick: !!file,
        noKeyboard: !!file,
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
        <div className="card">
            <div className="two-col">
                <div>
                    <span className="section-label">Resume PDF / DOCX / ODT / TXT / MD / LinkedIn ZIP</span>
                    <div {...getRootProps()} className={`dropzone ${isDragActive ? "active" : ""} ${file ? "has-file" : ""}`}>
                        <input {...getInputProps()} />
                        {file ? (
                            <div className="upload-card">
                                <span className="upload-card-icon"><File size={20} /></span>
                                <div className="upload-card-info">
                                    <span className="upload-card-name" title={file.name}>{file.name}</span>
                                    <span className="upload-card-meta"><CheckCircle2 size={12} /> {formatFileSize(file.size)} · Uploaded</span>
                                </div>
                                <div className="upload-card-actions">
                                    <button type="button" className="btn-ghost btn-small" onClick={open}><RotateCw size={13} /> Replace</button>
                                    <button type="button" className="upload-card-remove" onClick={() => setFile(null)} title="Remove file"><Trash2 size={15} /></button>
                                </div>
                            </div>
                        ) : "Drop your resume here, or click to upload"}
                    </div>
                </div>
                <div>
                    <span className="section-label">Job Description <small>(optional for ATS matching)</small></span>
                    <textarea className="input-field" value={jobDescription} onChange={e => setJobDescription(e.target.value)} placeholder="Paste a full job description for keyword matching, or leave blank to improve the CV from rewrite decisions only." />
                </div>
            </div>
            <button className="btn-primary analyse-btn" disabled={!file || busy} onClick={() => onAnalyse()}>{busy ? <><span className="spinner" /><ProcessingStages /></> : <><Sparkles size={16} /> Analyse resume</>}</button>
        </div>
    </section>
}

function useCountUp(target, duration = 700) {
    const [display, setDisplay] = useState(target)
    const prevRef = useRef(target)
    useEffect(() => {
        const start = prevRef.current
        if (start === target) return undefined
        const startTime = performance.now()
        let raf
        function tick(now) {
            const progress = Math.min(1, (now - startTime) / duration)
            setDisplay(Math.round(start + (target - start) * progress))
            if (progress < 1) raf = requestAnimationFrame(tick)
            else prevRef.current = target
        }
        raf = requestAnimationFrame(tick)
        return () => cancelAnimationFrame(raf)
    }, [target, duration])
    return display
}

// honest "benchmark": how this score compares to the user's OWN past attempts, rather than
// a fabricated percentile against a population we have no real data for
function ownHistoryStanding(score, history) {
    if (!history || history.length < 2) return null
    const past = history.slice(1)
    if (past.every(h => score > h.score)) return "Your best score yet"
    const better = past.filter(h => h.score < score).length
    if (better === 0) return "Your lowest score yet"
    return `Better than ${Math.round((better / past.length) * 100)}% of your past attempts`
}

function ScoreCard({ scoreData, history }) {
    const score = typeof scoreData === "object" ? scoreData?.total || 0 : scoreData || 0
    const displayScore = useCountUp(score)
    const cfg = getScoreCfg(score)
    const lines = typeof scoreData === "object" ? [
        `Base: ${scoreData.base || 0}`,
        `Sections: +${scoreData.sections || 0}`,
        `Keywords: +${scoreData.keywords || 0}`,
        `Bullet Quality: +${scoreData.bullet_quality || 0}`,
        `Action Verbs: +${scoreData.action_verbs || 0}`,
        `Warnings: ${scoreData.warnings || 0}`,
        `Total: ${score}/100`,
    ] : ["Score breakdown not available"]
    const sectionScores = (typeof scoreData === "object" && scoreData?.section_scores) || {}
    const previousScore = history && history.length > 1 ? history[1].score : null
    const delta = previousScore != null ? score - previousScore : null
    const standing = ownHistoryStanding(score, history)

    return <div className="card score-card">
        <span className="section-label">Resume Score</span>
        <div className="score-tooltip-wrap">
            <div className="score-stack">
                <div className="score-ring" style={{ "--pct": score, "--ring-color": cfg.color }}>
                    <div className="score-ring-inner">
                        <div className="score-number" style={{ color: cfg.color }}>{displayScore}</div>
                        <span className="score-label-text" style={{ color: cfg.color }}>{cfg.label}</span>
                    </div>
                </div>
                <span className="score-sub">out of 100 · hover for breakdown</span>
                {delta !== null && delta !== 0 && (
                    <span className={`score-delta ${delta > 0 ? "up" : "down"}`}>
                        {delta > 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                        {delta > 0 ? "+" : ""}{delta} since last analysis
                    </span>
                )}
                {standing && <span className="score-benchmark">{standing}</span>}
            </div>
            <div className="score-tooltip">
                {lines.map(line => <div key={line}>{line}</div>)}
                {Object.keys(sectionScores).length > 0 && <>
                    <div className="tooltip-divider" />
                    <div className="tooltip-heat-label">Section strength</div>
                    {Object.entries(sectionScores).map(([sec, data]) => {
                        const hq = heatmapQuality(data.quality)
                        return <div className="tooltip-heat-row" key={sec}>
                            <span className="heat-swatch" style={{ background: hq.color }} />
                            <span>{sec[0] + sec.slice(1).toLowerCase()}</span>
                            <span className="tooltip-heat-tag">{hq.label}</span>
                        </div>
                    })}
                </>}
            </div>
        </div>
    </div>
}

function ResumeMetadataModal({ contact, onClose }) {
    // portaled to document.body so it's never a grid/flex sibling of whatever calls it
    // (a plain in-tree overlay here would become an unwanted extra item in .workspace's grid)
    return createPortal(<div className="modal-overlay" onClick={onClose}>
        <div className="modal-panel" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
                <h3 className="modal-title">Resume Metadata</h3>
                <button className="btn-ghost modal-close" onClick={onClose} title="Close"><X size={18} /></button>
            </div>
            <div className="contact-grid">
                {Object.entries(contact).map(([key, value]) => (
                    <span className="contact-chip" key={key} title={String(value)}><b>{key}</b><span className="contact-value">{value}</span></span>
                ))}
            </div>
        </div>
    </div>, document.body)
}

function ResultsSidebar({ result, user, onLogout, history, collapsed, onToggleCollapse }) {
    const sections = result.sections || {}
    const [showMetadata, setShowMetadata] = useState(false)
    const contact = result.contact || {}
    const hasContact = Object.keys(contact).length > 0
    const scoreTotal = typeof result.score === "object" ? result.score?.total || 0 : result.score || 0

    // body scroll locked while the modal is open - besides being standard modal behaviour,
    // this also stops the page scroll that would otherwise auto-collapse the sidebar (see
    // App()'s scroll listener) out from under the just-opened modal
    useEffect(() => {
        if (!showMetadata) return undefined
        const prevOverflow = document.body.style.overflow
        document.body.style.overflow = "hidden"
        return () => { document.body.style.overflow = prevOverflow }
    }, [showMetadata])

    return <>
        {collapsed ? (
            <aside className="sidebar sidebar-collapsed">
                <button className="sidebar-toggle" onClick={onToggleCollapse} title="Expand sidebar"><PanelLeftOpen size={18} /></button>
                <div className="sidebar-collapsed-score" style={{ color: getScoreCfg(scoreTotal).color }} title={`Resume score: ${scoreTotal}/100`}>{scoreTotal}</div>
                <div className="sidebar-collapsed-icons">
                    {["EXPERIENCE", "EDUCATION", "SKILLS", "PROJECTS"].map(name => (
                        <span key={name} className={sections[name] ? "ok-text" : "error-text"} title={`${name[0] + name.slice(1).toLowerCase()}: ${sections[name] ? "found" : "missing"}`}>{sections[name] ? "✓" : "✗"}</span>
                    ))}
                </div>
            </aside>
        ) : (
            <aside className="sidebar">
                <div className="sidebar-top">
                    <span className="sidebar-user">{user.is_guest ? "Browsing as " : "Signed in as "}<b>{user.display_name}</b></span>
                    <div className="sidebar-top-actions">
                        <button className="sidebar-toggle" onClick={onToggleCollapse} title="Collapse sidebar"><PanelLeftClose size={16} /></button>
                        <button className="btn-signout" onClick={onLogout}>{user.is_guest ? <><LogIn size={13} /> Sign In</> : <><LogOut size={13} /> Sign out</>}</button>
                    </div>
                </div>
                <ScoreCard scoreData={result.score} history={history} />
                <div className="sidebar-scroll">
                    <div className="card"><span className="section-label">Parser Status</span>{["EXPERIENCE", "EDUCATION", "SKILLS", "PROJECTS"].map(name => <p key={name} className={sections[name] ? "ok-text" : "error-text"}>{sections[name] ? "✓" : "✗"} {name[0] + name.slice(1).toLowerCase()}</p>)}</div>
                    {hasContact && <button className="btn-ghost sidebar-metadata-btn" onClick={() => setShowMetadata(true)}><IdCard size={14} /> Resume Metadata</button>}
                    {user.role === "candidate" && <SessionJoin />}
                </div>
            </aside>
        )}
        {showMetadata && <ResumeMetadataModal contact={contact} onClose={() => setShowMetadata(false)} />}
    </>
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
    return <div className="card"><span className="section-label">Collaborative Review</span><input className="input-field" value={code} onChange={e => setCode(e.target.value)} placeholder="Enter mentor session code" /><button className="btn-secondary btn-block-gap" onClick={join}>Join Session</button>{message && <p className="muted">{message}</p>}</div>
}

function decisionMark(state) {
    if (state === true) return "✓ "
    if (state === false) return "✗ "
    return "• "
}

function RewriteReview({ result, file, decisions, setDecisions, analysisId }) {
    const [active, setActive] = useState(0)
    const [annotations, setAnnotations] = useState([])
    const [comment, setComment] = useState("")
    const [pdfUrl, setPdfUrl] = useState("")
    const [error, setError] = useState("")
    const [mentorEdits, setMentorEdits] = useState({})
    const actionable = useMemo(() => Object.entries(result.rewrites || {}).flatMap(([section, items]) => items.map((item, index) => ({ section, item, index, key: item.id || `${section}_${index}` })).filter(({ item }) => item.framework_used !== "none" && item.framework_used !== "error" && item.original !== item.rewritten)), [result])
    const count = actionable.length
    const current = actionable[Math.min(active, Math.max(count - 1, 0))]

    // a mentor-suggested rewrite the candidate has already accepted overrides the LLM's own
    // rewrite (see server/routes/generation.js's mentorOverridesFor) - fetched once per
    // analysis and keyed by suggestion_key so the Suggested Rewrite column can show it
    useEffect(() => {
        if (!analysisId) { setMentorEdits({}); return }
        api.get("/mentor/feedback/inbox").then(res => {
            const map = {}
            for (const f of res.data) {
                if (f.feedback_type === "edit" && f.analysis_id === analysisId && f.suggestion_key) map[f.suggestion_key] = f
            }
            setMentorEdits(map)
        }).catch(() => setMentorEdits({}))
    }, [analysisId])

    // reset to the first suggestion on a fresh analysis instead of a stale index
    useEffect(() => { setActive(0) }, [analysisId])

    useEffect(() => {
        if (!analysisId || !current) return
        api.get(`/annotations/${analysisId}`).then(res => setAnnotations(res.data.filter(item => item.key === current.key))).catch(() => setAnnotations([]))
    }, [analysisId, current?.key])

    useEffect(() => {
        let cancelled = false
        let createdUrl = ""
        if (!file || file.type !== "application/pdf" || !current) {
            setPdfUrl("")
            return undefined
        }
        async function render() {
            let url = ""
            try {
                const items = actionable.map(({ key, item }) => ({
                    id: key,
                    text: item.highlight_text || item.original || "",
                    severity: item.severity || "yellow",
                    reasoning: item.reasoning || "",
                    rewritten: item.rewritten || "",
                }))
                const res = await api.post("/analysis/highlight", { file: await fileToBase64(file), items, active_key: current.key }, { responseType: "blob" })
                const activePage = res.headers["x-active-page"]
                url = URL.createObjectURL(res.data) + (activePage ? `#page=${activePage}` : "")
            } catch {
                url = URL.createObjectURL(file)
            }
            // a newer suggestion may have been selected while this request was in flight -
            // drop the now-stale result instead of clobbering the fresher preview with it
            if (cancelled) {
                URL.revokeObjectURL(url.split("#")[0])
                return
            }
            createdUrl = url
            setPdfUrl(url)
        }
        render()
        return () => {
            cancelled = true
            if (createdUrl) URL.revokeObjectURL(createdUrl.split("#")[0])
        }
    }, [file, current?.key, actionable])

    async function save(next) {
        setDecisions(next)
        setError("")
        if (!analysisId) return
        try {
            await api.post(`/analysis/${analysisId}/decisions`, { decisions: next })
        } catch (err) {
            setError(`Couldn't save your decision: ${getError(err)}`)
        }
    }

    // deciding auto-advances to the next suggestion, one click per bullet instead of two
    async function decide(value) {
        if (!current) return
        await save({ ...decisions, [current.key]: value })
        if (count > 1) setActive((active + 1) % count)
    }

    async function postComment() {
        if (!comment.trim() || !analysisId || !current) return
        setError("")
        try {
            await api.post("/annotations", { analysis_id: analysisId, suggestion_key: current.key, comment })
            setComment("")
            const res = await api.get(`/annotations/${analysisId}`)
            setAnnotations(res.data.filter(item => item.key === current.key))
        } catch (err) {
            setError(`Couldn't post comment: ${getError(err)}`)
        }
    }

    // A = accept, D = dismiss, arrows = prev/next - ignored while typing in a field so it
    // never hijacks the annotation comment box or anywhere else text is being entered
    useEffect(() => {
        function onKeyDown(e) {
            const tag = (e.target.tagName || "").toLowerCase()
            if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable) return
            if (e.key === "a" || e.key === "A") decide(true)
            else if (e.key === "d" || e.key === "D") decide(false)
            else if (e.key === "ArrowLeft") setActive(a => (a - 1 + count) % count)
            else if (e.key === "ArrowRight") setActive(a => (a + 1) % count)
        }
        window.addEventListener("keydown", onKeyDown)
        return () => window.removeEventListener("keydown", onKeyDown)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [current?.key, count, decisions])

    if (!count) return <div className="card muted">No rewrite-worthy sentences were detected. Header and label lines were skipped.</div>
    const state = decisions[current.key]
    const reviewedCount = actionable.filter(({ key }) => decisions[key] !== undefined).length
    return <>
        <h2 className="view-title">Review Suggestions</h2>
        {error && <p className="error-msg">{error}</p>}
        <div className="review-toolbar">
            <span className="review-progress">{reviewedCount} of {count} reviewed</span>
            <span className="status-chip accepted-chip">{Object.values(decisions).filter(v => v).length} accepted</span>
            <span className="status-chip dismissed-chip">{Object.values(decisions).filter(v => v === false).length} dismissed</span>
            <span className="toolbar-spacer" />
            <span className="kbd-hint"><kbd>A</kbd> accept · <kbd>D</kbd> dismiss · <kbd>←</kbd><kbd>→</kbd> navigate</span>
            <button className="btn-secondary" onClick={() => save(Object.fromEntries(actionable.map(({ key }) => [key, true])))}>Accept all</button>
            <button className="btn-ghost" onClick={() => save({})}>Clear decisions</button>
        </div>
        <div className="two-col-pdf"><div><span className="section-label">Highlighted Resume</span>{pdfUrl ? <div className="pdf-shell"><iframe className="pdf-frame" src={pdfUrl} title="Uploaded resume" /></div> : <div className="card muted">Source preview is available for PDF uploads. Parsed content remains available under Extracted Sections.</div>}</div>
            <div>
                <div className="review-nav">
                    <button className="btn-secondary btn-arrow" onClick={() => setActive((active - 1 + count) % count)} title="Previous suggestion"><ChevronLeft size={16} /></button>
                    <select
                        className="input-field suggestion-jump"
                        value={Math.min(active, count - 1)}
                        onChange={e => setActive(Number(e.target.value))}
                    >
                        {actionable.map(({ section, item, key }, idx) => (
                            <option key={key} value={idx}>
                                {decisionMark(decisions[key])}{idx + 1} of {count} · {section} · {(item.original || "").slice(0, 48)}{(item.original || "").length > 48 ? "…" : ""}
                            </option>
                        ))}
                    </select>
                    <button className="btn-secondary btn-arrow" onClick={() => setActive((active + 1) % count)} title="Next suggestion"><ChevronRight size={16} /></button>
                </div>
                <span className="section-label">Rewrite Decision</span>
                <div className={`suggestion-card ${state === true ? "accepted" : state === false ? "dismissed" : ""}`} key={current.key}>
                    <div className="suggestion-head">
                        <span className="suggestion-title"><span className={`severity-dot ${current.item.severity || "yellow"}`} />{current.section}</span>
                        {state === true && <span className="status-pill status-pill-accepted"><CheckCircle2 size={12} /> Accepted</span>}
                        {state === false && <span className="status-pill status-pill-rejected"><XCircle size={12} /> Rejected</span>}
                        <span className="fw-badge">{current.item.framework_used}</span>
                    </div>
                    <details className="rewrite-details" open>
                        <summary>Original vs. suggested rewrite</summary>
                        <div className="rewrite-grid">
                            <div className="rewrite-pane before"><span className="pane-label">Original</span><p className="rewrite-text">{current.item.original}</p></div>
                            <div className="rewrite-pane after">
                                <span className="pane-label">Suggested rewrite</span>
                                {mentorEdits[current.key]?.status === "accepted" ? (
                                    <>
                                        <p className="rewrite-text rewrite-text-strike">{current.item.rewritten}</p>
                                        <p className="rewrite-text mentor-rewrite-text"><Users size={12} /> {mentorEdits[current.key].suggested_text}</p>
                                    </>
                                ) : <p className="rewrite-text">{current.item.rewritten}</p>}
                            </div>
                        </div>
                    </details>
                    <div className="reasoning-row"><Lightbulb size={13} /> {current.item.reasoning}</div>
                </div>
                <div className="decision-actions">
                    <button className={state === false ? "btn-outline-primary btn-accept" : "btn-primary btn-accept"} onClick={() => decide(true)}><Check size={16} /> Accept &amp; next</button>
                    <button className="btn-ghost" onClick={() => decide(false)}><X size={15} /> Dismiss &amp; next</button>
                </div>
                <AnnotationThread annotations={annotations} comment={comment} setComment={setComment} postComment={postComment} />
            </div>
        </div></>
}

function AnnotationThread({ annotations, comment, setComment, postComment }) {
    return <div className="annotation-thread"><span className="section-label">Discussion</span>{annotations.map(annotation => <div className="annotation-card" key={annotation.id}><span className="ann-user">{annotation.user}</span><span className="ann-time">{String(annotation.time).slice(0, 16).replace("T", " ")}</span><div className="ann-body">{annotation.comment}</div></div>)}<div className="annotation-input"><input className="input-field" value={comment} onChange={e => setComment(e.target.value)} placeholder="Add a comment" /><button className="btn-secondary" onClick={postComment}>Post Comment</button></div></div>
}

function KeywordGap({ result }) {
    const keywords = result.jd_keywords || []
    if (!keywords.length) {
        if (result.keyword_extraction_failed) return <><h2 className="view-title">Keyword Gap</h2><p className="warning-strip">Keyword extraction from the job description failed (the model may be rate-limited or temporarily unavailable). Re-run the analysis to try again.</p></>
        return <><h2 className="view-title">Keyword Gap</h2><p className="muted">Paste a job description above and re-analyse to see keyword gaps.</p></>
    }
    const missing = result.missing_keywords || []
    const present = keywords.filter(item => !missing.includes(item))
    const coverage = Math.round(present.length / keywords.length * 100)
    return <><h2 className="view-title">Keyword Gap</h2><div className="card"><span className="section-label">Coverage</span><p className="metric-value">{coverage}%</p><p className="muted">{present.length} of {keywords.length} JD keywords present in your resume</p></div><div className="two-col"><div><span className="section-label"><XCircle size={13} /> Missing ({missing.length})</span><div className="kw-wrap">{missing.map(item => <span className="kw-missing" key={item}>{item}</span>)}</div></div><div><span className="section-label"><CheckCircle2 size={13} /> Present ({present.length})</span><div className="kw-wrap">{present.map(item => <span className="kw-present" key={item}>{item} ({result.keyword_frequencies?.[item] || 0})</span>)}</div></div></div></>
}

function ExtractedSections({ result }) {
    return <div><h2 className="view-title">Extracted Sections</h2>{Object.entries(result.sections || {}).map(([name, lines]) => <details className="card" key={name} open={name === "EXPERIENCE"}><summary>{name}</summary><pre className="section-pre">{lines.join("\n")}</pre></details>)}</div>
}

function downloadText(text, filename) {
    const href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }))
    const link = document.createElement("a")
    link.href = href
    link.download = filename
    link.click()
    URL.revokeObjectURL(href)
}

function SavedIndicator({ state }) {
    if (state === "idle") return null
    if (state === "error") return <span className="saved-indicator error"><XCircle size={12} /> Save failed</span>
    return <span className={`saved-indicator ${state}`}>{state === "saving" ? <><Loader2 size={12} className="spin-icon" /> Saving…</> : <><CheckCircle2 size={12} /> Saved</>}</span>
}

function DocumentGenerator({ type, result, provider, localEndpoint, decisions, analysisId, text, setText, onExport, fullName, company }) {
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState("")
    const [mobileTab, setMobileTab] = useState("edit")
    const [saveState, setSaveState] = useState("idle")
    const title = type === "cv" ? "Tailored CV" : "Cover Letter"
    const documentType = type === "cv" ? "cv" : "cover_letter"
    const firstRun = useRef(true)
    // FULL_NAME_RESUME for the generated CV, FULL_NAME_COMPANY_NAME for the cover letter -
    // applied consistently across every export format
    const baseFilename = type === "cv"
        ? `${toFilenamePart(fullName)}_RESUME`
        : `${toFilenamePart(fullName)}_${company ? toFilenamePart(company) : "COVER_LETTER"}`

    useEffect(() => {
        if (firstRun.current) { firstRun.current = false; return undefined }
        const id = analysisId || result.analysis_id
        if (!text || !id) return undefined
        setSaveState("saving")
        const t = setTimeout(async () => {
            try {
                await api.post("/generate/save", { analysis_id: id, document_type: documentType, content: text })
                setSaveState("saved")
            } catch {
                setSaveState("error")
            }
        }, 600)
        return () => clearTimeout(t)
    }, [text])

    async function generate() {
        setBusy(true)
        setError("")
        try {
            const endpoint = type === "cv" ? "/generate/cv" : "/generate/cover-letter"
            const payload = {
                resume_json: result.parsed_resume,
                job_description: result.job_description || "",
                provider,
                local_endpoint: localEndpoint,
                analysis_id: analysisId || result.analysis_id,
            }
            if (type === "cv") {
                payload.rewrite_suggestions = result.rewrites
                payload.rewrite_decisions = decisions
                payload.acc_map = {}
            } else if (company) {
                payload.company = company
            }
            const res = await api.post(endpoint, payload)
            setText(type === "cv" ? res.data.cv_text : res.data.cover_letter_text)
        } catch (err) {
            setError(getError(err))
        } finally {
            setBusy(false)
        }
    }

    async function downloadExport(kind) {
        try {
            const res = await api.post(`/generate/${kind}`, { text, filename: `${baseFilename}.${kind}` }, { responseType: "blob" })
            const href = URL.createObjectURL(res.data)
            const link = document.createElement("a")
            link.href = href
            link.download = `${baseFilename}.${kind}`
            link.click()
            URL.revokeObjectURL(href)
            onExport?.()
            toast(`${kind.toUpperCase()} downloaded`)
        } catch (err) {
            setError(`Export failed: ${await getBlobError(err)}`)
        }
    }

    return <section>
        <h2 className="view-title">Generate {title}</h2>
        <p className="muted">{type === "cv" ? "The generated CV applies accepted rewrites and keeps dismissed original text. Your last generated version is saved automatically." : "Generate a professional cover letter tailored to the job description. Your last generated version is saved automatically."}</p>
        <button className="btn-primary generate-btn" disabled={busy} onClick={generate}>{busy ? <><span className="spinner" />Generating — usually under a minute...</> : text ? `Regenerate ${title}` : `Generate ${title}`}</button>
        {error && <p className="error-msg">{error}</p>}
        {text && <>
            <div className="split-editor-head">
                <div className="mobile-editor-toggle">
                    <button className={mobileTab === "edit" ? "active" : ""} onClick={() => setMobileTab("edit")}>Edit</button>
                    <button className={mobileTab === "preview" ? "active" : ""} onClick={() => setMobileTab("preview")}>Preview</button>
                </div>
                <SavedIndicator state={saveState} />
            </div>
            <div className="split-editor">
                <div className={`split-editor-pane ${mobileTab === "edit" ? "" : "mobile-hidden"}`}>
                    <h3 className="doc-subhead">Edit Your {title}</h3>
                    <textarea className="input-field doc-editor" value={text} onChange={e => setText(e.target.value)} />
                </div>
                <div className={`split-editor-pane ${mobileTab === "preview" ? "" : "mobile-hidden"}`}>
                    <h3 className="doc-subhead">Preview</h3>
                    <article className="card markdown-preview doc-preview">
                        <ReactMarkdown>{text}</ReactMarkdown>
                    </article>
                </div>
            </div>
            <div className="export-row">
                <button className="btn-dark" onClick={() => { downloadText(text, `${baseFilename}.md`); onExport?.(); toast("Markdown downloaded") }}><FileText size={15} /> Markdown</button>
                <button className="btn-dark" onClick={() => downloadExport("docx")}><FileEdit size={15} /> DOCX</button>
                <button className="btn-dark" onClick={() => downloadExport("pdf")}><FileOutput size={15} /> PDF</button>
            </div>
        </>}
    </section>
}

const SECTION_ORDER = [
    "EXPERIENCE", "PROJECTS", "EDUCATION", "SKILLS", "SUMMARY", "CERTIFICATIONS",
    "AWARDS", "PUBLICATIONS", "VOLUNTEER", "LANGUAGES", "INTERESTS", "REFERENCES",
]

function Insights({ result, history, decisions }) {
    const timing = result.timing || {}
    const [consent, setConsent] = useState(false)
    const [confidence, setConfidence] = useState("")
    const [comment, setComment] = useState("")
    const [submitted, setSubmitted] = useState(false)
    const [error, setError] = useState("")
    const [overview, setOverview] = useState(null)

    useEffect(() => {
        api.get("/analysis/insights/overview").then(res => setOverview(res.data.analyses || [])).catch(() => setOverview([]))
    }, [])

    async function submitFeedback() {
        setError("")
        try {
            await api.post("/feedback", { analysis_id: result.analysis_id, consent, confidence, comment })
            setSubmitted(true)
        } catch (err) {
            setError(getError(err))
        }
    }

    const sectionCols = overview ? (() => {
        const present = new Set(overview.flatMap(a => Object.keys(a.score?.section_scores || {})))
        return [...SECTION_ORDER.filter(s => present.has(s)), ...[...present].filter(s => !SECTION_ORDER.includes(s)).sort()]
    })() : []

    const jdKeywords = result.jd_keywords || []
    const missingKeywords = result.missing_keywords || []
    const atsMatch = jdKeywords.length ? Math.round(((jdKeywords.length - missingKeywords.length) / jdKeywords.length) * 100) : null

    const gradedSections = Object.entries(result.score?.section_scores || {}).filter(([, d]) => d.bullet_count > 0)
    let strongest = null, weakest = null
    for (const [sec, d] of gradedSections) {
        if (!strongest || d.quality > strongest.quality) strongest = { sec, quality: d.quality }
        if (!weakest || d.quality < weakest.quality) weakest = { sec, quality: d.quality }
    }

    let mostImproved = null
    if (overview && overview.length >= 2) {
        const latest = overview[overview.length - 1]
        const prior = overview[overview.length - 2]
        for (const [sec, d] of Object.entries(latest.score?.section_scores || {})) {
            const priorQ = prior.score?.section_scores?.[sec]?.quality
            if (priorQ == null) continue
            const delta = d.quality - priorQ
            if (delta > 0 && (!mostImproved || delta > mostImproved.delta)) mostImproved = { sec, delta }
        }
    }

    const decisionValues = Object.values(decisions || {})
    const acceptedCount = decisionValues.filter(v => v === true).length
    const dismissedCount = decisionValues.filter(v => v === false).length
    const titleCase = s => s[0] + s.slice(1).toLowerCase()

    return <section>
        <h2 className="view-title">Insights</h2>

        <div className="metric-grid">
            <div className="stat-card">
                <span className="stat-label">ATS Match</span>
                <span className="stat-value">{atsMatch !== null ? `${atsMatch}%` : "—"}</span>
                <span className="stat-caption">{atsMatch !== null ? `${jdKeywords.length - missingKeywords.length} of ${jdKeywords.length} JD keywords present` : "No job description provided"}</span>
            </div>
            <div className="stat-card">
                <span className="stat-label">Keyword Coverage</span>
                <span className="stat-value">{atsMatch !== null ? `${atsMatch}%` : "—"}</span>
                <span className="stat-caption">{atsMatch === null ? "Add a job description to see this" : missingKeywords.length ? `${missingKeywords.length} keywords missing` : "All keywords covered"}</span>
            </div>
            <div className="stat-card">
                <span className="stat-label">Strongest Section</span>
                <span className="stat-value stat-value-text">{strongest ? titleCase(strongest.sec) : "—"}</span>
                <span className="stat-caption">{strongest ? `${strongest.quality}% quality` : "Not enough data yet"}</span>
            </div>
            <div className="stat-card">
                <span className="stat-label">Weakest Section</span>
                <span className="stat-value stat-value-text">{weakest ? titleCase(weakest.sec) : "—"}</span>
                <span className="stat-caption">{weakest ? `${weakest.quality}% quality` : "Not enough data yet"}</span>
            </div>
            <div className="stat-card">
                <span className="stat-label">Most Improved Section</span>
                <span className="stat-value stat-value-text">{mostImproved ? titleCase(mostImproved.sec) : "—"}</span>
                <span className="stat-caption">{mostImproved ? `+${mostImproved.delta}% since last attempt` : "Run a second analysis to compare"}</span>
            </div>
            <div className="stat-card">
                <span className="stat-label">Suggestions Reviewed</span>
                <span className="stat-value"><span className="stat-accept">{acceptedCount}</span> / <span className="stat-dismiss">{dismissedCount}</span></span>
                <span className="stat-caption">accepted / dismissed</span>
            </div>
        </div>

        <h3 className="doc-subhead">Resume Score History</h3>
        <div className="card history-list">{history.length ? history.map((item, index) => <div key={item.id || index}><b>Attempt {history.length - index}</b><span className="tabular-num">{item.score}/100</span><small>{String(item.created_at || "").slice(0, 16)}</small></div>) : <p className="muted">Run more analyses to see score progression.</p>}</div>

        <h3 className="doc-subhead">Readability &amp; Quality Heatmap</h3>
        <p className="muted">How strong each section's writing has been across your attempts. Each row is one attempt, oldest first.</p>
        {overview && overview.length > 0 && sectionCols.length > 0 ? <div className="heatmap-table-wrap"><table className="heatmap-table"><thead><tr><th>Attempt</th>{sectionCols.map(sec => <th key={sec}>{titleCase(sec)}</th>)}</tr></thead><tbody>{overview.map((a, idx) => <tr key={a.id}><td className="heatmap-row-label"><b>#{idx + 1}</b><small>{String(a.created_at || "").slice(0, 10)}</small></td>{sectionCols.map(sec => {
            const cell = a.score?.section_scores?.[sec]
            if (!cell) return <td key={sec}><div className="heatmap-square empty">—</div></td>
            const hq = heatmapQuality(cell.quality)
            return <td key={sec}><div className="heatmap-square" style={{ background: hq.color }} title={`${hq.label} — ${cell.quality}%`}>
                <span className="heatmap-square-pct">{cell.quality}%</span>
                <span className="heatmap-square-label">{hq.label}</span>
            </div></td>
        })}</tr>)}</tbody></table></div> : <p className="muted">{overview ? "Run more analyses to build up the heatmap." : "Loading…"}</p>}

        <details className="card technical-details">
            <summary>Technical Details</summary>
            <div className="three-col tech-metric-grid">{Object.entries(timing).map(([key, value]) => <div className="tech-metric" key={key}><div className="tech-metric-value">{formatDuration(value)}</div><div className="metric-label">{key.replace("_ms", "").replace("_", " ")}</div></div>)}</div>
        </details>

        <div className="card evaluation-card"><span className="section-label">Optional Evaluation</span><p className="muted">Share anonymised confidence feedback without including your resume content.</p>{submitted ? <p className="success-msg">Thanks for your feedback.</p> : <><label className="toggle-wrap"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />I consent to store this evaluation response.</label><label className="form-group">Confidence in these recommendations<span className="confidence-scale-hint">1 = Worst · 5 = Best</span><select className="input-field" value={confidence} onChange={e => setConfidence(e.target.value)}><option value="">Select a rating</option>{[1, 2, 3, 4, 5].map(value => <option value={value} key={value}>{value}</option>)}</select></label><textarea className="input-field" value={comment} onChange={e => setComment(e.target.value)} placeholder="Optional qualitative feedback" />{error && <p className="error-msg">{error}</p>}<button className="btn-secondary btn-block-gap" disabled={!consent} onClick={submitFeedback}>Submit Feedback</button></>}</div>
    </section>
}

function DiffView({ diff }) {
    return <pre className="diff-block">{diff.map((line, idx) => (
        <div key={idx} className={`diff-line ${line.type}`}>
            <span className="diff-sign">{line.type === "added" ? "+" : line.type === "removed" ? "−" : " "}</span>{line.text}
        </div>
    ))}</pre>
}

function FeedbackComposer({ candidateId, analysisId, prefill, onSent }) {
    const [type, setType] = useState(prefill?.type || "comment")
    const [section, setSection] = useState(prefill?.section || "")
    const [originalText, setOriginalText] = useState(prefill?.original || "")
    const [suggestedText, setSuggestedText] = useState("")
    const [comment, setComment] = useState("")
    const [status, setStatus] = useState("")

    useEffect(() => {
        if (prefill) {
            setType(prefill.type || "comment")
            setSection(prefill.section || "")
            setOriginalText(prefill.original || "")
        }
    }, [prefill])

    async function send() {
        setStatus("")
        try {
            await api.post("/mentor/feedback", {
                candidate_id: candidateId,
                analysis_id: analysisId || null,
                suggestion_key: prefill?.key || "",
                feedback_type: type,
                section,
                original_text: originalText,
                suggested_text: suggestedText,
                comment,
            })
            setStatus("Sent.")
            setSuggestedText("")
            setComment("")
            onSent?.(suggestedText)
        } catch (err) {
            setStatus(getError(err))
        }
    }

    return <div className="card composer">
        <span className="section-label">Send Feedback to Candidate</span>
        <div className="composer-row">
            <select className="input-field composer-type" value={type} onChange={e => setType(e.target.value)}>
                <option value="comment">Comment</option>
                <option value="edit">Suggested edit</option>
            </select>
            <input className="input-field" value={section} onChange={e => setSection(e.target.value)} placeholder="Section (e.g. EXPERIENCE, optional)" />
        </div>
        {type === "edit" && <>
            <textarea className="input-field composer-area" value={originalText} onChange={e => setOriginalText(e.target.value)} placeholder="Original text this edit applies to" />
            <textarea className="input-field composer-area" value={suggestedText} onChange={e => setSuggestedText(e.target.value)} placeholder="Your suggested replacement text" />
        </>}
        <textarea className="input-field composer-area" value={comment} onChange={e => setComment(e.target.value)} placeholder={type === "edit" ? "Why this edit helps (optional)" : "Your feedback"} />
        <div className="composer-actions">
            <button className="btn-primary" onClick={send}>Send Feedback</button>
            {status && <span className="muted">{status}</span>}
        </div>
    </div>
}

function CandidateDetail({ candidate, onBack }) {
    const [history, setHistory] = useState(null)
    const [analysis, setAnalysis] = useState(null)
    const [diffFrom, setDiffFrom] = useState("")
    const [diffTo, setDiffTo] = useState("")
    const [diff, setDiff] = useState(null)
    const [sent, setSent] = useState([])
    const [error, setError] = useState("")
    // item 17: Analysis History collapsed by default, opening a resume re-collapses it
    const [historyOpen, setHistoryOpen] = useState(false)
    // item 18: More menu (Analysis / Extracted Sections / Accepted AI Suggestions / Cover Letters)
    const [moreOpen, setMoreOpen] = useState(false)
    const [moreTab, setMoreTab] = useState("analysis")
    const [coverLetters, setCoverLetters] = useState(null)
    // item 18: Original PDF <-> Rewritten Preview toggle, directly editable
    const [previewMode, setPreviewMode] = useState("original")
    const [pdfUrl, setPdfUrl] = useState("")
    const [previewMarkdown, setPreviewMarkdown] = useState("")
    const [previewEdited, setPreviewEdited] = useState("")
    const [previewDirty, setPreviewDirty] = useState(false)
    // item 18: per-suggestion "Suggest Edit" pill -> attached composer
    const [activeComposerKey, setActiveComposerKey] = useState(null)
    // item 18: floating Compose button for general feedback unrelated to any suggestion
    const [composeOpen, setComposeOpen] = useState(false)

    async function load() {
        try {
            const [historyRes, sentRes] = await Promise.all([
                api.get(`/mentor/candidates/${candidate.id}/history`),
                api.get(`/mentor/feedback?candidate_id=${candidate.id}`),
            ])
            setHistory(historyRes.data)
            setSent(sentRes.data)
        } catch (err) { setError(getError(err)) }
    }
    useEffect(() => { load() }, [candidate.id])

    async function openAnalysis(id) {
        try {
            const res = await api.get(`/mentor/candidates/${candidate.id}/analyses/${id}`)
            setAnalysis(res.data)
            setDiff(null)
            setHistoryOpen(false)
            setPreviewMode("original")
            setPreviewDirty(false)
            setActiveComposerKey(null)
        } catch (err) { setError(getError(err)) }
    }

    // loads the highlighted original PDF and the rewritten-preview markdown for whichever
    // analysis is currently open - both mirror what the candidate's own views render
    useEffect(() => {
        if (!analysis) { setPdfUrl(""); setPreviewMarkdown(""); setPreviewEdited(""); return undefined }
        let cancelled = false
        const items = Object.entries(analysis.results?.rewrites || {}).flatMap(([, list]) =>
            list.filter(it => it.framework_used !== "none" && it.framework_used !== "error").map(it => ({
                id: it.id, text: it.highlight_text || it.original || "", severity: it.severity || "yellow",
                reasoning: it.reasoning || "", rewritten: it.rewritten || "",
            }))
        )
        async function loadPdf() {
            try {
                const fileRes = await api.get(`/mentor/candidates/${candidate.id}/resumes/${analysis.resume_id}/file`, { responseType: "blob" })
                const fileB64 = await fileToBase64(fileRes.data)
                const hlRes = await api.post("/analysis/highlight", { file: fileB64, items, active_key: "" }, { responseType: "blob" })
                if (!cancelled) setPdfUrl(URL.createObjectURL(hlRes.data))
            } catch { if (!cancelled) setPdfUrl("") }
        }
        async function loadPreview() {
            try {
                const res = await api.get(`/mentor/candidates/${candidate.id}/analyses/${analysis.id}/preview`)
                if (!cancelled) { setPreviewMarkdown(res.data.markdown); setPreviewEdited(res.data.markdown) }
            } catch { if (!cancelled) { setPreviewMarkdown(""); setPreviewEdited("") } }
        }
        loadPdf()
        loadPreview()
        return () => { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [analysis?.id])

    async function runDiff() {
        if (!diffFrom || !diffTo) return
        try {
            const res = await api.get(`/mentor/candidates/${candidate.id}/diff?from=${diffFrom}&to=${diffTo}`)
            setDiff(res.data)
            setAnalysis(null)
        } catch (err) { setError(getError(err)) }
    }

    // "Done" converts the mentor's preview edits into a Suggested Edit for the candidate to
    // review, and updates the mentor's own preview immediately - "Discard" drops only these
    // preview edits, leaving any general feedback already sent untouched either way
    async function doneEditing() {
        if (!previewDirty) { setPreviewMode("original"); return }
        try {
            await api.post("/mentor/feedback", {
                candidate_id: candidate.id,
                analysis_id: analysis.id,
                suggestion_key: `preview:${analysis.id}`,
                feedback_type: "edit",
                section: "Full Resume Preview",
                original_text: previewMarkdown,
                suggested_text: previewEdited,
                comment: "Mentor-edited rewritten preview",
            })
            setPreviewMarkdown(previewEdited)
            setPreviewDirty(false)
            setPreviewMode("original")
            toast("Suggested edits sent to candidate")
            await load()
        } catch (err) { setError(getError(err)) }
    }

    function discardEditing() {
        setPreviewEdited(previewMarkdown)
        setPreviewDirty(false)
        setPreviewMode("original")
    }

    async function openMoreTab(tab) {
        setMoreOpen(true)
        setMoreTab(tab)
        if (tab === "coverletters" && !coverLetters) {
            try { setCoverLetters((await api.get(`/mentor/candidates/${candidate.id}/cover-letters`)).data) } catch (err) { setError(getError(err)) }
        }
    }

    const analyses = history?.analyses || []
    const rewrites = analysis?.results?.rewrites || {}
    const decisions = analysis?.results?.decisions || {}
    const acceptedItems = Object.entries(rewrites).flatMap(([section, items]) => items.filter(it => decisions[it.id] === true).map(it => ({ ...it, section })))

    // Current vs Previous Feedback (item 18) - same split logic as the candidate's own inbox
    const sentCurrentAttempt = sent.reduce((max, f) => Math.max(max, f.attempt_number || 0), 0)
    const sentCurrent = sent.filter(f => f.attempt_number === sentCurrentAttempt)
    const sentPrevious = sent.filter(f => f.attempt_number !== sentCurrentAttempt).sort((a, b) => new Date(a.created_at) - new Date(b.created_at))

    function renderSentItem(f) {
        return <div className={`card feedback-item ${f.status}`} key={f.id}>
            <div className="feedback-meta">
                <span className="fw-badge">{capitalize(f.feedback_type)}</span>
                {f.section && <span className="status-chip">{f.section}</span>}
                <span className={`status-chip status-${f.status}`}>{capitalize(f.status)}</span>
                {f.attempt_number && <span className="feedback-attempt-meta">Attempt #{f.attempt_number} &bull; {formatShortDate(f.created_at)}</span>}
            </div>
            {f.feedback_type === "edit" && <div className="rewrite-grid"><div className="rewrite-pane before"><span className="pane-label">Original</span><p className="rewrite-text">{f.original_text}</p></div><div className="rewrite-pane after"><span className="pane-label">Suggested</span><p className="rewrite-text">{f.suggested_text}</p></div></div>}
            {f.comment && <p className="feedback-comment">{f.comment}</p>}
        </div>
    }

    return <section className="mentor-workspace">
        <div className="detail-head">
            <button className="btn-secondary" onClick={onBack}>← All candidates</button>
            <h3 className="detail-title">{candidate.name}</h3>
        </div>
        {error && <p className="warning-strip">{error}</p>}
        <div className="two-col">
            <div>
                <details className="card" open={historyOpen} onToggle={e => setHistoryOpen(e.currentTarget.open)}>
                    <summary>Analysis History {historyOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</summary>
                    <div className="mentor-history-table-wrap"><table><thead><tr><th>Date</th><th>Score</th><th>Model</th><th /></tr></thead><tbody>
                        {analyses.map(a => <tr key={a.id}>
                            <td>{String(a.created_at || "").slice(0, 16)}</td>
                            <td style={{ color: getScoreCfg(a.score_total).color, fontWeight: 700 }}>{a.score_total}</td>
                            <td>{a.provider}{a.model ? ` / ${a.model}` : ""}</td>
                            <td><button className="btn-secondary btn-small" onClick={() => openAnalysis(a.id)}>Open</button></td>
                        </tr>)}
                        {!analyses.length && <tr><td colSpan={4} className="muted">No analyses yet.</td></tr>}
                    </tbody></table></div>
                </details>
                <span className="section-label">Compare Revisions</span>
                <div className="card">
                    <div className="composer-row">
                        <select className="input-field" value={diffFrom} onChange={e => setDiffFrom(e.target.value)}>
                            <option value="">Before…</option>
                            {analyses.map(a => <option key={a.id} value={a.id}>#{a.id} · {String(a.created_at).slice(0, 16)} · {a.score_total}/100</option>)}
                        </select>
                        <select className="input-field" value={diffTo} onChange={e => setDiffTo(e.target.value)}>
                            <option value="">After…</option>
                            {analyses.map(a => <option key={a.id} value={a.id}>#{a.id} · {String(a.created_at).slice(0, 16)} · {a.score_total}/100</option>)}
                        </select>
                        <button className="btn-primary" onClick={runDiff} disabled={!diffFrom || !diffTo || diffFrom === diffTo}>Compare</button>
                    </div>
                </div>
                <span className="section-label">Feedback Sent</span>
                <div className="feedback-list">
                    {sentCurrent.length ? sentCurrent.map(renderSentItem) : <p className="muted">No feedback sent yet for the current attempt.</p>}
                </div>
                {sentPrevious.length > 0 && <details className="card previous-feedback">
                    <summary>Previous Feedback ({sentPrevious.length})</summary>
                    <div className="feedback-list">{sentPrevious.map(renderSentItem)}</div>
                </details>}
            </div>
            <div>
                {diff && <>
                    <span className="section-label">Resume Diff · #{diff.from.id} ({diff.from.score}/100) → #{diff.to.id} ({diff.to.score}/100)</span>
                    {diff.sections.map(sec => {
                        const changed = sec.diff.some(l => l.type !== "same")
                        if (!changed) return null
                        return <details className="card" key={sec.section} open><summary>{sec.section}</summary><DiffView diff={sec.diff} /></details>
                    })}
                    {!diff.sections.some(sec => sec.diff.some(l => l.type !== "same")) && <p className="muted">No differences between these two revisions.</p>}
                </>}
                {analysis && !diff && <>
                    <span className="section-label">Analysis #{analysis.id} · {analysis.score}/100 · {String(analysis.created_at).slice(0, 16)}</span>
                    <div className="mentor-preview-toggle">
                        <button className={previewMode === "original" ? "active" : ""} onClick={() => setPreviewMode("original")}>Original PDF</button>
                        <button className={previewMode === "rewritten" ? "active" : ""} onClick={() => setPreviewMode("rewritten")}>Rewritten Preview</button>
                    </div>
                    {previewMode === "original" ? (
                        pdfUrl ? <div className="pdf-shell"><iframe className="pdf-frame" src={pdfUrl} title="Candidate resume" /></div> : <div className="card muted">Source preview is available for PDF uploads only.</div>
                    ) : <>
                        <textarea className="input-field doc-editor mentor-preview-editor" value={previewEdited} onChange={e => { setPreviewEdited(e.target.value); setPreviewDirty(e.target.value !== previewMarkdown) }} />
                        <article className="card markdown-preview doc-preview"><ReactMarkdown>{previewEdited}</ReactMarkdown></article>
                        <div className="mentor-preview-actions">
                            <button className="btn-primary" onClick={doneEditing} disabled={!previewDirty}><Check size={15} /> Done</button>
                            <button className="btn-ghost" onClick={discardEditing} disabled={!previewDirty}>Discard Without Saving</button>
                        </div>
                    </>}

                    <div className="mentor-more-row">
                        <button className="btn-secondary btn-small" onClick={() => setMoreOpen(!moreOpen)}>{moreOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />} More</button>
                    </div>
                    {moreOpen && <div className="card mentor-more-panel">
                        <div className="mentor-more-tabs">
                            <button className={moreTab === "analysis" ? "active" : ""} onClick={() => openMoreTab("analysis")}>Analysis</button>
                            <button className={moreTab === "sections" ? "active" : ""} onClick={() => openMoreTab("sections")}>Extracted Sections</button>
                            <button className={moreTab === "accepted" ? "active" : ""} onClick={() => openMoreTab("accepted")}>Accepted AI Suggestions</button>
                            <button className={moreTab === "coverletters" ? "active" : ""} onClick={() => openMoreTab("coverletters")}>Cover Letters</button>
                        </div>

                        {moreTab === "analysis" && Object.entries(rewrites).map(([section, items]) => <details className="card" key={section} open={section === "EXPERIENCE"}>
                            <summary>{section}</summary>
                            {items.filter(item => item.framework_used !== "none" && item.framework_used !== "error").map(item => <div className="mentor-suggestion" key={item.id}>
                                <div className="feedback-meta">
                                    <span className={`severity-dot ${item.severity || "yellow"}`} />
                                    <span className={`status-chip ${decisions[item.id] === true ? "status-accepted" : decisions[item.id] === false ? "status-dismissed" : ""}`}>{decisions[item.id] === true ? "Accepted" : decisions[item.id] === false ? "Dismissed" : "Undecided"}</span>
                                    <button className="pill suggest-edit-pill" onClick={() => setActiveComposerKey(activeComposerKey === item.id ? null : item.id)}><PenSquare size={12} /> Suggest Edit</button>
                                </div>
                                <div className="rewrite-grid"><div className="rewrite-pane before"><span className="pane-label">Original</span><p className="rewrite-text">{item.original}</p></div><div className="rewrite-pane after"><span className="pane-label">AI rewrite</span><p className="rewrite-text">{item.rewritten}</p></div></div>
                                {activeComposerKey === item.id && <FeedbackComposer
                                    candidateId={candidate.id} analysisId={analysis.id}
                                    prefill={{ type: "edit", section, original: item.original, key: item.id }}
                                    onSent={(text) => {
                                        setActiveComposerKey(null)
                                        load()
                                        if (text) setPreviewEdited(prev => prev.includes(item.rewritten) ? prev.replace(item.rewritten, text) : prev.includes(item.original) ? prev.replace(item.original, text) : prev)
                                    }}
                                />}
                            </div>)}
                        </details>)}

                        {moreTab === "sections" && Object.entries(analysis.results?.sections || {}).map(([name, lines]) => (
                            <details className="card" key={name} open={name === "EXPERIENCE"}><summary>{name}</summary><pre className="section-pre">{lines.join("\n")}</pre></details>
                        ))}

                        {moreTab === "accepted" && (acceptedItems.length ? acceptedItems.map(item => (
                            <div className="card mentor-suggestion" key={item.id}>
                                <span className="status-chip">{item.section}</span>
                                <div className="rewrite-grid"><div className="rewrite-pane before"><span className="pane-label">Original</span><p className="rewrite-text">{item.original}</p></div><div className="rewrite-pane after"><span className="pane-label">Accepted rewrite</span><p className="rewrite-text">{item.rewritten}</p></div></div>
                            </div>
                        )) : <p className="muted">No suggestions accepted yet.</p>)}

                        {moreTab === "coverletters" && (coverLetters == null ? <p className="muted">Loading…</p> : coverLetters.length ? coverLetters.map(cl => (
                            <div className="card" key={cl.id}>
                                <div className="feedback-meta">
                                    <span className="fw-badge"><Building2 size={12} /> {cl.company || "Company not detected"}</span>
                                    <span className="status-chip">Attempt #{cl.attempt_number || "—"}</span>
                                    <small className="muted">{formatShortDate(cl.created_at)}</small>
                                </div>
                                <pre className="section-pre">{cl.content}</pre>
                            </div>
                        )) : <p className="muted">No cover letters generated yet.</p>)}
                    </div>}
                </>}
                {!analysis && !diff && <div className="card muted">Open an analysis or compare two revisions to see details here.</div>}
            </div>
        </div>

        <button className="mentor-compose-fab" onClick={() => setComposeOpen(true)} title="Compose general feedback"><PenSquare size={20} /></button>
        {composeOpen && createPortal(<div className="modal-overlay" onClick={() => setComposeOpen(false)}>
            <div className="modal-panel" onClick={e => e.stopPropagation()}>
                <div className="modal-head">
                    <h3 className="modal-title">General Feedback</h3>
                    <button className="btn-ghost modal-close" onClick={() => setComposeOpen(false)} title="Close"><X size={18} /></button>
                </div>
                <FeedbackComposer candidateId={candidate.id} analysisId={analysis?.id} prefill={null} onSent={() => { load(); setComposeOpen(false) }} />
            </div>
        </div>, document.body)}
    </section>
}

function MentorDashboard() {
    const [data, setData] = useState(null)
    const [error, setError] = useState("")
    const [openCandidate, setOpenCandidate] = useState(null)
    const [newCode, setNewCode] = useState("")

    async function load() {
        try { setData((await api.get("/mentor/dashboard")).data) } catch (err) { setError(getError(err)) }
    }
    useEffect(() => { load() }, [])

    async function createSession() {
        try {
            const res = await api.post("/mentor/session")
            setNewCode(res.data.code)
            await load()
        } catch (err) { setError(getError(err)) }
    }

    async function deactivate(code) {
        try {
            await api.post(`/mentor/session/${code}/close`)
            await load()
        } catch (err) { setError(getError(err)) }
    }

    if (error) return <p className="warning-strip">{error}</p>
    if (!data) return <p className="muted">Loading mentor dashboard...</p>
    if (openCandidate) return <CandidateDetail candidate={openCandidate} onBack={() => setOpenCandidate(null)} />

    return <section>
        <div className="detail-head">
            <h2 className="view-title" style={{ marginBottom: 0 }}>Mentor Dashboard</h2>
            <button className="btn-primary" onClick={createSession}>Create Review Session</button>
        </div>
        {newCode && <p className="success-msg">Session created — share code <b>{newCode}</b> with your candidates.</p>}
        <div className="card"><span className="section-label">Sessions</span>
            {data.sessions.length ? data.sessions.map(session => <p className="session-row" key={session.id}>
                <b className="session-code">{session.session_code}</b>
                <span className={`status-chip ${session.active ? "status-accepted" : ""}`}>{session.active ? "Active" : "Closed"}</span>
                <span className="muted">{session.participants.filter(p => p.role === "candidate").map(item => item.display_name).join(", ") || "No participants yet"}</span>
                {session.active && <button className="btn-destructive btn-small session-deactivate" onClick={() => deactivate(session.session_code)}><Ban size={13} /> Deactivate</button>}
            </p>) : <p className="muted">No sessions yet — create one and share the code.</p>}
        </div>
        <span className="section-label">Candidates</span>
        <div className="card mentor-table"><table><thead><tr><th>Candidate</th><th>Analyses</th><th>Latest</th><th>Best</th><th /></tr></thead><tbody>
            {data.candidates.map(candidate => <tr key={candidate.id}>
                <td>{candidate.name}</td>
                <td>{candidate.total_analyses}</td>
                <td style={{ color: getScoreCfg(candidate.latest_score).color, fontWeight: 700 }}>{candidate.latest_score}</td>
                <td>{candidate.best_score}</td>
                <td><button className="btn-secondary btn-small" onClick={() => setOpenCandidate(candidate)}>Open workspace</button></td>
            </tr>)}
            {!data.candidates.length && <tr><td colSpan={5} className="muted">No candidates have joined a session yet.</td></tr>}
        </tbody></table></div>
    </section>
}

function capitalize(s) {
    return s ? s[0].toUpperCase() + s.slice(1) : s
}

function formatShortDate(value) {
    if (!value) return ""
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return ""
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

function FeedbackInbox() {
    const [items, setItems] = useState(null)
    const [error, setError] = useState("")

    async function load() {
        try { setItems((await api.get("/mentor/feedback/inbox")).data) } catch (err) { setError(getError(err)) }
    }
    useEffect(() => { load() }, [])

    async function setStatus(id, status) {
        try {
            await api.post(`/mentor/feedback/${id}/status`, { status })
            await load()
        } catch (err) { setError(getError(err)) }
    }

    if (error) return <p className="warning-strip">{error}</p>
    if (!items) return <p className="muted">Loading feedback...</p>
    if (!items.length) return <div className="card muted">No mentor feedback yet. Join a review session from the sidebar, and your mentor's comments and suggested edits will appear here.</div>

    // "current attempt" = the most recent attempt that has any feedback attached to it;
    // everything from an older attempt, or already dismissed, moves into Previous Feedback
    const currentAttempt = items.reduce((max, f) => Math.max(max, f.attempt_number || 0), 0)
    const current = items.filter(f => f.status !== "dismissed" && f.attempt_number === currentAttempt)
    const previous = items
        .filter(f => f.status === "dismissed" || f.attempt_number !== currentAttempt)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))

    function renderItem(f) {
        return <div className={`card feedback-item ${f.status}`} key={f.id}>
            <div className="feedback-meta">
                <b>{f.mentor_name}</b>
                <span className="fw-badge">{capitalize(f.feedback_type)}</span>
                {f.section && <span className="status-chip">{f.section}</span>}
                <span className={`status-chip status-${f.status}`}>{capitalize(f.status)}</span>
                {f.attempt_number && <span className="feedback-attempt-meta">Attempt #{f.attempt_number} &bull; {formatShortDate(f.created_at)}</span>}
            </div>
            {f.feedback_type === "edit" && <div className="rewrite-grid"><div className="rewrite-pane before"><span className="pane-label">Original</span><p className="rewrite-text">{f.original_text}</p></div><div className="rewrite-pane after"><span className="pane-label">Mentor's suggestion</span><p className="rewrite-text">{f.suggested_text}</p></div></div>}
            {f.comment && <p className="feedback-comment">{f.comment}</p>}
            {f.status === "open" && <div className="composer-actions">
                <button className="btn-primary" onClick={() => setStatus(f.id, "accepted")}><Check size={15} /> Accept</button>
                <button className="btn-ghost" onClick={() => setStatus(f.id, "dismissed")}><X size={14} /> Dismiss</button>
            </div>}
        </div>
    }

    return <section>
        <h2 className="view-title">Mentor Feedback</h2>
        <div className="feedback-list">
            {current.length ? current.map(renderItem) : <p className="muted">No feedback yet for your current attempt.</p>}
        </div>
        {previous.length > 0 && <details className="card previous-feedback">
            <summary>Previous Feedback ({previous.length})</summary>
            <div className="feedback-list">{previous.map(renderItem)}</div>
        </details>}
    </section>
}

// a lightweight client-side echo of analyser.py's kw_freqs - the compare-resume-jd endpoint
// doesn't return per-keyword counts, so this derives real ones from the resume text rather
// than showing a fabricated or blank count next to every "present" keyword
function computeKeywordFrequencies(keywords, text) {
    const lower = (text || "").toLowerCase()
    const freqs = {}
    for (const kw of keywords) {
        const escaped = kw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        const matches = lower.match(new RegExp(`\\b${escaped}\\b`, "g"))
        if (matches) freqs[kw] = matches.length
    }
    return freqs
}

function JobMatching({ result, provider, localEndpoint, jobMatchState, setJobMatchState, onReanalyse, onGenerateCV, onGenerateCoverLetter, analysing, busyAction }) {
    const { url, scraped, jobId, comparison, linkedinUrl, linkedinProfile, company } = jobMatchState
    const [compareBusy, setCompareBusy] = useState(false)
    const [scrapeBusy, setScrapeBusy] = useState(false)
    const [linkedinBusy, setLinkedinBusy] = useState(false)
    const [error, setError] = useState("")

    function patch(fields) { setJobMatchState(prev => ({ ...prev, ...fields })) }

    async function scrape() {
        setScrapeBusy(true)
        setError("")
        try {
            const res = await api.post("/scrape/jd", { url })
            patch({ scraped: res.data.text || "", jobId: res.data.job_id || null })
        } catch (err) { setError(getError(err)) } finally { setScrapeBusy(false) }
    }

    async function compare() {
        setError("")
        setCompareBusy(true)
        try {
            const res = await api.post("/scrape/compare", { resume_text: result.raw_text || "", jd_text: scraped || result.job_description || "", provider, local_endpoint: localEndpoint, job_id: jobId, analysis_id: result.analysis_id })
            if (res.data.error) {
                setError(`Comparison failed: ${res.data.error}`)
                patch({ comparison: null })
            } else {
                patch({ comparison: res.data, company: res.data.company || "" })
            }
        } catch (err) { setError(getError(err)) } finally { setCompareBusy(false) }
    }

    async function scrapeLinkedIn() {
        setLinkedinBusy(true)
        setError("")
        try {
            const res = await api.post("/scrape/linkedin", { url: linkedinUrl })
            patch({ linkedinProfile: res.data.profile || res.data })
        } catch (err) { setError(getError(err)) } finally { setLinkedinBusy(false) }
    }

    const profileError = linkedinProfile?.error
    const activeJD = scraped || result.job_description || ""
    const anyShortcutBusy = analysing || busyAction !== ""
    const matchedKeywordResult = comparison ? {
        jd_keywords: [...(comparison.strong_matches || []), ...(comparison.missing_skills || [])],
        missing_keywords: comparison.missing_skills || [],
        keyword_frequencies: computeKeywordFrequencies(comparison.strong_matches || [], result.raw_text),
    } : null

    return <section className="job-matching-page">
        <h2 className="view-title">Job Matching</h2>
        <span className="section-label">Recruitment Integration</span>
        <div className="scrape-row">
            <input className="input-field" value={url} onChange={e => patch({ url: e.target.value })} placeholder="Enter Job Description URL" />
            <button className="job-match-action" onClick={scrape} disabled={scrapeBusy}>{scrapeBusy ? <><span className="spinner" />Scraping…</> : "Scrape"}</button>
        </div>
        {scraped && <textarea className="input-field document-editor" value={scraped} onChange={e => patch({ scraped: e.target.value })} />}
        {error && <p className="error-msg">{error}</p>}

        <button className="job-match-action job-match-compare" onClick={compare} disabled={compareBusy || (!scraped && !result.job_description)}>
            {compareBusy ? <><span className="spinner" />Comparing…</> : "Compare Resume to Job"}
        </button>

        {comparison && <div className="job-match-results">
            <div className="card job-match-score-card">
                <span className="section-label">Compatibility Score</span>
                <p className="metric-value">{comparison.match_pct || 0}%</p>
                <p><b>Strong matches:</b> {(comparison.strong_matches || []).join(", ") || "None"}</p>
                <p><b>Missing skills:</b> {(comparison.missing_skills || []).join(", ") || "None"}</p>
                <p><b>Tailoring tips:</b> {(comparison.tailoring_tips || []).join(" · ") || "None"}</p>
                {company && <p className="job-match-company"><Building2 size={13} /> {company}</p>}
            </div>

            <h3 className="doc-subhead">Matched Keyword Gap</h3>
            <KeywordGap result={matchedKeywordResult} />

            <div className="job-match-shortcuts">
                <button className="job-match-action" onClick={() => onReanalyse(activeJD)} disabled={anyShortcutBusy}>
                    {analysing ? <><span className="spinner" />Reanalysing…</> : <><RotateCw size={15} /> Reanalyse Resume</>}
                </button>
                <button className="job-match-action" onClick={() => onGenerateCV(activeJD)} disabled={anyShortcutBusy}>
                    {busyAction === "cv" ? <><span className="spinner" />Generating…</> : <><FileEdit size={15} /> Generate Tailored CV</>}
                </button>
                <button className="job-match-action" onClick={() => onGenerateCoverLetter(activeJD)} disabled={anyShortcutBusy}>
                    {busyAction === "cover-letter" ? <><span className="spinner" />Generating…</> : <><Mail size={15} /> Generate Cover Letter</>}
                </button>
            </div>
        </div>}

        <hr className="slim-divider" />
        <h3 className="doc-subhead">LinkedIn Profile Import</h3>
        <p className="muted">The reliable path is LinkedIn's own data export: Settings → Data privacy → Get a copy of your data → ZIP, then upload that ZIP in the main upload box. Public URL preview below is limited by LinkedIn's sign-in wall.</p>
        <div className="scrape-row">
            <input className="input-field" value={linkedinUrl} onChange={e => patch({ linkedinUrl: e.target.value })} placeholder="LinkedIn Profile URL (public preview only)" />
            <button className="btn-secondary" onClick={scrapeLinkedIn} disabled={linkedinBusy}>{linkedinBusy ? <><span className="spinner" />Loading…</> : "Preview Profile"}</button>
        </div>
        {linkedinProfile && (profileError ? <p className="warning-strip">{profileError}</p> : <div className="card">{linkedinProfile.name && <p><b>{linkedinProfile.name}</b></p>}{linkedinProfile.headline && <p>{linkedinProfile.headline}</p>}{linkedinProfile.note && <p className="muted">{linkedinProfile.note}</p>}</div>)}
    </section>
}

// SIDEBAR_KEY: once the user manually re-expands the sidebar after an auto-collapse, that
// choice is remembered forever (across reloads) so auto-collapse never fights them again
const SIDEBAR_AUTO_COLLAPSE_DISABLED_KEY = "rtr_sidebar_auto_collapse_disabled"

function toFilenamePart(s) {
    return String(s || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "DOCUMENT"
}

function App() {
    const { user, logout } = useAuth()
    const [provider, setProvider] = useState("default")
    const [useCritic, setUseCritic] = useState(false)
    const [localEndpoint, setLocalEndpoint] = useState("http://localhost:11434/api/chat")
    const [status, setStatus] = useState({})
    const [apiKey, setApiKey] = useState("")
    const [keyBusy, setKeyBusy] = useState(false)
    const [keyMessage, setKeyMessage] = useState("")
    const [file, setFile] = useState(null)
    const [jobDescription, setJobDescription] = useState("")
    const [result, setResult] = useState(null)
    const [analysisId, setAnalysisId] = useState(null)
    const [decisions, setDecisions] = useState({})
    const [docs, setDocs] = useState({ cv: "", cover_letter: "" })
    const [view, setView] = useState("Suggestions")
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState("")
    const [history, setHistory] = useState([])
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
    const [autoCollapseDisabled, setAutoCollapseDisabled] = useState(() => localStorage.getItem(SIDEBAR_AUTO_COLLAPSE_DISABLED_KEY) === "true")
    const [navHidden, setNavHidden] = useState(false)
    const [exported, setExported] = useState(false)
    const [setupExpanded, setSetupExpanded] = useState(true)
    // Job Matching's own scrape/compare state, lifted up here (rather than kept local to
    // <JobMatching>) so switching tabs away and back never re-runs the scrape or comparison -
    // the tab body unmounts on every view switch, but this state doesn't live there anymore
    const [jobMatchState, setJobMatchState] = useState({ url: "", scraped: "", jobId: null, comparison: null, linkedinUrl: "", linkedinProfile: null, company: "" })
    const [jobMatchBusyAction, setJobMatchBusyAction] = useState("")
    const hasAutoCollapsedRef = useRef(false)
    const navScrollAnchorRef = useRef(0)
    const providerMeta = PROVIDER_OPTIONS.find(p => p.key === provider)
    const visibleProviders = PROVIDER_OPTIONS.filter(p => p.key !== "local" || status.localAllowed)
    const needsKey = providerMeta?.byok && status[provider] === false
    const fullName = result?.parsed_resume?.contact?.name || result?.contact?.name || ""

    function refreshStatus() {
        return api.get("/settings/env-status").then(res => setStatus(res.data)).catch(() => setStatus({}))
    }

    useEffect(() => {
        if (!user) return
        refreshStatus()
        api.get("/analysis/history").then(res => setHistory(res.data)).catch(() => setHistory([]))
    }, [user])

    // the browser auto-scrolls the page to bring a focused field into view (e.g. clicking/
    // filling a form field near the bottom of the sidebar) - that scroll isn't the user
    // deliberately reading down the page, so both scroll-driven UI behaviors below ignore
    // scroll events that land within a short window of any input/textarea/select gaining focus
    const recentFieldFocusRef = useRef(false)
    useEffect(() => {
        let timer = null
        function onFocusIn(e) {
            const tag = (e.target.tagName || "").toLowerCase()
            if (tag !== "input" && tag !== "textarea" && tag !== "select") return
            recentFieldFocusRef.current = true
            clearTimeout(timer)
            timer = setTimeout(() => { recentFieldFocusRef.current = false }, 600)
        }
        window.addEventListener("focusin", onFocusIn)
        return () => { window.removeEventListener("focusin", onFocusIn); clearTimeout(timer) }
    }, [])

    // collapse the sidebar to icon-only the FIRST time the user scrolls into the results, so
    // it stops competing for space with the workspace - but only ever once automatically.
    // Manually re-expanding afterward (see toggleSidebar) permanently retires this listener.
    useEffect(() => {
        if (!result || autoCollapseDisabled) return undefined
        function onScroll() {
            if (recentFieldFocusRef.current) return
            if (!hasAutoCollapsedRef.current && window.scrollY > 140) {
                hasAutoCollapsedRef.current = true
                setSidebarCollapsed(true)
            }
        }
        window.addEventListener("scroll", onScroll, { passive: true })
        return () => window.removeEventListener("scroll", onScroll)
    }, [result, autoCollapseDisabled])

    // the nav bar never floats over content: scrolling down more than ~20% of the viewport
    // collapses it to a floating expand button (matching the sidebar's collapsed toggle);
    // scrolling back up more than ~20% restores it. Measured relative to the scroll position
    // where the nav last changed state, not an absolute page offset.
    useEffect(() => {
        if (!result) return undefined
        function onScroll() {
            if (recentFieldFocusRef.current) return
            if (window.innerWidth <= 640) return // docked bottom nav below this width - never auto-hide it
            const y = window.scrollY
            const threshold = window.innerHeight * 0.2
            const delta = y - navScrollAnchorRef.current
            if (!navHidden && y > threshold && delta > threshold) {
                setNavHidden(true)
                navScrollAnchorRef.current = y
            } else if (navHidden && delta < -threshold) {
                setNavHidden(false)
                navScrollAnchorRef.current = y
            }
        }
        window.addEventListener("scroll", onScroll, { passive: true })
        return () => window.removeEventListener("scroll", onScroll)
    }, [result, navHidden])

    // if the viewport crosses into the phone tier while the nav is already hidden (e.g. a
    // resize or orientation change), un-hide it immediately - otherwise the docked bottom
    // nav's CSS never gets a chance to apply, since TopNav renders only the floating toggle
    // while `hidden` is true, and the scroll guard above stops new hides but can't undo one
    useEffect(() => {
        function onResize() {
            if (window.innerWidth <= 640 && navHidden) setNavHidden(false)
        }
        window.addEventListener("resize", onResize)
        return () => window.removeEventListener("resize", onResize)
    }, [navHidden])

    function toggleSidebar() {
        setSidebarCollapsed(prev => {
            const next = !prev
            // manually EXPANDING (not collapsing) is the signal that the user wants control -
            // from then on auto-collapse-on-scroll never fires again, even after a reload
            if (prev && !next && !autoCollapseDisabled) {
                setAutoCollapseDisabled(true)
                localStorage.setItem(SIDEBAR_AUTO_COLLAPSE_DISABLED_KEY, "true")
            }
            return next
        })
    }

    useEffect(() => {
        setResult(null)
        setAnalysisId(null)
        setDecisions({})
        setDocs({ cv: "", cover_letter: "" })
        setKeyMessage("")
    }, [provider, useCritic, file])

    async function saveKey() {
        setKeyBusy(true)
        setKeyMessage("")
        try {
            await api.post("/settings/api-key", { provider, key: apiKey })
            setStatus({ ...status, [provider]: true })
            setApiKey("")
        } catch (err) { setKeyMessage(getError(err)) } finally { setKeyBusy(false) }
    }

    async function removeKey() {
        setKeyBusy(true)
        setKeyMessage("")
        try {
            await api.delete(`/settings/api-key/${provider}`)
            setStatus({ ...status, [provider]: false })
        } catch (err) { setKeyMessage(getError(err)) } finally { setKeyBusy(false) }
    }

    // jdOverride lets "Reanalyse Resume" on the Job Matching page rerun the full analysis
    // using the scraped job description as the active JD, without the user re-pasting it
    async function analyse(jdOverride) {
        if (!file) return
        const jd = jdOverride !== undefined ? jdOverride : jobDescription
        setBusy(true)
        setError("")
        try {
            const data = new FormData()
            data.append("file", file)
            const upload = await api.post("/analysis/upload", data)
            const run = await api.post("/analysis/run", {
                resume_id: upload.data.resume_id,
                resume_json: upload.data.parsed,
                job_description: jd,
                provider,
                use_critic: useCritic,
                local_endpoint: provider === "local" ? localEndpoint : "",
            })
            const completed = await waitForAnalysis(run.data.job_id)
            setResult({ ...completed, parsed_resume: upload.data.parsed, job_description: jd, raw_text: upload.data.parsed.raw_text })
            setAnalysisId(completed.analysis_id)
            setDecisions({})
            setView("Suggestions")
            setSidebarCollapsed(false)
            setSetupExpanded(false)
            setExported(false)
            setJobDescription(jd)
            hasAutoCollapsedRef.current = false
            // restore any docs already generated for this analysis so tabs don't wipe them
            try {
                const docsRes = await api.get(`/generate/latest?analysis_id=${completed.analysis_id}`)
                setDocs({
                    cv: docsRes.data.cv?.content || "",
                    cover_letter: docsRes.data.cover_letter?.content || "",
                })
            } catch { setDocs({ cv: "", cover_letter: "" }) }
            const hist = await api.get("/analysis/history")
            setHistory(hist.data)
        } catch (err) { setError(getError(err)) } finally { setBusy(false) }
    }

    // triggered from Job Matching's "Generate Tailored CV"/"Generate Cover Letter" shortcuts -
    // launches generation directly using the scraped job description, switching to the
    // relevant tab to show the result, without requiring the user to navigate there first
    async function generateFromJobMatch(type, jdText) {
        setView(type === "cv" ? "Tailored CV" : "Cover Letter")
        setJobMatchBusyAction(type)
        try {
            const endpoint = type === "cv" ? "/generate/cv" : "/generate/cover-letter"
            const payload = {
                resume_json: result.parsed_resume,
                job_description: jdText,
                provider, local_endpoint: localEndpoint,
                analysis_id: analysisId || result.analysis_id,
            }
            if (type === "cv") {
                payload.rewrite_suggestions = result.rewrites
                payload.rewrite_decisions = decisions
                payload.acc_map = {}
            } else if (jobMatchState.company) {
                payload.company = jobMatchState.company
            }
            const res = await api.post(endpoint, payload)
            const text = type === "cv" ? res.data.cv_text : res.data.cover_letter_text
            setDocs(prev => ({ ...prev, [type === "cv" ? "cv" : "cover_letter"]: text }))
            toast(`${type === "cv" ? "Tailored CV" : "Cover letter"} generated from Job Matching`)
        } catch (err) {
            toast(getError(err), "error")
        } finally {
            setJobMatchBusyAction("")
        }
    }

    if (!user) return <AuthPage />
    const isMentor = user.role === "mentor"

    // mentors land in their workspace - they review others' resumes, not their own
    if (isMentor) {
        return <main className="app-container">
            <ToastHost />
            <AuthBar user={user} onLogout={logout} />
            <Hero />
            <div className="topbar">
                <span className="muted">Signed in as <b>{user.display_name}</b> · mentor</span>
                <button className="btn-secondary" onClick={logout}>Sign out</button>
            </div>
            <MentorDashboard />
        </main>
    }

    return <main className="app-container">
        <ToastHost />
        <AuthBar user={user} onLogout={logout} />
        <Hero />
        <PipelineStepper file={file} busy={busy} result={result} docs={docs} exported={exported} />
        {result && !setupExpanded ? (
            <button className="setup-summary" onClick={() => setSetupExpanded(true)}>
                <UploadCloud size={15} />
                <span className="setup-summary-name">{file?.name || "Resume analysed"}</span>
                <span className="setup-summary-hint muted">Change resume, job description, or provider</span>
            </button>
        ) : <>
            <div className="model-bar">
                <label>AI Provider
                    <select className="input-field" value={provider} onChange={e => setProvider(e.target.value)}>
                        {visibleProviders.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
                    </select>
                </label>
                <label className="toggle-wrap"><span className={`toggle-track ${useCritic ? "active" : ""}`} onClick={() => setUseCritic(!useCritic)}><span className="toggle-thumb" /></span>Agentic Self-Correction</label>
                {provider === "local" && <div className="local-endpoint-field">
                    <input className="input-field" value={localEndpoint} onChange={e => setLocalEndpoint(e.target.value)} placeholder="Local API Endpoint" />
                    <small className="muted">Must be reachable by the server, not just your browser. Defaults to your machine's Ollama if you're running this app locally — for a hosted deployment, expose your local model with a tunnel (e.g. ngrok, Tailscale Funnel, Cloudflare Tunnel) and paste that URL here.</small>
                </div>}
                {!result && <span className="topbar-inline"><span className="muted">{user.is_guest ? "Browsing as " : "Signed in as "}<b>{user.display_name}</b></span><button className="btn-secondary" onClick={logout}>{user.is_guest ? <><LogIn size={13} /> Sign In</> : <><LogOut size={13} /> Sign out</>}</button></span>}
            </div>
            {providerMeta?.byok && <div className="card key-card">
                <span className="section-label"><KeyRound size={13} /> {providerMeta.label.replace(" (Own Key)", "")} API Key</span>
                {status[provider]
                    ? <>
                        <p className="muted">A key is saved for your account and will be used for your requests only.</p>
                        <button className="btn-destructive" disabled={keyBusy} onClick={removeKey}>Remove key</button>
                    </>
                    : <>
                        <p className="muted">Add your own key to use {providerMeta.label.replace(" (Own Key)", "")} — it's encrypted and tied to your account, used only for your own requests, never shared with other users.</p>
                        <div className="two-col">
                            <input className="input-field" type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={`Paste your ${providerMeta.label.replace(" (Own Key)", "")} API key`} />
                            <button className="btn-primary" disabled={keyBusy || !apiKey.trim()} onClick={saveKey}>Save Key</button>
                        </div>
                    </>}
                {keyMessage && <p className="error-msg">{keyMessage}</p>}
            </div>}
            <ResumeSetup file={file} setFile={setFile} jobDescription={jobDescription} setJobDescription={setJobDescription} onAnalyse={analyse} busy={busy || needsKey} />
            {needsKey && <p className="warning-strip">Add a {providerMeta.label.replace(" (Own Key)", "")} API key above, or switch to Default (Free), before analysing.</p>}
            {result && <div className="setup-collapse-row"><button className="btn-ghost" onClick={() => setSetupExpanded(false)}>Hide setup</button></div>}
        </>}
        {error && <p className="warning-strip">{error}</p>}
        {!result && <details className="card"><summary>Mentor Feedback &amp; Review Sessions</summary><div className="prelim-panels"><SessionJoin /><FeedbackInbox /></div></details>}
        {result && <>
            <TopNav view={view} setView={setView} hidden={navHidden} onShow={() => { setNavHidden(false); navScrollAnchorRef.current = window.scrollY }} />
            <div className={`workspace ${sidebarCollapsed ? "sidebar-is-collapsed" : ""}`}>
            <ResultsSidebar result={result} user={user} onLogout={logout} history={history} collapsed={sidebarCollapsed} onToggleCollapse={toggleSidebar} />
            <div className="workspace-main">
                <div className="fade-in" key={view}>
                    {view === "Suggestions" && <RewriteReview result={result} file={file} decisions={decisions} setDecisions={setDecisions} analysisId={analysisId} />}
                    {view === "Keyword Gap" && <KeywordGap result={result} />}
                    {view === "Extracted Sections" && <ExtractedSections result={result} />}
                    {view === "Tailored CV" && <DocumentGenerator type="cv" result={result} provider={provider} localEndpoint={localEndpoint} decisions={decisions} analysisId={analysisId} text={docs.cv} setText={t => setDocs({ ...docs, cv: t })} onExport={() => setExported(true)} fullName={fullName} />}
                    {view === "Cover Letter" && <DocumentGenerator type="cover-letter" result={result} provider={provider} localEndpoint={localEndpoint} decisions={decisions} analysisId={analysisId} text={docs.cover_letter} setText={t => setDocs({ ...docs, cover_letter: t })} onExport={() => setExported(true)} fullName={fullName} company={jobMatchState.company} />}
                    {view === "Mentor Feedback" && <FeedbackInbox />}
                    {view === "Insights" && <Insights result={result} history={history} decisions={decisions} />}
                    {view === "Job Matching" && <JobMatching
                        result={result} provider={provider} localEndpoint={localEndpoint}
                        jobMatchState={jobMatchState} setJobMatchState={setJobMatchState}
                        onReanalyse={jd => analyse(jd)}
                        onGenerateCV={jd => generateFromJobMatch("cv", jd)}
                        onGenerateCoverLetter={jd => generateFromJobMatch("cover-letter", jd)}
                        analysing={busy}
                        busyAction={jobMatchBusyAction}
                    />}
                </div>
            </div>
            </div>
        </>}
    </main>
}

export default App
