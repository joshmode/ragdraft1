import os
import random
import time
import threading
import requests


_PLACEHOLDER_VALS = {
    "your_key", "changeme", "change_me", "xxx", "sk-xxx",
    "put_your_key_here", "replace_me", "your_api_key",
    "insert_key_here", "placeholder",
}

# "default" resolves to groq server-side before it ever reaches here
_PROVIDER_LIMITS = {
    "gemini": int(os.environ.get("GEMINI_MAX_CONCURRENCY", "4")),
    "claude": int(os.environ.get("CLAUDE_MAX_CONCURRENCY", "3")),
    "chatgpt": int(os.environ.get("OPENAI_MAX_CONCURRENCY", "4")),
    "groq": int(os.environ.get("GROQ_MAX_CONCURRENCY", "6")),
    "local": int(os.environ.get("LOCAL_MAX_CONCURRENCY", "2")),
}
_PROVIDER_LOCKS = {
    provider: threading.BoundedSemaphore(max(limit, 1))
    for provider, limit in _PROVIDER_LIMITS.items()
}

# env-overridable since exact model IDs drift, check these against current provider docs
_DEFAULT_MODELS = {
    "gemini":  os.environ.get("GEMINI_DEFAULT_MODEL", "gemini-3.5-flash"),
    "claude":  os.environ.get("CLAUDE_DEFAULT_MODEL", "claude-4-5-sonnet-latest"),
    "chatgpt": os.environ.get("OPENAI_DEFAULT_MODEL", "gpt-4o"),
    "groq":    os.environ.get("GROQ_DEFAULT_MODEL", "llama-3.3-70b-versatile"),
    "local":   os.environ.get("LOCAL_DEFAULT_MODEL", "llama3"),
}


def _is_key_placeholder(value: str) -> bool:
    cleaned = (value or "").strip()
    if len(cleaned) < 8:
        return True
    lowered = cleaned.lower()
    if lowered in _PLACEHOLDER_VALS:
        return True
    return (
        "your" in lowered and "key" in lowered
        or "replace" in lowered and "key" in lowered
        or lowered.startswith("<") and lowered.endswith(">")
    )


def _default_local_endpoint() -> str:
    if os.path.exists("/.dockerenv") or os.environ.get("DOCKER_CONTAINER"):
        return "http://host.docker.internal:11434/api/chat"
    return "http://localhost:11434/api/chat"


def _resolve_key(provider: str, env_var: str, api_key: str) -> str:
    """caller-supplied key wins over the pooled env var, keeps concurrent users isolated"""
    key = (api_key or "").strip() or os.environ.get(env_var, "")
    if not key or _is_key_placeholder(key):
        raise EnvironmentError(f"No {provider} API key available. Add your own key, or use Default (Free).")
    return key


