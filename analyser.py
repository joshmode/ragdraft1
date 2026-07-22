from typing import Any
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
import re
import time
from datetime import date
from dotenv import load_dotenv

from vector_db import query_fw
from parser import ParsedResume
from router import llm_call

load_dotenv()

# bullets bundled into one llm call during rewriting, fewer round trips = faster
_CHUNK_SIZE = max(1, int(os.environ.get("REWRITE_CHUNK_SIZE", "6")))

# banned ai jargon that make resumes sound generic
_BANNED_WORDS = (
    "delve, synergy, leverage, utilize, utilise, cutting-edge, innovative, "
    "passion, passionate, dynamic, robust, seamless, holistic, paradigm, "
    "ecosystem, empower, foster, game-changer, best-in-class, world-class, "
    "bleeding-edge, thought leader"
)


def _kw_in_resume(kw: str, resume_lower: str) -> bool:
    return bool(re.search(r'\b' + re.escape(kw.lower()) + r'\b', resume_lower))


def kw_freqs(jd_keywords: list[str], resume_text: str) -> dict[str, int]:
    lower = resume_text.lower()
    freqs = {}
    for kw in jd_keywords:
        hits = re.findall(r'\b' + re.escape(kw.lower()) + r'\b', lower)
        if hits:
            freqs[kw] = len(hits)
    return freqs


_THINK_BLOCK_RE = re.compile(r'<think(?:ing)?\b[^>]*>.*?</think(?:ing)?>', re.IGNORECASE | re.DOTALL)


def _parse_json(raw: str) -> Any:
    """extract json from llm output, stripping reasoning traces, markdown fences and filler."""
    # reasoning-tuned models (several free-tier ones included) sometimes emit a <think>...</think>
    # block before the actual answer even when told not to - strip it so it can't get mistaken
    # for the response itself or eat into the parse below
    cleaned = _THINK_BLOCK_RE.sub('', raw).strip()

    if cleaned.startswith("```"):
        lines = cleaned.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        cleaned = "\n".join(lines).strip()

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        decoder = json.JSONDecoder()
        starts = [idx for idx, char in enumerate(cleaned) if char in "{["]
        for idx in starts:
            try:
                value, _ = decoder.raw_decode(cleaned[idx:])
                if isinstance(value, (dict, list)):
                    return value
            except json.JSONDecodeError:
                continue
        raise


def extract_jd_kws(job_desc: str, provider: str, local_endpoint: str, model: str = "", api_key: str = "") -> list[str]:
    """pull technical keywords from a job description via llm.

    Raises on failure (rate limit, timeout, malformed response) instead of swallowing the
    error - the caller needs to tell "no JD was given" apart from "extraction failed", since
    both would otherwise look identical to the frontend as an empty jd_keywords list."""
    if not job_desc.strip():
        return []

    prompt = (
        "Extract every technical skill, tool, framework, methodology, certification, "
        "and domain-specific keyword from this job description. "
        "Return ONLY a JSON array of short strings — no explanation, no reasoning, no "
        "preamble, no markdown fences, nothing before or after the array. "
        'Example output: ["Python", "Docker", "CI/CD", "REST API", "agile"]\n\n'
        f"Job description:\n{job_desc}"
    )

    # generous budget: some free-tier models spend a large chunk of their output on an
    # internal reasoning trace before ever emitting the actual array, and a tight cap here
    # was truncating the response before the JSON ever appeared
    raw = llm_call(user_prompt=prompt, provider=provider, local_endpoint=local_endpoint,
                   model=model, max_tokens=4096, api_key=api_key)
    return _parse_json(raw)


_QUANT_RE = re.compile(r'(?<!\w)(?:\$?\d+(?:\.\d+)?(?:[%xX])?|\d+(?:\.\d+)?\s*(?:users?|people|clients?|customers?|hours?|days?|weeks?|months?|years?))(?!\w)', re.IGNORECASE)


def _has_new_claims(original: str, rewritten: str) -> bool:
    def claims(text: str) -> set[str]:
        out = set()
        for match in _QUANT_RE.findall(text):
            if re.fullmatch(r"(?:19|20)\d{2}", match.strip()):
                continue
            out.add(match.lower())
        return out

    orig_claims = claims(original)
    new_claims = claims(rewritten)
    return bool(new_claims - orig_claims)


def _critic_creds(provider: str, model: str, api_key: str, local_endpoint: str) -> tuple[str, str, str, str]:
    # CRITIC_SAME_AS_MAIN=false pins the critic to CRITIC_PROVIDER/CRITIC_API_KEY instead
    if os.environ.get("CRITIC_SAME_AS_MAIN", "true").lower() == "false":
        provider = os.environ.get("CRITIC_PROVIDER", "openrouter")
        api_key = os.environ.get("CRITIC_API_KEY", "")
        local_endpoint = os.environ.get("CRITIC_LOCAL_ENDPOINT", "")
        model = os.environ.get("CRITIC_MODEL", "")
    elif os.environ.get("CRITIC_MODEL"):
        # same provider/key as the main request, but the critic can still run its own
        # (usually cheaper/faster) model instead of inheriting whatever the main agent used
        model = os.environ["CRITIC_MODEL"]
    return provider, model, api_key, local_endpoint


