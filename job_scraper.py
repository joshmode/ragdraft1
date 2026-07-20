import re
import ipaddress
import socket
from urllib.parse import urlparse
import requests

try:
    from bs4 import BeautifulSoup
    BS4_AVAILABLE = True
except ImportError:
    BS4_AVAILABLE = False

try:
    from playwright.sync_api import sync_playwright
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False

from router import llm_call


_JD_SELECTORS = [
    ".job-description",
    "[data-testid='jobDescriptionText']",
    ".description__text",
    ".jobsearch-JobComponent-description",
    ".show-more-less-html__markup",
    ".jobs-description__content",
    "article",
    ".posting-details",
    ".job-details",
    "#job-details",
    ".job_description",
]

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


def _safe_public_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
        if parsed.scheme != "https" or not parsed.hostname:
            return False
        addresses = socket.getaddrinfo(parsed.hostname, None)
        for entry in addresses:
            addr = ipaddress.ip_address(entry[4][0])
            if addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved or addr.is_multicast:
                return False
        return True
    except Exception:
        return False


_JD_HEADER_RE = re.compile(
    r'^(about|responsibilities|requirements|qualifications|what you.ll do|'
    r'what we.re looking for|who you are|benefits|perks|nice to have|'
    r'preferred|minimum|required skills|role|the role|your (role|impact|team)|'
    r'compensation|salary|what we offer|why join|our (team|culture|mission))\b',
    re.IGNORECASE,
)


def _element_to_text(el) -> str:
    """walk an element and emit structured text: list items become bullets,
    headings/bold-only lines become spaced section headers, paragraphs stay
    separated — instead of the flat line soup get_text() produces."""
    parts: list[str] = []

    def is_header_text(text: str) -> bool:
        words = text.split()
        if len(words) > 8 or re.search(r'[.!?]\s*$', text):
            return False
        if text.endswith(":") and len(words) <= 4:
            return True
        return bool(_JD_HEADER_RE.match(text) and len(words) <= 5) or text.rstrip(":").isupper()

    def walk(node):
        name = getattr(node, "name", None)
        if name is None:
            return
        if name in ("script", "style", "nav", "noscript"):
            return
        if name == "li":
            text = " ".join(node.get_text(" ", strip=True).split())
            if text:
                parts.append(f"- {text}")
            return
        if name in ("h1", "h2", "h3", "h4", "h5", "h6"):
            text = " ".join(node.get_text(" ", strip=True).split())
            if text:
                parts.append("")
                parts.append(text.upper() if len(text) < 60 else text)
                parts.append("")
            return
        if name in ("p", "div", "section", "span", "strong", "b"):
            children = [c for c in node.children if getattr(c, "name", None) in
                        ("p", "div", "ul", "ol", "li", "section", "h1", "h2", "h3", "h4", "h5", "h6", "br", "strong", "b", "span")]
            if not children or all(getattr(c, "name", None) in ("br", "strong", "b", "span") for c in children):
                text = " ".join(node.get_text(" ", strip=True).split())
                if text:
                    if is_header_text(text):
                        parts.append("")
                        parts.append(text.rstrip(":").upper() if len(text) < 60 else text)
                        parts.append("")
                    else:
                        parts.append(text)
                return
        for child in getattr(node, "children", []):
            walk(child)

    walk(el)

    # collapse duplicate consecutive lines and 3+ blank runs
    out: list[str] = []
    for line in parts:
        if line == "" and out and out[-1] == "":
            continue
        if line and out and out[-1] == line:
            continue
        out.append(line)
    return "\n".join(out).strip()


def _extract_jd_from_html(html_text: str) -> str:
    if not BS4_AVAILABLE:
        text = re.sub(r'<[^>]+>', ' ', html_text)
        return re.sub(r'\s+', ' ', text).strip()

    soup = BeautifulSoup(html_text, "html.parser")

    for sel in _JD_SELECTORS:
        el = soup.select_one(sel)
        if el and len(el.get_text(strip=True)) > 100:
            return _element_to_text(el)

    for tag in soup(["script", "style", "nav", "header", "footer"]):
        tag.decompose()

    main = soup.find("main") or soup.find("body") or soup
    return _element_to_text(main)[:8000]


def scrape_jd(url: str) -> str:
    if not _safe_public_url(url):
        return "Only public HTTPS job-description URLs are supported."
    try:
        resp = requests.get(url, headers=_HEADERS, timeout=15)
        resp.raise_for_status()
        text = _extract_jd_from_html(resp.text)
        if len(text) > 200:
            return text
    except Exception:
        pass

    if PLAYWRIGHT_AVAILABLE:
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                page = browser.new_page()
                page.goto(url, wait_until="domcontentloaded", timeout=20000)
                page.wait_for_timeout(3000)
                html_text = page.content()
                browser.close()
                text = _extract_jd_from_html(html_text)
                if len(text) > 200:
                    return text
        except Exception as e:
            return f"Failed to scrape job description: {e}"

    return "Could not extract job description from this URL. Try pasting the description manually."