def llm_call(
    user_prompt: str,
    system_prompt: str = "",
    provider: str = "gemini",
    model: str = "",
    max_tokens: int = 1024,
    local_endpoint: str = "",
    max_retries: int = 5,
    timeout: int = 120,
    api_key: str = "",
) -> str:
    """routes prompt to chosen llm. api_key, if given, is used only for this one call - never touches os.environ"""
    provider = provider.lower()
    last_err = None

    if not local_endpoint:
        local_endpoint = _default_local_endpoint()

    if provider not in _PROVIDER_LOCKS:
        raise ValueError(f"Unsupported LLM provider: {provider}")

    for attempt in range(max_retries):
        try:
            with _PROVIDER_LOCKS[provider]:
                if provider == "gemini":
                    from google import genai
                    from google.genai import types

                    key = _resolve_key("Gemini", "GEMINI_API_KEY", api_key)
                    client = genai.Client(
                        api_key=key,
                        http_options=types.HttpOptions(timeout=timeout * 1000),
                    )
                    mdl = model or _DEFAULT_MODELS["gemini"]

                    cfg_kw = {"max_output_tokens": max_tokens}
                    if system_prompt: cfg_kw["system_instruction"] = system_prompt

                    if "gemma" not in mdl.lower():
                        cfg_kw["safety_settings"] = [
                            types.SafetySetting(category="HARM_CATEGORY_HARASSMENT", threshold="BLOCK_ONLY_HIGH"),
                            types.SafetySetting(category="HARM_CATEGORY_HATE_SPEECH", threshold="BLOCK_ONLY_HIGH"),
                            types.SafetySetting(category="HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold="BLOCK_ONLY_HIGH"),
                            types.SafetySetting(category="HARM_CATEGORY_DANGEROUS_CONTENT", threshold="BLOCK_ONLY_HIGH"),
                        ]
                        if "json" in system_prompt.lower() or "json" in user_prompt.lower():
                            cfg_kw["response_mime_type"] = "application/json"

                    cfg = types.GenerateContentConfig(**cfg_kw)
                    resp = client.models.generate_content(model=mdl, contents=user_prompt, config=cfg)
                    if resp.text is None: raise ValueError("API returned None (safety block).")
                    return resp.text

                elif provider == "claude":
                    import anthropic
                    key = _resolve_key("Claude", "ANTHROPIC_API_KEY", api_key)
                    mdl = model or _DEFAULT_MODELS["claude"]
                    client = anthropic.Anthropic(api_key=key, timeout=timeout)
                    msg = client.messages.create(
                        model=mdl,
                        max_tokens=max_tokens,
                        system=system_prompt,
                        messages=[{"role": "user", "content": user_prompt}]
                    )
                    if msg.content[0].text is None: raise ValueError("Claude returned None.")
                    return msg.content[0].text

                elif provider == "chatgpt":
                    import openai
                    key = _resolve_key("ChatGPT", "OPENAI_API_KEY", api_key)
                    mdl = model or _DEFAULT_MODELS["chatgpt"]
                    client = openai.OpenAI(api_key=key, timeout=timeout)
                    res = client.chat.completions.create(
                        model=mdl,
                        max_tokens=max_tokens,
                        messages=[
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_prompt}
                        ]
                    )
                    if res.choices[0].message.content is None: raise ValueError("ChatGPT returned None.")
                    return res.choices[0].message.content

                elif provider == "groq":
                    # groq's api is openai-compatible, reuse the sdk with a different base_url
                    import openai
                    key = _resolve_key("Groq", "GROQ_API_KEY", api_key)
                    mdl = model or _DEFAULT_MODELS["groq"]
                    client = openai.OpenAI(api_key=key, base_url="https://api.groq.com/openai/v1", timeout=timeout)
                    res = client.chat.completions.create(
                        model=mdl,
                        max_tokens=max_tokens,
                        messages=[
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_prompt}
                        ]
                    )
                    if res.choices[0].message.content is None: raise ValueError("Groq returned None.")
                    return res.choices[0].message.content

                elif provider == "local":
                    mdl = model or _DEFAULT_MODELS["local"]
                    payload = {
                        "model": mdl,
                        "messages": [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
                        "stream": False,
                        "options": {"num_predict": max_tokens}
                    }
                    res = requests.post(local_endpoint, json=payload, timeout=timeout)
                    res.raise_for_status()
                    content = res.json().get("message", {}).get("content")
                    if content is None: raise ValueError("Local model returned None.")
                    return content


        except Exception as e:
            last_err = e
            err_str = str(e).lower()
            if attempt < max_retries - 1:
                # jitter spreads concurrent retries out so they don't all re-trip the limit together
                if any(x in err_str for x in ["429", "too many requests", "quota"]):
                    time.sleep(min(60, 4 * (2 ** attempt)) + random.uniform(0, 1))
                    continue
                elif any(x in err_str for x in ["500", "503", "unavailable", "timeout", "internal error", "name resolution", "errno -3", "connection"]):
                    time.sleep(min(30, 2 ** (attempt + 1)) + random.uniform(0, 1))
                    continue
                elif "none" in err_str and attempt == 0:
                    time.sleep(2 + random.uniform(0, 1))
                    continue
            break

    raise last_err