def _run_critic(
    bullet: str,
    rewritten: str,
    result: dict,
    usr_prompt: str,
    sys_prompt: str,
    provider: str,
    local_endpoint: str,
    model: str,
    api_key: str = "",
) -> dict:
    if not _has_new_claims(bullet, rewritten):
        result["critic"] = {"status": "skipped", "reason": "No new quantitative claim detected."}
        return result

    provider, model, api_key, local_endpoint = _critic_creds(provider, model, api_key, local_endpoint)

    try:
        critic_prompt = (
            "Compare these two text strings for factual consistency.\n"
            f"String A (original): {bullet}\n"
            f"String B (rewritten): {rewritten}\n"
            "Does string B contain any specific numbers, percentages, dollar amounts, "
            "team sizes, or metrics that are NOT present in string A? "
            "Placeholders like [X%] or [N users] are acceptable and should not be flagged. "
            "Respond with exactly one word: PASS or FAIL followed by a colon and reason."
        )

        critic_raw = llm_call(
            user_prompt=critic_prompt, provider=provider,
            local_endpoint=local_endpoint, model=model,
            max_tokens=100, timeout=30, max_retries=1, api_key=api_key,
        )

        if critic_raw.strip().upper().startswith("FAIL"):
            retry_prompt = (
                usr_prompt +
                f"\n\nCRITIC FEEDBACK: {critic_raw.strip()}\n"
                "Please fix the hallucination and ensure no new metrics are invented."
            )
            retry_raw = llm_call(
                user_prompt=retry_prompt, system_prompt=sys_prompt,
                provider=provider, local_endpoint=local_endpoint,
                model=model, max_tokens=1024, timeout=30, max_retries=1, api_key=api_key,
            )
            try:
                result = _parse_json(retry_raw)
            except Exception:
                pass

            sev = result.get("severity", "yellow").lower()
            if sev not in ("red", "yellow", "green"):
                sev = "yellow"
            result["severity"] = sev
            if _has_new_claims(bullet, result.get("rewritten", bullet)):
                result["rewritten"] = rewritten
                result["critic"] = {"status": "failed", "reason": "Corrected rewrite still introduced a new claim."}
            else:
                result["critic"] = {"status": "repaired", "reason": critic_raw.strip()}
        else:
            result["critic"] = {"status": "passed", "reason": critic_raw.strip()}
    except Exception as critic_err:
        print(f"critic isolated failure, keeping pre-critic result: {critic_err}")
        result["critic"] = {"status": "failed", "reason": str(critic_err)}

    return result


_REWRITE_SYS_PROMPT = (
    "You are an expert resume coach. Rewrite weak resume bullets into strong, "
    "ATS-optimised, results-driven statements using the STAR method "
    "(Situation, Task, Action, Result) or Google XYZ framework where applicable. "
    "Write in a grounded, conversational tone — like a competent engineer wrote it, "
    "not a marketing copywriter. "
    "CRITICAL — never invent, assume, or extrapolate any facts: no new metrics, "
    "percentages, team sizes, technologies, employers, or outcomes that are not "
    "explicitly stated in the original bullet. Use placeholders like [X%] or [N users] "
    "when a metric is clearly missing and note it in reasoning. "
    "You MUST apply one of the provided writing frameworks. "
    f"\n\nBANNED WORDS (never use these): {_BANNED_WORDS}\n"
    "Always respond with valid JSON only, no markdown."
)

_RESULT_SCHEMA = (
    "{\n"
    '  "rewritten": "the improved bullet point",\n'
    '  "reasoning": "one sentence: what was weak, what framework was applied, what changed",\n'
    '  "framework_used": "Google XYZ | STAR | Rule of 3 | Action Verb | other",\n'
    '  "severity": "red | yellow | green"\n'
    "}"
)

_SEVERITY_GUIDE = (
    "Severity guide — rate the ORIGINAL bullet, not the rewrite: "
    "red = very weak passive language, missing action verb, or no discernible impact. "
    "yellow = structurally okay but missing a metric or could be stronger. "
    "green = already strong; only minor polish applied."
)


def _build_rewrite_prompts(bullet: str, frameworks: list[Any], missing_kws: list[str]) -> tuple[str, str]:
    fw_ctx = "\n\n".join(f.document for f in frameworks)
    kw_hint = ", ".join(missing_kws[:12]) if missing_kws else "none"

    usr_prompt = (
        f"FRAMEWORK GUIDANCE (apply the most relevant one):\n{fw_ctx}\n\n"
        f"ATS KEYWORDS TO WEAVE IN NATURALLY (only if genuinely relevant):\n{kw_hint}\n\n"
        f"BULLET TO REWRITE:\n{bullet}\n\n"
        f"Respond with this exact JSON structure:\n{_RESULT_SCHEMA}\n"
        f"{_SEVERITY_GUIDE}"
    )
    return _REWRITE_SYS_PROMPT, usr_prompt


