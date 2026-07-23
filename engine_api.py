import logging
import os
import json
import base64
import io
from flask import Flask, request, jsonify, send_file
from werkzeug.exceptions import HTTPException
from dotenv import load_dotenv, dotenv_values

logging.basicConfig(level=logging.INFO)

_ENV_PATH = os.environ.get(
    "LOCAL_ENV_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"),
)

def _load_env():
    load_dotenv(_ENV_PATH)
    for name, value in dotenv_values(_ENV_PATH).items():
        if value and not os.environ.get(name):
            os.environ[name] = value


_load_env()

from parser import parse_file, ParsedResume
from analyser import analyse, gen_cv, gen_cover_letter
from router import _is_key_placeholder
from document_export import generate_docx, generate_pdf
from pdf_highlight import highlight_pdf
import job_scraper
import feedback

app = Flask(__name__)

# 25MB file limit plus base64/json overhead, reject oversized bodies before buffering
app.config["MAX_CONTENT_LENGTH"] = 40 * 1024 * 1024


@app.errorhandler(HTTPException)
def _handle_http_exception(e: HTTPException):
    return jsonify({"error": e.description or e.name}), e.code


@app.errorhandler(Exception)
def _handle_unexpected_exception(e: Exception):
    app.logger.exception("unhandled engine error")
    return jsonify({"error": "Internal server error. Please try again."}), 500


def _get_json_body() -> dict:
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return {}
    return data


def _resume_from_json(data: dict) -> ParsedResume:
    r = ParsedResume()
    r.raw_text = data.get("raw_text", "")
    r.contact = data.get("contact", {})
    r.sections = data.get("sections", {})
    r.warnings = data.get("warnings", [])
    r.ocr_used = data.get("ocr_used", False)
    return r


def _resume_to_dict(r: ParsedResume) -> dict:
    return {
        "raw_text": r.raw_text,
        "contact": r.contact,
        "sections": r.sections,
        "warnings": r.warnings,
        "ocr_used": r.ocr_used,
    }


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/parse", methods=["POST"])
def parse_endpoint():
    data = _get_json_body()
    file_b64 = data.get("file", "")
    filename = data.get("filename", "resume.pdf")

    try:
        raw = base64.b64decode(file_b64, validate=True)
    except Exception:
        return jsonify({"error": "The uploaded file could not be decoded."}), 400
    if len(raw) > 25 * 1024 * 1024:
        return jsonify({"error": "Resume files must be 25 MB or smaller."}), 413
    parsed = parse_file(raw, filename)
    return jsonify(_resume_to_dict(parsed))


@app.route("/analyse", methods=["POST"])
def analyse_endpoint():
    data = _get_json_body()
    resume = _resume_from_json(data.get("resume_json", {}))
    jd = data.get("job_description", "")
    provider = data.get("provider", "gemini")
    model = data.get("model", "")
    use_critic = data.get("use_critic", False)
    local_endpoint = data.get("local_endpoint", "")
    api_key = data.get("api_key", "")

    results = analyse(
        resume=resume,
        job_description=jd,
        provider=provider,
        local_endpoint=local_endpoint,
        use_critic=use_critic,
        model=model,
        api_key=api_key,
    )
    results.pop("parsed_resume_obj", None)
    return jsonify(results)


@app.route("/gen-cv", methods=["POST"])
def gen_cv_endpoint():
    data = _get_json_body()
    resume = _resume_from_json(data.get("resume_json", {}))
    jd = data.get("job_description", "")
    acc_map = data.get("acc_map", {})
    provider = data.get("provider", "gemini")
    model = data.get("model", "")
    local_endpoint = data.get("local_endpoint", "")
    api_key = data.get("api_key", "")
    suggestions = data.get("rewrite_suggestions", None)
    decisions = data.get("rewrite_decisions", None)
    mentor_overrides = data.get("mentor_overrides", None)
    section_overrides = data.get("section_overrides", None)

    cv_text = gen_cv(
        resume, jd, acc_map, provider, local_endpoint,
        rewrite_suggestions=suggestions,
        rewrite_decisions=decisions,
        model=model,
        api_key=api_key,
        mentor_overrides=mentor_overrides,
        section_overrides=section_overrides,
    )
    return jsonify({"cv_text": cv_text})


