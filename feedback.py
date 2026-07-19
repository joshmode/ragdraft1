import os
import json

_PREFS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "prefs.json")
_GOOGLE_FORMS_URL = "https://forms.gle/YOUR_FORM_ID_HERE"


def _load_prefs() -> dict:
    try:
        if os.path.exists(_PREFS_PATH):
            with open(_PREFS_PATH, "r") as f:
                return json.load(f)
    except Exception:
        pass
    return {}


def _save_prefs(prefs: dict) -> None:
    try:
        os.makedirs(os.path.dirname(_PREFS_PATH), exist_ok=True)
        with open(_PREFS_PATH, "w") as f:
            json.dump(prefs, f)
    except Exception:
        pass


def is_feedback_silenced() -> bool:
    prefs = _load_prefs()
    return prefs.get("feedback_silenced", False)


def silence_feedback() -> None:
    prefs = _load_prefs()
    prefs["feedback_silenced"] = True
    _save_prefs(prefs)


def get_forms_url() -> str:
    return _GOOGLE_FORMS_URL
