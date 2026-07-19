import html
import json
import streamlit as st

try:
    import altair as alt
    import pandas as pd
    ALTAIR_AVAILABLE = True
except ImportError:
    ALTAIR_AVAILABLE = False

from db import (
    get_mentor_candidates, get_candidate_analyses, get_mentor_sessions,
    create_session_code, get_session_participants, get_annotations,
)


def _candidate_summary(candidate: dict) -> dict:
    analyses = get_candidate_analyses(candidate["id"])
    scores = [a["score"] for a in analyses]
    return {
        "id": candidate["id"],
        "name": candidate["display_name"],
        "username": candidate["username"],
        "total_analyses": len(analyses),
        "latest_score": scores[0] if scores else 0,
        "best_score": max(scores) if scores else 0,
        "scores": scores,
    }


def render_mentor_dashboard(user_id: int) -> None:
    st.markdown('<span class="section-label">Mentor Dashboard</span>', unsafe_allow_html=True)

    sess_col, code_col = st.columns([2, 1])
    with sess_col:
        sessions = get_mentor_sessions(user_id)
        if sessions:
            active = [s for s in sessions if s["active"]]
            st.markdown(
                f'<div class="card"><span class="section-label">Active Sessions</span>'
                f'<p style="font-size:0.85rem;color:#6B7280;">{len(active)} active review session{"s" if len(active) != 1 else ""}</p></div>',
                unsafe_allow_html=True,
            )
            for s in active:
                participants = get_session_participants(s["code"])
                names = ", ".join(p["display_name"] for p in participants) or "No participants yet"
                st.markdown(
                    f'<div class="card" style="padding:0.75rem 1rem;">'
                    f'<span style="font-family:monospace;font-size:1.1rem;font-weight:700;color:#8b5cf6;">{s["code"]}</span>'
                    f'<span style="font-size:0.78rem;color:#6B7280;margin-left:1rem;">{names}</span>'
                    f'</div>',
                    unsafe_allow_html=True,
                )
        else:
            st.markdown(
                '<p style="color:#6B7280;font-size:0.85rem;">No review sessions yet. Create one to start collaborating.</p>',
                unsafe_allow_html=True,
            )
    with code_col:
        if st.button("Create Review Session", use_container_width=True):
            code = create_session_code(user_id)
            st.success(f"Session created! Share this code with your candidates: **{code}**")
            st.rerun()

    st.markdown('<hr class="slim-divider">', unsafe_allow_html=True)

    candidates = get_mentor_candidates(user_id)
    if not candidates:
        st.info("No candidates have joined your review sessions yet. Share a session code to get started.")
        return

    summaries = [_candidate_summary(c) for c in candidates]

    st.markdown('<span class="section-label">Candidate Comparison</span>', unsafe_allow_html=True)

    header = '<div class="card"><table style="width:100%;border-collapse:collapse;font-size:0.84rem;">'
    header += '<tr style="border-bottom:1px solid #E8EAED;">'
    header += '<th style="text-align:left;padding:0.5rem;">Candidate</th>'
    header += '<th style="text-align:center;padding:0.5rem;">Analyses</th>'
    header += '<th style="text-align:center;padding:0.5rem;">Latest Score</th>'
    header += '<th style="text-align:center;padding:0.5rem;">Best Score</th>'
    header += '</tr>'
    for s in summaries:
        score_color = "#15C39A" if s["latest_score"] >= 70 else "#E8A735" if s["latest_score"] >= 50 else "#E5534B"
        header += f'<tr style="border-bottom:1px solid #F7F8FA;">'
        header += f'<td style="padding:0.5rem;font-weight:600;">{html.escape(s["name"])}</td>'
        header += f'<td style="text-align:center;padding:0.5rem;">{s["total_analyses"]}</td>'
        header += f'<td style="text-align:center;padding:0.5rem;color:{score_color};font-weight:700;">{s["latest_score"]}</td>'
        header += f'<td style="text-align:center;padding:0.5rem;">{s["best_score"]}</td>'
        header += '</tr>'
    header += '</table></div>'
    st.markdown(header, unsafe_allow_html=True)

    if ALTAIR_AVAILABLE and any(len(s["scores"]) > 1 for s in summaries):
        st.markdown('<span class="section-label" style="margin-top:1rem;">Score Progression</span>', unsafe_allow_html=True)
        chart_data = []
        for s in summaries:
            for idx, score in enumerate(reversed(s["scores"])):
                chart_data.append({"Candidate": s["name"], "Attempt": idx + 1, "Score": score})
        if chart_data:
            df = pd.DataFrame(chart_data)
            chart = (
                alt.Chart(df)
                .mark_line(point=alt.OverlayMarkDef(filled=True, size=50), strokeWidth=2)
                .encode(
                    x=alt.X("Attempt:Q", title="Attempt", axis=alt.Axis(tickMinStep=1, format="d")),
                    y=alt.Y("Score:Q", title="Score", scale=alt.Scale(domain=[0, 100])),
                    color=alt.Color("Candidate:N"),
                    tooltip=["Candidate:N", "Attempt:Q", "Score:Q"],
                )
                .properties(height=220)
            )
            st.altair_chart(chart, use_container_width=True)

    for s in summaries:
        with st.expander(f"{s['name']} — {s['total_analyses']} analyses, latest: {s['latest_score']}/100"):
            analyses = get_candidate_analyses(s["id"])
            for a in analyses[:10]:
                st.markdown(
                    f'<div style="font-size:0.82rem;padding:0.3rem 0;border-bottom:1px solid #F7F8FA;">'
                    f'<span style="font-weight:600;">Score: {a["score"]}/100</span>'
                    f'<span style="color:#6B7280;margin-left:1rem;">{a["provider"]} / {a["model"]}</span>'
                    f'<span style="color:#6B7280;margin-left:1rem;">{a["created_at"][:16]}</span>'
                    f'</div>',
                    unsafe_allow_html=True,
                )


def export_mentor_report(user_id: int) -> str:
    candidates = get_mentor_candidates(user_id)
    summaries = [_candidate_summary(c) for c in candidates]

    lines = ["# Mentor Review Report\n"]
    for s in summaries:
        lines.append(f"## {s['name']} (@{s['username']})")
        lines.append(f"- Total analyses: {s['total_analyses']}")
        lines.append(f"- Latest score: {s['latest_score']}/100")
        lines.append(f"- Best score: {s['best_score']}/100")
        if s["scores"]:
            lines.append(f"- Score history: {', '.join(str(x) for x in reversed(s['scores']))}")
        lines.append("")
    return "\n".join(lines)