@app.route("/gen-cover-letter", methods=["POST"])
def gen_cover_letter_endpoint():
    data = _get_json_body()
    resume = _resume_from_json(data.get("resume_json", {}))
    jd = data.get("job_description", "")
    provider = data.get("provider", "gemini")
    model = data.get("model", "")
    local_endpoint = data.get("local_endpoint", "")
    api_key = data.get("api_key", "")

    cl_text = gen_cover_letter(resume, jd, provider, local_endpoint, model=model, api_key=api_key)
    return jsonify({"cover_letter_text": cl_text})


@app.route("/export-docx", methods=["POST"])
def export_docx_endpoint():
    text = _get_json_body().get("text", "")
    try:
        data = generate_docx(text)
        return send_file(
            io.BytesIO(data),
            mimetype="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            as_attachment=True,
            download_name="ragstoriches_document.docx",
        )
    except Exception as e:
        return jsonify({"error": f"DOCX export failed: {e}"}), 400


@app.route("/export-pdf", methods=["POST"])
def export_pdf_endpoint():
    text = _get_json_body().get("text", "")
    try:
        data = generate_pdf(text)
        return send_file(
            io.BytesIO(data),
            mimetype="application/pdf",
            as_attachment=True,
            download_name="ragstoriches_document.pdf",
        )
    except Exception as e:
        return jsonify({"error": f"PDF export failed: {e}"}), 400


@app.route("/highlight-pdf", methods=["POST"])
def highlight_pdf_endpoint():
    data = _get_json_body()
    try:
        raw = base64.b64decode(data.get("file", ""), validate=True)
        rendered, active_page = highlight_pdf(raw, data.get("items", []), data.get("active_key", ""))
        response = send_file(io.BytesIO(rendered), mimetype="application/pdf")
        response.headers["X-Active-Page"] = str(active_page or "")
        return response
    except Exception as e:
        return jsonify({"error": f"PDF highlighting failed: {e}"}), 400


@app.route("/scrape-jd", methods=["POST"])
def scrape_jd_endpoint():
    data = _get_json_body()
    url = data.get("url", "")
    text = job_scraper.scrape_jd(url)
    return jsonify({"text": text})


@app.route("/scrape-linkedin", methods=["POST"])
def scrape_linkedin_endpoint():
    data = _get_json_body()
    url = data.get("url", "")
    profile = job_scraper.scrape_linkedin_profile(url)
    return jsonify({"profile": profile})


@app.route("/compare-resume-jd", methods=["POST"])
def compare_endpoint():
    data = _get_json_body()
    resume_text = data.get("resume_text", "")
    jd_text = data.get("jd_text", "")
    provider = data.get("provider", "gemini")
    model = data.get("model", "")
    local_endpoint = data.get("local_endpoint", "")
    api_key = data.get("api_key", "")

    result = job_scraper.compare_resume_jd(resume_text, jd_text, provider, local_endpoint, model=model, api_key=api_key)
    return jsonify(result)


@app.route("/env-status", methods=["GET"])
def env_status():
    # per-user byok keys live encrypted in the express db now, this is just the pooled secrets.
    # groq is kept reported here even though "default" no longer resolves to it - the provider
    # itself still works, just isn't wired up as the pooled tier anymore
    _load_env()
    groq_key = os.environ.get("GROQ_API_KEY", "")
    openrouter_key = os.environ.get("OPENROUTER_API_KEY", "")
    li_id = os.environ.get("LINKEDIN_CLIENT_ID", "")
    li_secret = os.environ.get("LINKEDIN_CLIENT_SECRET", "")
    return jsonify({
        "groq": bool(groq_key) and not _is_key_placeholder(groq_key),
        "openrouter": bool(openrouter_key) and not _is_key_placeholder(openrouter_key),
        "linkedin": bool(li_id) and not _is_key_placeholder(li_id) and bool(li_secret) and not _is_key_placeholder(li_secret),
    })


@app.route("/feedback-status", methods=["GET"])
def feedback_status():
    return jsonify({"silenced": feedback.is_feedback_silenced()})


@app.route("/silence-feedback", methods=["POST"])
def silence_feedback_endpoint():
    feedback.silence_feedback()
    return jsonify({"ok": True})


@app.route("/forms-url", methods=["GET"])
def forms_url():
    return jsonify({"url": feedback.get_forms_url()})


if __name__ == "__main__":
    port = int(os.environ.get("ENGINE_PORT", 5001))
    app.run(host="0.0.0.0", port=port, debug=False)