def _normalise_severity(result: dict) -> dict:
    sev = str(result.get("severity", "yellow")).lower()
    if sev not in ("red", "yellow", "green"):
        sev = "yellow"
    result["severity"] = sev
    return result


def rewrite_item(
    bullet: str,
    frameworks: list[Any],
    missing_kws: list[str],
    provider: str,
    local_endpoint: str,
    use_critic: bool = False,
    model: str = "",
    api_key: str = "",
) -> dict:
    """rewrite a single bullet using RAG frameworks. optionally run critic loop."""
    sys_prompt, usr_prompt = _build_rewrite_prompts(bullet, frameworks, missing_kws)

    try:
        raw = llm_call(user_prompt=usr_prompt, system_prompt=sys_prompt,
                       provider=provider, local_endpoint=local_endpoint,
                       model=model, max_tokens=1024, api_key=api_key)
        result = _normalise_severity(_parse_json(raw))

        if use_critic:
            result = _run_critic(
                bullet, result.get("rewritten", bullet), result,
                usr_prompt, sys_prompt, provider, local_endpoint, model, api_key=api_key,
            )

        result["original"] = bullet
        return result

    except Exception as e:
        print(f"bullet rewrite bypassed: {e}")
        return {
            "original":       bullet,
            "rewritten":      bullet,
            "reasoning":      "Rewrite skipped due to model formatting failure.",
            "framework_used": "error",
            "severity":       "red"
        }


def rewrite_chunk(
    items: list[tuple[str, list[Any]]],
    missing_kws: list[str],
    provider: str,
    local_endpoint: str,
    use_critic: bool = False,
    model: str = "",
    api_key: str = "",
) -> list[dict]:
    """rewrite a batch of resume bullets in a single LLM call instead of one call per bullet.

    Falls back to per-bullet calls (rewrite_item) for the batch if the model's
    response can't be matched back to the input bullets 1:1, so batching never
    trades away correctness — only the common case gets faster.
    """
    if not items:
        return []
    if len(items) == 1:
        text, fws = items[0]
        return [rewrite_item(text, fws, missing_kws, provider, local_endpoint, use_critic, model=model, api_key=api_key)]

    kw_hint = ", ".join(missing_kws[:12]) if missing_kws else "none"

    seen_fw: dict[str, None] = {}
    for _text, fws in items:
        for f in fws:
            seen_fw.setdefault(f.document, None)
    fw_ctx = "\n\n".join(seen_fw.keys())

    bullets_block = "\n\n".join(f"[{i}] {text}" for i, (text, _fws) in enumerate(items))

    usr_prompt = (
        f"FRAMEWORK GUIDANCE (apply the most relevant one to each bullet):\n{fw_ctx}\n\n"
        f"ATS KEYWORDS TO WEAVE IN NATURALLY (only if genuinely relevant):\n{kw_hint}\n\n"
        f"BULLETS TO REWRITE — {len(items)} independent bullets, numbered in order. "
        f"Rewrite EVERY one, keep the same order, do not merge or skip any:\n{bullets_block}\n\n"
        f"Respond with ONLY a JSON array of exactly {len(items)} objects, one per bullet "
        f"in the same order as the input, each with this exact structure:\n{_RESULT_SCHEMA}\n"
        f"{_SEVERITY_GUIDE}"
    )

    try:
        raw = llm_call(user_prompt=usr_prompt, system_prompt=_REWRITE_SYS_PROMPT,
                       provider=provider, local_endpoint=local_endpoint,
                       model=model, max_tokens=min(8192, 500 * len(items)), api_key=api_key)
        parsed = _parse_json(raw)
        if not isinstance(parsed, list) or len(parsed) != len(items):
            got = len(parsed) if isinstance(parsed, list) else type(parsed).__name__
            raise ValueError(f"expected {len(items)} rewrites in response, got {got}")

        results = []
        for (text, _fws), item_result in zip(items, parsed):
            if not isinstance(item_result, dict):
                raise ValueError("chunk response item was not a JSON object")
            item_result = _normalise_severity(dict(item_result))
            item_result["original"] = text
            results.append(item_result)

    except Exception as e:
        print(f"chunk rewrite failed ({len(items)} bullets), falling back to per-bullet calls: {e}")
        return [
            rewrite_item(text, fws, missing_kws, provider, local_endpoint, use_critic, model=model, api_key=api_key)
            for text, fws in items
        ]

    if use_critic:
        for i, (text, fws) in enumerate(items):
            sys_prompt, usr_prompt_single = _build_rewrite_prompts(text, fws, missing_kws)
            results[i] = _run_critic(
                text, results[i].get("rewritten", text), results[i],
                usr_prompt_single, sys_prompt, provider, local_endpoint, model, api_key=api_key,
            )

    return results


