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


def _extract_jd_from_html(html_text: str) -> str:
    if not BS4_AVAILABLE:
        text = re.sub(r'<[^>]+>', ' ', html_text)
        return re.sub(r'\s+', ' ', text).strip()

    soup = BeautifulSoup(html_text, "html.parser")

    for sel in _JD_SELECTORS:
        el = soup.select_one(sel)
        if el and len(el.get_text(strip=True)) > 100:
            return el.get_text("\n", strip=True)

    for tag in soup(["script", "style", "nav", "header", "footer"]):
        tag.decompose()

    main = soup.find("main") or soup.find("body") or soup
    return main.get_text("\n", strip=True)[:5000]


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


def scrape_linkedin_profile(url: str) -> dict:
    if not _safe_public_url(url):
        return {"error": "Only public HTTPS profile URLs are supported."}
    if not PLAYWRIGHT_AVAILABLE:
        return {"error": "Playwright is required for LinkedIn scraping. Run: pip install playwright && playwright install chromium"}

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=20000)
            page.wait_for_timeout(4000)

            profile = {"name": "", "headline": "", "summary": "", "experience": [], "education": [], "skills": []}

            try:
                profile["name"] = page.locator("h1").first.inner_text(timeout=3000)
            except Exception:
                pass

            try:
                profile["headline"] = page.locator(".text-body-medium").first.inner_text(timeout=3000)
            except Exception:
                pass

            try:
                summary_el = page.locator("[data-section='summary']").first
                profile["summary"] = summary_el.inner_text(timeout=3000)
            except Exception:
                pass

            browser.close()
            return profile
    except Exception as e:
        return {"error": f"LinkedIn scraping failed: {e}"}


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
