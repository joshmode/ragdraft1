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

# reject oversized request bodies before they're fully buffered/parsed —
# 25MB file limit plus base64 (~33%) and JSON framing overhead.
app.config["MAX_CONTENT_LENGTH"] = 40 * 1024 * 1024

_KEY_NAMES = {"gemini": "GEMINI_API_KEY", "claude": "ANTHROPIC_API_KEY", "chatgpt": "OPENAI_API_KEY"}


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

    results = analyse(
        resume=resume,
        job_description=jd,
        provider=provider,
        local_endpoint=local_endpoint,
        use_critic=use_critic,
        model=model,
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
    suggestions = data.get("rewrite_suggestions", None)
    decisions = data.get("rewrite_decisions", None)

    cv_text = gen_cv(
        resume, jd, acc_map, provider, local_endpoint,
        rewrite_suggestions=suggestions,
        rewrite_decisions=decisions,
        model=model,
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

    cl_text = gen_cover_letter(resume, jd, provider, local_endpoint, model=model)
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

    result = job_scraper.compare_resume_jd(resume_text, jd_text, provider, local_endpoint, model=model)
    return jsonify(result)


@app.route("/env-status", methods=["GET"])
def env_status():
    _load_env()
    status = {}
    for display, env_var in _KEY_NAMES.items():
        val = os.environ.get(env_var, "")
        status[display] = bool(val) and not _is_key_placeholder(val)

    li_id = os.environ.get("LINKEDIN_CLIENT_ID", "")
    li_secret = os.environ.get("LINKEDIN_CLIENT_SECRET", "")
    status["linkedin"] = bool(li_id) and not _is_key_placeholder(li_id) and bool(li_secret) and not _is_key_placeholder(li_secret)
    return jsonify(status)


@app.route("/save-api-key", methods=["POST"])
def save_api_key():
    if os.environ.get("ALLOW_LOCAL_KEY_WRITE", "true").lower() != "true":
        return jsonify({"ok": False, "error": "Local API key storage is disabled."}), 403

    data = _get_json_body()
    provider = data.get("provider", "")
    key = data.get("key", "").strip()

    env_var = _KEY_NAMES.get(provider)
    if not env_var:
        return jsonify({"ok": False, "error": "Unknown provider"}), 400
    if not key:
        return jsonify({"ok": False, "error": "Key cannot be empty"}), 400
    if "\n" in key or "\r" in key:
        return jsonify({"ok": False, "error": "Key contains invalid characters"}), 400

    lines = []
    key_found = False
    if os.path.exists(_ENV_PATH):
        with open(_ENV_PATH, "r") as f:
            lines = f.readlines()

    new_lines = []
    for line in lines:
        if line.strip().startswith(f"{env_var}="):
            new_lines.append(f"{env_var}={key}\n")
            key_found = True
        else:
            new_lines.append(line)
    if not key_found:
        new_lines.append(f"\n{env_var}={key}\n")

    with open(_ENV_PATH, "w") as f:
        f.writelines(new_lines)

    load_dotenv(_ENV_PATH, override=True)
    return jsonify({"ok": True})


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