_BULLET_PREFIX_RE = re.compile(r'^\s*(?:[-*•‣▪▫◦●]|\d+[.)]|[a-zA-Z][.)])\s+')
_DATE_RE = re.compile(r'\b(?:19|20)\d{2}\b|\b(?:present|current)\b', re.IGNORECASE)
_DATE_RANGE_RE = re.compile(
    r'\b(?:19|20)\d{2}\s*(?:[-–—]|to)\s*(?:(?:19|20)\d{2}|present|current)\b',
    re.IGNORECASE,
)
_JOB_TITLE_RE = re.compile(
    r'^[A-Z][A-Za-z\s,/&]+'
    r'(?:[,|–—\-]\s*[A-Z][A-Za-z\s,&.]+)*'
    r'\s*[,|–—\-]?\s*'
    r'(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+)?'
    r'(?:19|20)\d{2}',
    re.IGNORECASE,
)
_ACTION_VERBS = {
    "achieved", "administered", "analysed", "analyzed", "automated", "built", "collaborated",
    "conducted", "created", "delivered", "designed", "developed", "drove", "enabled",
    "engineered", "executed", "improved", "increased", "launched", "led", "managed",
    "investigated", "optimised", "optimized", "owned", "partnered", "prepared", "reduced",
    "resolved", "shipped", "streamlined", "supported", "trained", "transformed",
    "implemented", "utilised", "utilized", "spearheaded", "directed", "orchestrated",
    "programmed", "architected", "mentored", "published", "researched", "formulated",
    "integrated", "migrated", "debugged", "facilitated", "generated", "coordinated",
    "evaluated", "benchmarked", "prototyped",
}


def _strip_prefix(line: str) -> tuple[str, bool]:
    stripped = re.sub(r'\s+', ' ', line).strip()
    m = _BULLET_PREFIX_RE.match(stripped)
    if not m:
        return stripped, False
    return stripped[m.end():].strip(), True


def _sent_complete(text: str) -> bool:
    return bool(re.search(r'[.!?]\s*$', text.strip()))


def _first_word(text: str) -> str:
    m = re.match(r'^[^\w]*([A-Za-z]+)', text.strip())
    return m.group(1).lower() if m else ""


def _is_header(line: str, section: str = "") -> bool:
    cleaned, has_bullet = _strip_prefix(line)
    if has_bullet:
        return False

    words = cleaned.split()
    wc = len(words)
    if wc == 0:
        return True

    if wc <= 3 and cleaned.endswith(":"):
        return True

    relaxed = ("PROJECTS", "EDUCATION", "SKILLS", "CERTIFICATIONS", "AWARDS", "VOLUNTEER")
    if section not in relaxed and wc <= 4 and not _sent_complete(cleaned):
        return True

    has_range = bool(_DATE_RANGE_RE.search(cleaned))
    has_date = bool(_DATE_RE.search(cleaned))

    if has_range and wc <= 20 and not _sent_complete(cleaned):
        return True
    if has_date and wc <= 14 and not _sent_complete(cleaned):
        return True

    if _JOB_TITLE_RE.match(cleaned) and not _sent_complete(cleaned):
        return True

    if section == "SKILLS":
        return False

    # for proj lines that look like project name headers but contain tech stack indicators are treated as subheaders
    if section == "PROJECTS":
        has_pipe = "|" in cleaned or "–" in cleaned or "—" in cleaned
        starts_action = _first_word(cleaned) in _ACTION_VERBS
        if has_pipe and wc <= 12 and not starts_action:
            return True
        # very short lines without action verbs that are title-cased are project name headers
        if wc <= 5 and not starts_action and not _sent_complete(cleaned):
            title_words = sum(1 for w in words if w[:1].isupper() or w.isupper())
            if title_words / max(wc, 1) >= 0.6:
                return True
        return False

    title_words = sum(1 for w in words if w[:1].isupper() or w.isupper())
    title_ratio = title_words / max(wc, 1)
    starts_action = _first_word(cleaned) in _ACTION_VERBS

    if title_ratio >= 0.75 and wc <= 14 and not starts_action and not _sent_complete(cleaned):
        return True

    return False


def _is_candidate(line: str, has_bullet: bool = False, section: str = "") -> bool:
    cleaned, marker = _strip_prefix(line)
    has_bullet = has_bullet or marker
    words = cleaned.split()
    if _is_header(line, section=section):
        return False

    relaxed = ("EXPERIENCE", "PROJECTS", "VOLUNTEER", "SUMMARY", "SKILLS", "EDUCATION")
    min_chars = 20 if section in relaxed else 35
    min_words = 3 if section in relaxed else 6

    if len(cleaned) < min_chars or len(words) < min_words:
        return False

    if re.search(r'@|linkedin\.com|github\.com|https?://', cleaned, re.IGNORECASE):
        return False

    starts_action = _first_word(cleaned) in _ACTION_VERBS
    if section == "PROJECTS" and starts_action:
        return True

    return has_bullet or len(words) >= (3 if section in relaxed else 7)