_LINKEDIN_ZIP_HINT = (
    "LinkedIn requires sign-in to view profiles, so public URL scraping is blocked by "
    "LinkedIn itself. Instead, download your data export from LinkedIn "
    "(Settings → Data privacy → Get a copy of your data → choose the ZIP archive) and "
    "upload that ZIP through the main resume upload box — it imports your positions, "
    "education, and skills directly."
)


def _looks_like_authwall(html_text: str, final_url: str = "") -> bool:
    lowered = (final_url or "").lower()
    if "authwall" in lowered or "/login" in lowered or "signup" in lowered:
        return True
    sample = html_text[:20000].lower()
    return "authwall" in sample or "join linkedin" in sample or "sign in to view" in sample


def _profile_from_meta(html_text: str) -> dict | None:
    """public LinkedIn pages served to crawlers expose name/headline via og: meta
    tags even when the full page is behind the authwall."""
    if not BS4_AVAILABLE:
        return None
    soup = BeautifulSoup(html_text, "html.parser")
    title = soup.find("meta", property="og:title")
    desc = soup.find("meta", property="og:description")
    name = (title.get("content", "") if title else "").split(" - ")[0].split(" | ")[0].strip()
    headline = (desc.get("content", "") if desc else "").strip()
    if not name:
        return None
    return {"name": name, "headline": headline, "summary": "", "experience": [], "education": [], "skills": [],
            "note": "Only the public preview (name and headline) is available without signing in. " + _LINKEDIN_ZIP_HINT}


def scrape_linkedin_profile(url: str) -> dict:
    if not _safe_public_url(url):
        return {"error": "Only public HTTPS profile URLs are supported."}
    if "linkedin.com/in/" not in url.lower():
        return {"error": "That doesn't look like a LinkedIn profile URL (expected linkedin.com/in/...)."}

    # try the plain request first — LinkedIn serves crawler-visible og: meta
    # tags for public profiles, which is the most reliable anonymous signal.
    html_text = ""
    try:
        resp = requests.get(url, headers=_HEADERS, timeout=15, allow_redirects=True)
        html_text = resp.text
        if not _looks_like_authwall(html_text, str(resp.url)):
            meta = _profile_from_meta(html_text)
            if meta:
                return meta
    except Exception:
        pass

    if PLAYWRIGHT_AVAILABLE:
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                page = browser.new_page()
                page.goto(url, wait_until="domcontentloaded", timeout=20000)
                page.wait_for_timeout(3000)
                content = page.content()
                final_url = page.url
                browser.close()
                if not _looks_like_authwall(content, final_url):
                    meta = _profile_from_meta(content)
                    if meta:
                        return meta
        except Exception:
            pass

    # if we got any meta at all (even behind the authwall LinkedIn often
    # still includes og: tags), surface it rather than a bare failure.
    if html_text:
        meta = _profile_from_meta(html_text)
        if meta:
            return meta

    return {"error": _LINKEDIN_ZIP_HINT}


def linkedin_oauth_url(client_id: str, redirect_uri: str) -> str:
    return (
        f"https://www.linkedin.com/oauth/v2/authorization?"
        f"response_type=code&client_id={client_id}&redirect_uri={redirect_uri}"
        f"&scope=openid%20profile%20email"
    )


def exchange_linkedin_code(code: str, client_id: str, client_secret: str, redirect_uri: str) -> dict:
    try:
        resp = requests.post(
            "https://www.linkedin.com/oauth/v2/accessToken",
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "client_id": client_id,
                "client_secret": client_secret,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        return {"error": str(e)}


def fetch_linkedin_profile(access_token: str) -> dict:
    try:
        resp = requests.get(
            "https://api.linkedin.com/v2/userinfo",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Linkedin-Version": "202602",
            },
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        return {"error": str(e)}


def compare_resume_jd(resume_text: str, jd_text: str, provider: str, local_endpoint: str, model: str = "") -> dict:
    sys_prompt = (
        "You are a resume-to-job-description matching expert. "
        "Compare the candidate's resume against the job description. "
        "Return ONLY valid JSON with this structure:\n"
        '{"match_pct": 72, "missing_skills": ["skill1", "skill2"], '
        '"strong_matches": ["skill1", "skill2"], '
        '"tailoring_tips": ["tip1", "tip2"], '
        '"company": "Company Name if detectable"}'
    )

    usr_prompt = (
        f"JOB DESCRIPTION:\n{jd_text[:3000]}\n\n"
        f"RESUME:\n{resume_text[:3000]}\n\n"
        "Analyse how well this resume matches the job description."
    )

    try:
        import json
        raw = llm_call(user_prompt=usr_prompt, system_prompt=sys_prompt,
                       provider=provider, local_endpoint=local_endpoint,
                       model=model, max_tokens=1024)
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            lines = cleaned.splitlines()
            if lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].startswith("```"):
                lines = lines[:-1]
            cleaned = "\n".join(lines).strip()
        match = re.search(r'(\{.*\})', cleaned, re.DOTALL)
        if match:
            cleaned = match.group(1)
        return json.loads(cleaned)
    except Exception as e:
        return {"match_pct": 0, "missing_skills": [], "strong_matches": [],
                "tailoring_tips": [], "error": str(e)}
