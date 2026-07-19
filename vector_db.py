import os
import functools
import hashlib
import time
from dataclasses import dataclass
from typing import Any

try:
    import chromadb
    from chromadb.utils import embedding_functions
    CHROMA_AVAILABLE = True
except ImportError:
    CHROMA_AVAILABLE = False


@dataclass
class FwHit:
    document:  str
    framework: str
    category:  str
    score:     float


import threading
_col = None
_lock = threading.Lock()
_CHROMA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chroma_db")

FRAMEWORKS = [
    {"id": "google_xyz", "metadata": {"framework": "Google XYZ", "category": "structure"}, "document": "Google XYZ Formula: Accomplished [X] as measured by [Y], by doing [Z]. X = the achievement, Y = how you prove it with a number, Z = the method or tool used. Example strong: 'Improved model inference speed by 2x, as measured by p95 latency dropping from 800ms to 400ms, by switching to a batched prediction pipeline.' Example weak (before): 'Worked on improving the model speed.' Apply this to every bullet in the experience section. If Y is missing, prompt the user to add a metric."},
    {"id": "star_method", "metadata": {"framework": "STAR", "category": "structure"}, "document": "STAR Method: Situation, Task, Action, Result. Best for project and internship bullets where context matters. Example: 'Facing 30% drop in checkout conversions (S), I was tasked with diagnosing the UX failure (T). I ran A/B tests across 3 UI variants (A), recovering conversions to baseline within 2 weeks (R).' Keep it concise — STAR bullets should still be one or two lines max on a resume. Lead with the result when the impact is strong enough to be a hook."},
    {"id": "rule_of_3", "metadata": {"framework": "Rule of 3", "category": "structure"}, "document": "Rule of 3: Every bullet needs three elements — action verb, measurable metric, clear outcome. Example strong: 'Reduced API response time by 40% by refactoring the caching layer, improving user retention by 15%.' Example weak: 'Helped with backend work.' Ask three questions about every bullet: What did you do? By how much? So what? If any answer is missing, the bullet is incomplete."},
    {"id": "action_verbs", "metadata": {"framework": "ATS", "category": "language"}, "document": "Strong ATS action verbs — always start bullets with one of these (past tense). Engineering: Architected, Deployed, Optimised, Refactored, Automated, Integrated, Migrated, Debugged, Implemented. Leadership: Spearheaded, Directed, Mentored, Coordinated, Oversaw, Championed. Impact: Reduced, Increased, Improved, Accelerated, Delivered, Generated, Achieved, Streamlined. Research: Investigated, Analysed, Modelled, Evaluated, Benchmarked, Prototyped. Never start with: 'I', 'We', 'Responsible for', 'Helped', 'Assisted', 'Worked on'. These are passive and get filtered by ATS scanners."},
    {"id": "weak_phrases", "metadata": {"framework": "ATS", "category": "anti-patterns"}, "document": "Weak phrases that kill resume bullets and how to fix them. 'Responsible for X' → rewrite as a direct action: 'Built X that achieved Y.' 'Helped with X' → be specific: 'Designed the X module, contributing Y% of total codebase.' 'Worked on X' → name what you shipped: 'Delivered X feature, adopted by N users.' 'Familiar with X' → only list skills you can speak to in an interview. 'Good communication skills' → demonstrate it: 'Presented findings to 30+ stakeholders, securing budget approval.' 'Various tasks' → list the top 2–3 concrete things you actually did."},
    {"id": "quantification_guide", "metadata": {"framework": "Rule of 3", "category": "metrics"}, "document": "How to add numbers when you don't think you have any. Team size: 'Collaborated with a 6-person cross-functional team.' Scale: 'System served 10,000 daily active users.' Time saved: 'Automated the reporting pipeline, saving ~3 hours of manual work per week.' Scope: 'Led migration of 5 legacy services to a microservices architecture.' Ranking: 'Ranked top 10% among 200 interns in end-of-term evaluation.' Frequency: 'Conducted weekly code reviews across 4 junior developers.' If you genuinely have no numbers, use scope, frequency, or relative improvement — anything is better than a bullet with no anchor."},
    {"id": "projects_section_guide", "metadata": {"framework": "Google XYZ", "category": "projects"}, "document": "How to write strong project bullets. Lead with what you built, not what it is: 'Built an X that does Y' not 'X is a project that...' Always mention: tech stack used, scale or users if applicable, and what problem it solved. Example: 'Developed a RAG-based resume optimiser using LangChain, ChromaDB, and FastAPI, reducing user time-to-feedback from hours to under 60 seconds.' Include GitHub link if the repo is public. For academic projects: mention dataset size, model accuracy, or benchmark improvement."},
    {"id": "education_section_guide", "metadata": {"framework": "structure", "category": "education"}, "document": "Education section best practices. Format: Degree, Major — University Name (Graduation Year) | GPA if above 3.5/4.0 or equivalent. List relevant coursework only if you have fewer than 2 years of experience. Achievements like Dean's List, scholarships, or top-cohort rankings belong here. For NUS/NTU/SMU students: CAP score is worth including if above 4.0. Don't list high school if you have a university degree."},
]


def _get_col() -> Any:
    global _col
    if not CHROMA_AVAILABLE:
        raise ImportError("ChromaDB is required. Run: pip install chromadb sentence-transformers")

    with _lock:
        if _col is not None:
            return _col

        _col = chromadb.PersistentClient(path=_CHROMA_PATH).get_or_create_collection(
            name="resume_frameworks",
            embedding_function=embedding_functions.SentenceTransformerEmbeddingFunction(model_name="all-MiniLM-L6-v2"),
            metadata={"hnsw:space": "cosine"},
        )

        if _col.count() == 0:
            _col.upsert(
                ids=[f["id"] for f in FRAMEWORKS],
                documents=[f["document"] for f in FRAMEWORKS],
                metadatas=[f["metadata"] for f in FRAMEWORKS],
            )
    return _col


_fw_cache: dict[str, tuple[float, list[FwHit]]] = {}
_fw_cache_lock = threading.Lock()
_CACHE_TTL_SECONDS = 3600
_cache_hits = 0
_cache_misses = 0


def query_fw(text: str, n_results: int = 3) -> list[FwHit]:
    """retrieve the most relevant writing framework docs for RAG context."""
    normalized = " ".join(text.split()).lower()
    cache_key = f"{hashlib.sha256(normalized.encode('utf-8')).hexdigest()}::{n_results}::v1"
    global _cache_hits, _cache_misses
    with _fw_cache_lock:
        cached = _fw_cache.get(cache_key)
        if cached and time.monotonic() - cached[0] < _CACHE_TTL_SECONDS:
            _cache_hits += 1
            return cached[1]
        _cache_misses += 1

    col = _get_col()
    n = min(n_results, col.count())
    if n == 0: return []

    res = col.query(query_texts=[text], n_results=n, include=["documents", "metadatas", "distances"])

    hits = [
        FwHit(
            document=doc,
            framework=meta.get("framework", ""),
            category=meta.get("category", ""),
            score=round(1 - dist, 3)
        )
        for doc, meta, dist in zip(res["documents"][0], res["metadatas"][0], res["distances"][0])
    ]

    with _fw_cache_lock:
        if len(_fw_cache) > 256:
            _fw_cache.clear()
        _fw_cache[cache_key] = (time.monotonic(), hits)

    return hits


def get_cache_stats() -> dict[str, int]:
    with _fw_cache_lock:
        return {"hits": _cache_hits, "misses": _cache_misses, "entries": len(_fw_cache)}