def _looks_like_bullet(line: str) -> bool:
    return _is_candidate(line)


def _make_id(sec: str, idxs: list[int], text: str) -> str:
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()[:10]
    first = idxs[0] if idxs else 0
    return f"{sec}:{first}:{digest}"


def _flush_unit(
    units: list[dict[str, Any]],
    sec: str,
    buf: list[tuple[int, str]],
    eligible: bool,
) -> None:
    if not buf:
        return
    idxs = [i for i, _ in buf]
    text = " ".join(_strip_prefix(line)[0] for _, line in buf)
    text = re.sub(r'\s+', ' ', text).strip()
    units.append({
        "id": _make_id(sec, idxs, text),
        "text": text,
        "line_indices": idxs,
        "eligible": eligible and _is_candidate(text, section=sec),
    })


def _build_units(sec: str, lines: list[str]) -> list[dict[str, Any]]:
    units: list[dict[str, Any]] = []
    buf: list[tuple[int, str]] = []
    buf_ok = False

    for idx, line in enumerate(lines):
        cleaned, has_bullet = _strip_prefix(line)
        if not cleaned:
            continue

        header = _is_header(line, section=sec)
        cand = _is_candidate(line, has_bullet=has_bullet, section=sec)
        if header:
            _flush_unit(units, sec, buf, buf_ok)
            _flush_unit(units, sec, [(idx, line)], False)
            buf = []
            buf_ok = False
            continue

        # start new unit after a complete sentence
        buf_text = " ".join(part for _, part in buf) if buf else ""
        buf_done = _sent_complete(buf_text)
        new_unit = (has_bullet or not buf or (buf_done and cand))

        if new_unit:
            _flush_unit(units, sec, buf, buf_ok)
            buf = [(idx, line)]
            buf_ok = cand and not header
        else:
            buf.append((idx, line))
            buf_ok = buf_ok or cand

    _flush_unit(units, sec, buf, buf_ok)
    return units


def calc_score(resume: ParsedResume, jd_kws: list[str], missing: list[str], rewrites: dict[str, list[dict]]) -> dict:
    bd = {"base": 30, "sections": 0, "keywords": 0, "bullet_quality": 0, "action_verbs": 0, "warnings": 0, "total": 0}

    for sec in ("EXPERIENCE", "EDUCATION", "SKILLS", "PROJECTS"):
        if sec in resume.sections:
            bd["sections"] += 8

    if jd_kws:
        found = len(jd_kws) - len(missing)
        bd["keywords"] += int((found / len(jd_kws)) * 20)

    qual = 0
    actionable_n = 0
    verb_hits = 0
    section_scores: dict[str, dict] = {}

    # the heatmap grades every bullet the model actually looked at (its severity call on the
    # ORIGINAL text), whether or not a rewrite was applied - a section full of bullets rated
    # "already great, nothing to change" is a strong section, not an absent one. The global
    # bullet_quality/action_verbs score below stays exactly as before: only bullets that were
    # actually rewritten count toward it.
    for sec_name, items in rewrites.items():
        sec_qual = 0
        sec_count = 0
        sec_verbs = 0
        sev_counts = {"red": 0, "yellow": 0, "green": 0}
        for item in items:
            if item.get("framework_used") in ("none", "error"):
                continue
            sec_count += 1
            sev = item.get("severity", "yellow")
            sev_counts[sev] = sev_counts.get(sev, 0) + 1
            sec_qual += {"green": 3, "yellow": 2, "red": 1}.get(sev, 1)
            lead_word = item.get("rewritten", "").split()[0].lower().rstrip(".,;:") if item.get("rewritten", "").strip() else ""
            if lead_word in _ACTION_VERBS:
                sec_verbs += 1

            changed = item.get("original") != item.get("rewritten")
            if changed:
                actionable_n += 1
                qual += {"green": 2, "yellow": 1, "red": 0}.get(sev, 0)
                if lead_word in _ACTION_VERBS:
                    verb_hits += 1
        if sec_count > 0:
            section_scores[sec_name] = {
                "quality": min(100, int((sec_qual / (sec_count * 3)) * 100)),
                "verb_ratio": round(sec_verbs / sec_count, 2),
                "severity_counts": sev_counts,
                "bullet_count": sec_count,
            }

    # sections with content but nothing gradable (e.g. a plain SKILLS list) shouldn't just
    # vanish from the heatmap - show them as healthy since nothing was flagged as weak
    for sec_name in resume.sections:
        if sec_name != "HEADER" and sec_name not in section_scores:
            section_scores[sec_name] = {
                "quality": 100, "verb_ratio": 0,
                "severity_counts": {"red": 0, "yellow": 0, "green": 0}, "bullet_count": 0,
            }

    bd["bullet_quality"] = min(10, qual)

    if actionable_n > 0:
        bd["action_verbs"] = min(8, int((verb_hits / actionable_n) * 8))

    bd["warnings"] = -(len([w for w in resume.warnings if "not detected" in w]) * 3)

    total = sum(v for k, v in bd.items() if k != "total")
    bd["total"] = max(0, min(100, total))
    bd["section_scores"] = section_scores
    return bd


