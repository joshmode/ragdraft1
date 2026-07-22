import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useDropzone } from "react-dropzone"
import ReactMarkdown from "react-markdown"
import {
    MessageSquareText, SearchCheck, FileText, FileEdit, Mail, Briefcase, BarChart3, Users,
    ClipboardList, FileOutput, Target, PanelLeftClose, PanelLeftOpen, IdCard, TrendingUp,
    TrendingDown, Check, X, ChevronLeft, ChevronRight, UploadCloud, Sparkles, ClipboardCheck,
    Download, CheckCircle2, XCircle, LogIn, LogOut, Loader2, KeyRound, Lightbulb,
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

// grouped into workflow stages (rather than one flat row of equally-weighted tabs) with an
// icon per tab, rendered by TopNav
const NAV_GROUPS = [
    { label: "Review", icon: ClipboardList, items: [
        { key: "Suggestions", icon: MessageSquareText },
        { key: "Keyword Gap", icon: SearchCheck },
        { key: "Extracted Sections", icon: FileText },
    ] },
    { label: "Generate", icon: FileOutput, items: [
        { key: "Tailored CV", icon: FileEdit },
        { key: "Cover Letter", icon: Mail },
    ] },
    { label: "Optimize", icon: Target, items: [
        { key: "Job Matching", icon: Briefcase },
    ] },
    { label: "Insights", icon: BarChart3, items: [
        { key: "Analytics", icon: BarChart3 },
        { key: "Mentor Feedback", icon: Users },
    ] },
]
const NAV_ITEMS = NAV_GROUPS.flatMap(g => g.items.map(i => i.key))

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

function TopNav({ view, setView }) {
    return <nav className="top-nav">
        {NAV_GROUPS.map(group => (
            <div className="nav-group" key={group.label}>
                <span className="nav-group-label"><group.icon size={12} />{group.label}</span>
                <div className="nav-group-items">
                    {group.items.map(({ key, icon: Icon }) => (
                        <button className={`nav-pill ${view === key ? "active" : ""}`} key={key} onClick={() => setView(key)}>
                            <Icon size={14} /><span>{key}</span>
                        </button>
                    ))}
                </div>
            </div>
        ))}
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
function ProcessingStages() {
    const [idx, setIdx] = useState(0)
    useEffect(() => {
        const t = setInterval(() => setIdx(i => (i + 1) % PROCESSING_STAGE_LABELS.length), 3500)
        return () => clearInterval(t)
    }, [])
    return <>Analysing — {PROCESSING_STAGE_LABELS[idx]} usually under a minute</>
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
        <div className="card">
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
            <button className="btn-primary analyse-btn" disabled={!file || busy} onClick={onAnalyse}>{busy ? <><span className="spinner" /><ProcessingStages /></> : <><Sparkles size={16} /> Analyse resume</>}</button>
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
    const actionable = useMemo(() => Object.entries(result.rewrites || {}).flatMap(([section, items]) => items.map((item, index) => ({ section, item, index, key: item.id || `${section}_${index}` })).filter(({ item }) => item.framework_used !== "none" && item.framework_used !== "error" && item.original !== item.rewritten)), [result])
    const count = actionable.length
    const current = actionable[Math.min(active, Math.max(count - 1, 0))]

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
                    <div className="suggestion-head"><span className="suggestion-title"><span className={`severity-dot ${current.item.severity || "yellow"}`} />{current.section}</span><span className="fw-badge">{current.item.framework_used}</span></div>
                    <div className="rewrite-grid"><div className="rewrite-pane before"><span className="pane-label">Original</span><p className="rewrite-text">{current.item.original}</p></div><div className="rewrite-pane after"><span className="pane-label">Suggested rewrite</span><p className="rewrite-text">{current.item.rewritten}</p></div></div>
                    <div className="reasoning-row"><Lightbulb size={13} /> {current.item.reasoning}</div>
                </div>
                <div className="decision-actions">
                    <button className="btn-primary btn-accept" onClick={() => decide(true)}><Check size={16} /> Accept &amp; next</button>
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

function SavedIndicator({ text }) {
    const [state, setState] = useState("idle")
    const firstRun = useRef(true)
    useEffect(() => {
        if (firstRun.current) { firstRun.current = false; return undefined }
        setState("saving")
        const t = setTimeout(() => setState("saved"), 500)
        return () => clearTimeout(t)
    }, [text])
    if (state === "idle") return null
    return <span className={`saved-indicator ${state}`}>{state === "saving" ? <><Loader2 size={12} className="spin-icon" /> Saving…</> : <><CheckCircle2 size={12} /> Saved</>}</span>
}

function DocumentGenerator({ type, result, provider, localEndpoint, decisions, analysisId, text, setText, onExport }) {
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState("")
    const [mobileTab, setMobileTab] = useState("edit")
    const title = type === "cv" ? "Tailored CV" : "Cover Letter"

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
            const res = await api.post(`/generate/${kind}`, { text, filename: type === "cv" ? `tailored_cv.${kind}` : `cover_letter.${kind}` }, { responseType: "blob" })
            const href = URL.createObjectURL(res.data)
            const link = document.createElement("a")
            link.href = href
            link.download = type === "cv" ? `tailored_cv.${kind}` : `cover_letter.${kind}`
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
                <SavedIndicator text={text} />
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
                <button className="btn-dark" onClick={() => { downloadText(text, type === "cv" ? "tailored_cv.md" : "cover_letter.md"); onExport?.(); toast("Markdown downloaded") }}><FileText size={15} /> Markdown</button>
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

function Analytics({ result, history, decisions }) {
    const timing = result.timing || {}
    const [consent, setConsent] = useState(false)
    const [confidence, setConfidence] = useState("")
    const [comment, setComment] = useState("")
    const [submitted, setSubmitted] = useState(false)
    const [error, setError] = useState("")
    const [overview, setOverview] = useState(null)

    useEffect(() => {
        api.get("/analysis/analytics/overview").then(res => setOverview(res.data.analyses || [])).catch(() => setOverview([]))
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
        <h2 className="view-title">Analytics</h2>

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

        <div className="card evaluation-card"><span className="section-label">Optional Evaluation</span><p className="muted">Share anonymised confidence feedback without including your resume content.</p>{submitted ? <p className="success-msg">Thanks for your feedback.</p> : <><label className="toggle-wrap"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />I consent to store this evaluation response.</label><label className="form-group">Confidence in these recommendations<select className="input-field" value={confidence} onChange={e => setConfidence(e.target.value)}><option value="">Select a rating</option>{[1, 2, 3, 4, 5].map(value => <option value={value} key={value}>{value}</option>)}</select></label><textarea className="input-field" value={comment} onChange={e => setComment(e.target.value)} placeholder="Optional qualitative feedback" />{error && <p className="error-msg">{error}</p>}<button className="btn-secondary btn-block-gap" disabled={!consent} onClick={submitFeedback}>Submit Feedback</button></>}</div>
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
                feedback_type: type,
                section,
                original_text: originalText,
                suggested_text: suggestedText,
                comment,
            })
            setStatus("Sent.")
            setSuggestedText("")
            setComment("")
            onSent?.()
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
    const [prefill, setPrefill] = useState(null)
    const [error, setError] = useState("")

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
        } catch (err) { setError(getError(err)) }
    }

    async function runDiff() {
        if (!diffFrom || !diffTo) return
        try {
            const res = await api.get(`/mentor/candidates/${candidate.id}/diff?from=${diffFrom}&to=${diffTo}`)
            setDiff(res.data)
            setAnalysis(null)
        } catch (err) { setError(getError(err)) }
    }

    const analyses = history?.analyses || []
    const rewrites = analysis?.results?.rewrites || {}
    const decisions = analysis?.results?.decisions || {}

    return <section>
        <div className="detail-head">
            <button className="btn-secondary" onClick={onBack}>← All candidates</button>
            <h3 className="detail-title">{candidate.name}</h3>
        </div>
        {error && <p className="warning-strip">{error}</p>}
        <div className="two-col">
            <div>
                <span className="section-label">Analysis History</span>
                <div className="card mentor-table"><table><thead><tr><th>Date</th><th>Score</th><th>Model</th><th /></tr></thead><tbody>
                    {analyses.map(a => <tr key={a.id}>
                        <td>{String(a.created_at || "").slice(0, 16)}</td>
                        <td style={{ color: getScoreCfg(a.score_total).color, fontWeight: 700 }}>{a.score_total}</td>
                        <td>{a.provider}{a.model ? ` / ${a.model}` : ""}</td>
                        <td><button className="btn-secondary btn-small" onClick={() => openAnalysis(a.id)}>Open</button></td>
                    </tr>)}
                    {!analyses.length && <tr><td colSpan={4} className="muted">No analyses yet.</td></tr>}
                </tbody></table></div>
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
                <FeedbackComposer candidateId={candidate.id} analysisId={analysis?.id} prefill={prefill} onSent={load} />
                <span className="section-label">Feedback Sent</span>
                <div className="feedback-list">
                    {sent.map(f => <div className={`card feedback-item ${f.status}`} key={f.id}>
                        <div className="feedback-meta"><span className="fw-badge">{f.feedback_type}</span>{f.section && <span className="status-chip">{f.section}</span>}<span className={`status-chip status-${f.status}`}>{f.status}</span><small className="muted">{String(f.created_at).slice(0, 16)}</small></div>
                        {f.feedback_type === "edit" && <div className="rewrite-grid"><div className="rewrite-pane before"><span className="pane-label">Original</span><p className="rewrite-text">{f.original_text}</p></div><div className="rewrite-pane after"><span className="pane-label">Suggested</span><p className="rewrite-text">{f.suggested_text}</p></div></div>}
                        {f.comment && <p className="feedback-comment">{f.comment}</p>}
                    </div>)}
                    {!sent.length && <p className="muted">No feedback sent yet.</p>}
                </div>
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
                    {Object.entries(rewrites).map(([section, items]) => <details className="card" key={section} open={section === "EXPERIENCE"}>
                        <summary>{section}</summary>
                        {items.filter(item => item.framework_used !== "none" && item.framework_used !== "error").map(item => <div className="mentor-suggestion" key={item.id}>
                            <div className="feedback-meta">
                                <span className={`severity-dot ${item.severity || "yellow"}`} />
                                <span className={`status-chip ${decisions[item.id] === true ? "status-accepted" : decisions[item.id] === false ? "status-dismissed" : ""}`}>{decisions[item.id] === true ? "accepted" : decisions[item.id] === false ? "dismissed" : "undecided"}</span>
                                <button className="btn-secondary btn-small" onClick={() => setPrefill({ type: "edit", section, original: item.original })}>Suggest edit</button>
                            </div>
                            <div className="rewrite-grid"><div className="rewrite-pane before"><span className="pane-label">Original</span><p className="rewrite-text">{item.original}</p></div><div className="rewrite-pane after"><span className="pane-label">AI rewrite</span><p className="rewrite-text">{item.rewritten}</p></div></div>
                        </div>)}
                    </details>)}
                </>}
                {!analysis && !diff && <div className="card muted">Open an analysis or compare two revisions to see details here.</div>}
            </div>
        </div>
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
            {data.sessions.length ? data.sessions.map(session => <p className="session-row" key={session.id}><b className="session-code">{session.session_code}</b><span className={`status-chip ${session.active ? "status-accepted" : ""}`}>{session.active ? "active" : "closed"}</span><span className="muted">{session.participants.filter(p => p.role === "candidate").map(item => item.display_name).join(", ") || "No participants yet"}</span></p>) : <p className="muted">No sessions yet — create one and share the code.</p>}
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

    return <section>
        <h2 className="view-title">Mentor Feedback</h2>
        <div className="feedback-list">
            {items.map(f => <div className={`card feedback-item ${f.status}`} key={f.id}>
                <div className="feedback-meta">
                    <b>{f.mentor_name}</b>
                    <span className="fw-badge">{f.feedback_type}</span>
                    {f.section && <span className="status-chip">{f.section}</span>}
                    <span className={`status-chip status-${f.status}`}>{f.status}</span>
                    <small className="muted">{String(f.created_at).slice(0, 16)}</small>
                </div>
                {f.feedback_type === "edit" && <div className="rewrite-grid"><div className="rewrite-pane before"><span className="pane-label">Original</span><p className="rewrite-text">{f.original_text}</p></div><div className="rewrite-pane after"><span className="pane-label">Mentor's suggestion</span><p className="rewrite-text">{f.suggested_text}</p></div></div>}
                {f.comment && <p className="feedback-comment">{f.comment}</p>}
                {f.status === "open" && <div className="composer-actions">
                    <button className="btn-primary" onClick={() => setStatus(f.id, "accepted")}><Check size={15} /> Accept</button>
                    <button className="btn-ghost" onClick={() => setStatus(f.id, "dismissed")}><X size={14} /> Dismiss</button>
                </div>}
            </div>)}
        </div>
    </section>
}

function JobMatching({ result, provider, localEndpoint }) {
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
        setError("")
        try {
            const res = await api.post("/scrape/compare", { resume_text: result.raw_text || "", jd_text: scraped || result.job_description || "", provider, local_endpoint: localEndpoint, job_id: jobId, analysis_id: result.analysis_id })
            if (res.data.error) {
                setError(`Comparison failed: ${res.data.error}`)
                setComparison(null)
            } else {
                setComparison(res.data)
            }
        } catch (err) { setError(getError(err)) }
    }
    async function scrapeLinkedIn() {
        try {
            const res = await api.post("/scrape/linkedin", { url: linkedinUrl })
            setLinkedinProfile(res.data.profile || res.data)
        } catch (err) { setError(getError(err)) }
    }
    const profileError = linkedinProfile?.error
    return <section><h2 className="view-title">Job Matching</h2><span className="section-label">Recruitment Integration</span><div className="scrape-row"><input className="input-field" value={url} onChange={e => setUrl(e.target.value)} placeholder="Enter Job Description URL" /><button className="btn-primary" onClick={scrape}>Scrape</button></div>{scraped && <textarea className="input-field document-editor" value={scraped} onChange={e => setScraped(e.target.value)} />}{error && <p className="error-msg">{error}</p>}<button className="btn-secondary btn-block-gap" onClick={compare} disabled={!scraped && !result.job_description}>Compare Resume to Job</button>{comparison && <div className="card"><p className="metric-value">{comparison.match_pct || 0}%</p><p><b>Strong matches:</b> {(comparison.strong_matches || []).join(", ") || "None"}</p><p><b>Missing skills:</b> {(comparison.missing_skills || []).join(", ") || "None"}</p><p><b>Tailoring tips:</b> {(comparison.tailoring_tips || []).join(" · ") || "None"}</p></div>}<hr className="slim-divider" /><h3 className="doc-subhead">LinkedIn Profile Import</h3><p className="muted">The reliable path is LinkedIn's own data export: Settings → Data privacy → Get a copy of your data → ZIP, then upload that ZIP in the main upload box. Public URL preview below is limited by LinkedIn's sign-in wall.</p><div className="scrape-row"><input className="input-field" value={linkedinUrl} onChange={e => setLinkedinUrl(e.target.value)} placeholder="LinkedIn Profile URL (public preview only)" /><button className="btn-secondary" onClick={scrapeLinkedIn}>Preview Profile</button></div>{linkedinProfile && (profileError ? <p className="warning-strip">{profileError}</p> : <div className="card">{linkedinProfile.name && <p><b>{linkedinProfile.name}</b></p>}{linkedinProfile.headline && <p>{linkedinProfile.headline}</p>}{linkedinProfile.note && <p className="muted">{linkedinProfile.note}</p>}</div>)}</section>
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
    const [exported, setExported] = useState(false)
    const [setupExpanded, setSetupExpanded] = useState(true)
    const providerMeta = PROVIDER_OPTIONS.find(p => p.key === provider)
    const visibleProviders = PROVIDER_OPTIONS.filter(p => p.key !== "local" || status.localAllowed)
    const needsKey = providerMeta?.byok && status[provider] === false

    function refreshStatus() {
        return api.get("/settings/env-status").then(res => setStatus(res.data)).catch(() => setStatus({}))
    }

    useEffect(() => {
        if (!user) return
        refreshStatus()
        api.get("/analysis/history").then(res => setHistory(res.data)).catch(() => setHistory([]))
    }, [user])

    // collapse the sidebar to icon-only once the user scrolls into the results, so it stops
    // competing for space with the workspace - it never re-expands on its own, only via the
    // toggle button, so it doesn't fight a deliberate click by re-collapsing on the next tick
    useEffect(() => {
        if (!result) return undefined
        function onScroll() {
            if (window.scrollY > 140) setSidebarCollapsed(true)
        }
        window.addEventListener("scroll", onScroll, { passive: true })
        return () => window.removeEventListener("scroll", onScroll)
    }, [result])

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
                use_critic: useCritic,
                local_endpoint: provider === "local" ? localEndpoint : "",
            })
            const completed = await waitForAnalysis(run.data.job_id)
            setResult({ ...completed, parsed_resume: upload.data.parsed, job_description: jobDescription, raw_text: upload.data.parsed.raw_text })
            setAnalysisId(completed.analysis_id)
            setDecisions({})
            setView("Suggestions")
            setSidebarCollapsed(false)
            setSetupExpanded(false)
            setExported(false)
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

    if (!user) return <AuthPage />
    const isMentor = user.role === "mentor"

    // mentors land in their workspace - they review others' resumes, not their own
    if (isMentor) {
        return <main className="app-container">
            <ToastHost />
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
            <TopNav view={view} setView={setView} />
            <div className={`workspace ${sidebarCollapsed ? "sidebar-is-collapsed" : ""}`}>
            <ResultsSidebar result={result} user={user} onLogout={logout} history={history} collapsed={sidebarCollapsed} onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)} />
            <div className="workspace-main">
                <div className="fade-in" key={view}>
                    {view === "Suggestions" && <RewriteReview result={result} file={file} decisions={decisions} setDecisions={setDecisions} analysisId={analysisId} />}
                    {view === "Keyword Gap" && <KeywordGap result={result} />}
                    {view === "Extracted Sections" && <ExtractedSections result={result} />}
                    {view === "Tailored CV" && <DocumentGenerator type="cv" result={result} provider={provider} localEndpoint={localEndpoint} decisions={decisions} analysisId={analysisId} text={docs.cv} setText={t => setDocs({ ...docs, cv: t })} onExport={() => setExported(true)} />}
                    {view === "Cover Letter" && <DocumentGenerator type="cover-letter" result={result} provider={provider} localEndpoint={localEndpoint} decisions={decisions} analysisId={analysisId} text={docs.cover_letter} setText={t => setDocs({ ...docs, cover_letter: t })} onExport={() => setExported(true)} />}
                    {view === "Mentor Feedback" && <FeedbackInbox />}
                    {view === "Analytics" && <Analytics result={result} history={history} decisions={decisions} />}
                    {view === "Job Matching" && <JobMatching result={result} provider={provider} localEndpoint={localEndpoint} />}
                </div>
            </div>
            </div>
        </>}
    </main>
}

export default App
