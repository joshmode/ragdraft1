import io


def _search_phrases(text: str) -> list[str]:
    cleaned = " ".join(text.split())
    words = cleaned.split()
    phrases = [cleaned]
    if len(words) > 18:
        phrases.append(" ".join(words[:18]))
    if len(words) > 10:
        phrases.extend([" ".join(words[:10]), " ".join(words[-10:])])
    return [phrase for phrase in phrases if len(phrase) >= 20]


def _color(severity: str, active: bool) -> tuple[float, float, float]:
    if active:
        return (0.04, 0.45, 0.28)
    if severity == "red":
        return (0.86, 0.24, 0.18)
    if severity == "green":
        return (0.10, 0.58, 0.33)
    return (0.92, 0.62, 0.05)


def highlight_pdf(pdf_bytes: bytes, items: list[dict], active_key: str = "") -> tuple[bytes, int | None]:
    import fitz

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        active_page = None
        for number, item in enumerate(items, start=1):
            item_id = str(item.get("id", ""))
            text = str(item.get("text", ""))
            severity = str(item.get("severity", "yellow"))
            is_active = item_id == active_key
            found = False
            for phrase in _search_phrases(text):
                if found:
                    break
                for page_index, page in enumerate(doc):
                    matches = page.search_for(phrase, quads=True)
                    if not matches:
                        continue
                    for quad in matches[:3]:
                        annotation = page.add_highlight_annot(quad)
                        annotation.set_colors(stroke=_color(severity, is_active))
                        annotation.set_info(
                            content=f"[#{number}] Suggested rewrite:\n{item.get('rewritten', '')}\n\nWhy: {item.get('reasoning', '')}",
                            title="RAGsToRiches",
                        )
                        annotation.update(opacity=0.55 if is_active else 0.28)
                    if is_active:
                        active_page = page_index + 1
                    found = True
                    break

        output = io.BytesIO()
        doc.save(output, garbage=4, deflate=True)
        return output.getvalue(), active_page
    finally:
        doc.close()