def analyse(
    resume: ParsedResume,
    job_description: str,
    provider: str = "gemini",
    local_endpoint: str = "",
    use_critic: bool = False,
    model: str = "",
    api_key: str = "",
) -> dict:
    t_start = time.perf_counter()

    # kw extraction is a network call, run it alongside the local unit-building/retrieval below
    t_kw = time.perf_counter()
    kw_future = None
    kw_pool = ThreadPoolExecutor(max_workers=1)
    if job_description.strip():
        kw_future = kw_pool.submit(extract_jd_kws, job_description, provider, local_endpoint, model, api_key)

    rewrites: dict[str, list[dict]] = {}

    primary = ("EXPERIENCE", "PROJECTS", "VOLUNTEER", "SUMMARY")

    jobs: list[tuple[str, int, dict]] = []

    for sec in primary:
        lines = resume.sections.get(sec, [])
        if not lines:
            continue
        for i, unit in enumerate(_build_units(sec, lines)):
            jobs.append((sec, i, unit))

    # every other detected section (SKILLS, EDUCATION, CERTIFICATIONS, LANGUAGES, etc.) - a
    # fixed whitelist here used to fall out of sync with parser.py's section aliases, so any
    # section not on that list (e.g. Languages, References) was silently never examined at all
    for sec, lines in resume.sections.items():
        if sec == "HEADER" or sec in primary or not lines:
            continue
        for i, unit in enumerate(_build_units(sec, lines)):
            text = unit["text"]
            words = text.split()
            unit["eligible"] = (
                unit["eligible"]
                or (len(words) >= 4 and not _is_header(text, section=sec))
            )
            jobs.append((sec, i, unit))

    t_retrieval = time.perf_counter()
    fw_cache_local: dict[str, list] = {}
    for sec, i, unit in jobs:
        text = unit["text"]
        if unit["eligible"] and not _is_header(text, section=sec):
            if text not in fw_cache_local:
                fw_cache_local[text] = query_fw(text, n_results=2)
    t_retrieval = time.perf_counter() - t_retrieval

    # join the keyword extraction started before the local work
    jd_kws: list[str] = []
    kw_extraction_failed = False
    if kw_future is not None:
        try:
            jd_kws = kw_future.result()
        except Exception as kw_err:
            print(f"kw extraction failed: {kw_err}")
            kw_extraction_failed = True
    kw_pool.shutdown(wait=False)
    t_kw = time.perf_counter() - t_kw

    resume_lower = resume.raw_text.lower()
    missing = [kw for kw in jd_kws if not _kw_in_resume(kw, resume_lower)]

    def _label_rw(sec, unit):
        text = unit["text"]
        rw = {
            "original": text, "rewritten": text,
            "reasoning": "Header or label line — no rewrite needed.",
            "framework_used": "none",
        }
        rw["id"] = unit["id"]
        rw["section"] = sec
        rw["line_indices"] = unit["line_indices"]
        rw["highlight_text"] = text
        return rw

    results_by_sec: dict[str, list[tuple[int, dict]]] = {}
    eligible_jobs: list[tuple[str, int, dict]] = []
    for sec, i, unit in jobs:
        if unit["eligible"] and not _is_header(unit["text"], section=sec):
            eligible_jobs.append((sec, i, unit))
        else:
            results_by_sec.setdefault(sec, []).append((i, _label_rw(sec, unit)))

    # bundle bullets into chunks so one llm call rewrites several at once
    chunks = [eligible_jobs[k:k + _CHUNK_SIZE] for k in range(0, len(eligible_jobs), _CHUNK_SIZE)]

    def _do_chunk(chunk_jobs):
        items = [(unit["text"], fw_cache_local[unit["text"]]) for _sec, _i, unit in chunk_jobs]
        chunk_results = rewrite_chunk(items, missing, provider, local_endpoint, use_critic, model=model, api_key=api_key)
        out = []
        for (sec, i, unit), rw in zip(chunk_jobs, chunk_results):
            rw = dict(rw)
            rw["id"] = unit["id"]
            rw["section"] = sec
            rw["line_indices"] = unit["line_indices"]
            rw["highlight_text"] = unit["text"]
            out.append((sec, i, rw))
        return out

    workers = min(3 if use_critic else 8, max(len(chunks), 1))
    t_rewrite = time.perf_counter()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_do_chunk, chunk): idx for idx, chunk in enumerate(chunks)}
        for fut in as_completed(futures):
            chunk_idx = futures[fut]
            try:
                chunk_out = fut.result()
            except Exception as thread_err:
                print(f"chunk rewrite thread failed: {thread_err}")
                chunk_out = []
                for sec, i, unit in chunks[chunk_idx]:
                    rw = {
                        "original": unit["text"], "rewritten": unit["text"],
                        "reasoning": "Rewrite skipped due to processing error.",
                        "framework_used": "none",
                        "id": unit["id"], "section": sec,
                        "line_indices": unit["line_indices"],
                        "highlight_text": unit["text"],
                    }
                    chunk_out.append((sec, i, rw))
            for sec, i, rw in chunk_out:
                results_by_sec.setdefault(sec, []).append((i, rw))
    t_rewrite = time.perf_counter() - t_rewrite

    for sec, items in results_by_sec.items():
        items.sort(key=lambda x: x[0])
        rewrites[sec] = [rw for _, rw in items]

    score = calc_score(resume, jd_kws, missing, rewrites)
    freqs = kw_freqs(jd_kws, resume.raw_text)
    t_total = time.perf_counter() - t_start
    critic_counts: dict[str, int] = {}
    for section in rewrites.values():
        for item in section:
            status = item.get("critic", {}).get("status")
            if status:
                critic_counts[status] = critic_counts.get(status, 0) + 1

    return {
        "contact":             resume.contact,
        "sections":            resume.sections,
        "rewrites":            rewrites,
        "jd_keywords":         jd_kws,
        "missing_keywords":    missing,
        "keyword_frequencies": freqs,
        "keyword_extraction_failed": kw_extraction_failed,
        "score":               score,
        "warnings":            resume.warnings,
        "ocr_used":            resume.ocr_used,
        "no_jd_provided":      len(jd_kws) == 0,
        "timing": {
            "keywords_ms":   int(t_kw * 1000),
            "retrieval_ms":  int(t_retrieval * 1000),
            "rewriting_ms":  int(t_rewrite * 1000),
            "total_ms":      int(t_total * 1000),
        },
        "critic": critic_counts,
    }


def _apply_rewrites(
    sec: str,
    lines: list[str],
    acc_map: dict,
    suggestions: dict[str, list[dict]] | None,
    decisions: dict[str, bool] | None,
) -> tuple[list[str], list[dict], list[dict]]:
    if not suggestions or not decisions:
        return [acc_map.get(line, line) for line in lines], [], []

    by_first = {
        item["line_indices"][0]: item
        for item in suggestions.get(sec, [])
        if item.get("line_indices")
        and item.get("framework_used") not in ("none", "error")
    }

    out: list[str] = []
    accepted: list[dict] = []
    dismissed: list[dict] = []
    skip_until = -1

    for idx, line in enumerate(lines):
        if idx <= skip_until:
            continue

        item = by_first.get(idx)
        decision = decisions.get(item.get("id")) if item else None
        if item and decision is True:
            out.append(item.get("rewritten", item.get("original", line)))
            accepted.append(item)
            skip_until = max(item.get("line_indices", [idx]))
        elif item and decision is False:
            out.append(item.get("original", line))
            dismissed.append(item)
            skip_until = max(item.get("line_indices", [idx]))
        else:
            out.append(acc_map.get(line, line))

    return out, accepted, dismissed


def gen_cv(
    resume: ParsedResume,
    job_description: str,
    acc_map: dict,
    provider: str,
    local_endpoint: str,
    rewrite_suggestions: dict[str, list[dict]] | None = None,
    rewrite_decisions: dict[str, bool] | None = None,
    model: str = "",
    api_key: str = "",
) -> str:
    """generate a tailored CV from resume data and accepted rewrites."""
    has_jd = bool(job_description.strip())

    # build resume text with only accepted rewrites
    cv_text = ""
    acc_items: list[dict] = []
    dis_items: list[dict] = []

    if resume.contact:
        cv_text += "=== CONTACT ===\n"
        for k, v in resume.contact.items():
            cv_text += f"{k}: {v}\n"

    for sec, lines in resume.sections.items():
        cv_text += f"\n=== {sec} ===\n"
        applied, acc_sec, dis_sec = _apply_rewrites(sec, lines, acc_map, rewrite_suggestions, rewrite_decisions)
        acc_items.extend(acc_sec)
        dis_items.extend(dis_sec)
        for line in applied:
            cv_text += line + "\n"

    # cv_text already has decisions applied - never show the model dismissed rewrite text again
    section_names = list(resume.sections.keys())
    section_list = ", ".join(section_names) if section_names else "the sections present in the resume"

    sys_prompt = (
        "You are an expert CV formatter and editor. Reformat the candidate's resume into a "
        "professional, ATS-friendly CV in Markdown. The resume text you receive is FINAL: "
        "every bullet already reflects the candidate's accepted wording decisions. "
        "Preserve the meaning and content of every bullet — you may tighten grammar and phrasing, "
        "but never drop a role, project, qualification, or section, and never re-order facts between roles. "
        "Never invent employers, dates, credentials, projects, metrics, or skills not present in the resume. "
        "Write in a grounded, professional tone. Avoid corporate fluff. "
        f"\n\nBANNED WORDS (never use these): {_BANNED_WORDS}\n"
        "\nFORMATTING RULES — follow these exactly:\n"
        "1. Output ONLY the final CV in Markdown format, nothing else.\n"
        f"2. Include EVERY one of these sections, each with all of its content: {section_list}. "
        "Do not omit or merge any of them. If content is long, keep it — a 2-page CV is fine.\n"
        "3. Start with the candidate's name as # Name.\n"
        "4. Contact details on a single line separated by ` | `.\n"
        "5. Each section: ## SECTION NAME in ALL CAPS, followed by `---`.\n"
        "6. Job/project titles as ### or **_Title_**, dates on the same line after `|`.\n"
        "7. Bullets start with a strong ATS action verb in past tense where the original does.\n"
        "8. Keep every single bullet from the source resume, in the same order, one output bullet "
        "per source bullet. Do not drop, merge, or skip any bullet for any reason, including ones "
        "that look redundant or weak - the candidate already decided which wording to keep for "
        "every bullet, and that decision must be preserved exactly.\n"
        "9. Section order: Summary first (if present), then Experience, Education, Skills, "
        "Projects, then all remaining sections in their original order. Every section listed "
        "in rule 2 MUST appear.\n"
        "10. No preamble, no explanation — CV text only."
    )

    jd_block = (
        f"JOB DESCRIPTION (for emphasis and keyword alignment only — do not fabricate skills to match it):\n{job_description}\n\n" if has_jd
        else "JOB DESCRIPTION:\nNone provided. Optimise for clarity, impact, and ATS readability.\n\n"
    )
    usr_prompt = (
        jd_block +
        f"CANDIDATE RESUME (final wording — reformat, do not rewrite decisions):\n{cv_text}\n\n"
        "Generate the complete CV in Markdown format now, containing every section listed in the rules."
    )

    try:
        raw = llm_call(user_prompt=usr_prompt, system_prompt=sys_prompt,
                       provider=provider, local_endpoint=local_endpoint,
                       model=model, max_tokens=8192, api_key=api_key)
        result = raw.strip()

        # if the model dropped a section anyway, append it back verbatim
        missing_secs = [
            sec for sec in section_names
            if sec.upper() not in result.upper()
        ]
        for sec in missing_secs:
            lines = resume.sections.get(sec, [])
            if not lines:
                continue
            applied, _, _ = _apply_rewrites(sec, lines, acc_map, rewrite_suggestions, rewrite_decisions)
            result += f"\n\n## {sec}\n---\n" + "\n".join(f"- {line}" for line in applied)
        return result
    except Exception as e:
        print(f"cv generation failed: {e}")
        return f"CV generation failed: {e}"


def gen_cover_letter(
    resume: ParsedResume,
    job_description: str,
    provider: str,
    local_endpoint: str,
    model: str = "",
    api_key: str = "",
) -> str:
    """generate a professional cover letter from resume and optional JD."""
    resume_text = resume.to_llm_prompt()

    sys_prompt = (
        "You are an expert cover letter writer. Generate a professional, compelling cover letter "
        "that connects the candidate's experience to the target role. "
        "Never invent employers, dates, credentials, projects, or metrics. "
        "Write in a grounded, conversational tone — confident but not sycophantic. "
        f"\n\nBANNED WORDS (never use these): {_BANNED_WORDS}\n"
        "\nFORMATTING RULES — follow these exactly:\n"
        "1. Output ONLY the cover letter in Markdown format, nothing else.\n"
        "2. 300–400 words (3–4 paragraphs).\n"
        "3. Start with # Name, contact on one line via ` | `.\n"
        "4. The exact date given below (DATE TO USE) on its own line, formatted like 'January 1, 2025'. "
        "Never invent or guess a different date.\n"
        "5. Opening: hook, mention role/company, state fit.\n"
        "6. Body (1–2 paras): highlight relevant experience with specific examples.\n"
        "7. Closing: enthusiasm, call to action, thanks.\n"
        "8. End with 'Sincerely,' followed by name.\n"
        "9. No preamble — cover letter text only."
    )

    jd_block = (
        f"JOB DESCRIPTION:\n{job_description}\n\n" if job_description.strip()
        else "JOB DESCRIPTION:\nNone provided. Write a general-purpose cover letter.\n\n"
    )

    usr_prompt = (
        f"DATE TO USE: {date.today().strftime('%B %-d, %Y')}\n\n" +
        jd_block +
        f"CANDIDATE RESUME:\n{resume_text}\n\n"
        "Generate the complete cover letter in Markdown format. "
        "Keep it concise, professional, and compelling."
    )

    try:
        raw = llm_call(user_prompt=usr_prompt, system_prompt=sys_prompt,
                       provider=provider, local_endpoint=local_endpoint,
                       model=model, max_tokens=2048, api_key=api_key)
        return raw.strip()
    except Exception as e:
        print(f"cover letter generation failed: {e}")
        return f"Cover letter generation failed: {e}"
