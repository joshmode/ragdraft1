import os
import json
from datetime import datetime
from sqlalchemy import create_engine, Column, Integer, String, Text, Boolean, Float, LargeBinary, DateTime, ForeignKey
from sqlalchemy.orm import declarative_base, sessionmaker, relationship

_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "ragstoriches.db")
os.makedirs(os.path.dirname(_DB_PATH), exist_ok=True)

_engine = create_engine(f"sqlite:///{_DB_PATH}", echo=False)
_SessionLocal = sessionmaker(bind=_engine)
Base = declarative_base()


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    username = Column(String(64), unique=True, nullable=False)
    password_hash = Column(String(128), nullable=False)
    display_name = Column(String(128), nullable=False)
    role = Column(String(16), nullable=False, default="candidate")
    email = Column(String(128), default="")
    created_at = Column(DateTime, default=datetime.utcnow)


class Resume(Base):
    __tablename__ = "resumes"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    filename = Column(String(256), default="")
    raw_bytes = Column(LargeBinary, nullable=True)
    parsed_json = Column(Text, default="{}")
    created_at = Column(DateTime, default=datetime.utcnow)


class Analysis(Base):
    __tablename__ = "analyses"
    id = Column(Integer, primary_key=True)
    resume_id = Column(Integer, ForeignKey("resumes.id"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    results_json = Column(Text, default="{}")
    job_description = Column(Text, default="")
    provider = Column(String(32), default="")
    model = Column(String(64), default="")
    score_total = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)


class RewriteDecision(Base):
    __tablename__ = "rewrite_decisions"
    id = Column(Integer, primary_key=True)
    analysis_id = Column(Integer, ForeignKey("analyses.id"), nullable=False)
    suggestion_key = Column(String(128), nullable=False)
    decision = Column(Boolean, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class Annotation(Base):
    __tablename__ = "annotations"
    id = Column(Integer, primary_key=True)
    analysis_id = Column(Integer, ForeignKey("analyses.id"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    suggestion_key = Column(String(128), nullable=False)
    comment = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.utcnow)


class ReviewSession(Base):
    __tablename__ = "review_sessions"
    id = Column(Integer, primary_key=True)
    mentor_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    session_code = Column(String(12), unique=True, nullable=False)
    active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class SessionParticipant(Base):
    __tablename__ = "session_participants"
    id = Column(Integer, primary_key=True)
    session_id = Column(Integer, ForeignKey("review_sessions.id"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    joined_at = Column(DateTime, default=datetime.utcnow)


class RevisionSnapshot(Base):
    __tablename__ = "revision_snapshots"
    id = Column(Integer, primary_key=True)
    resume_id = Column(Integer, ForeignKey("resumes.id"), nullable=False)
    analysis_id = Column(Integer, ForeignKey("analyses.id"), nullable=False)
    decisions_json = Column(Text, default="{}")
    score_total = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)


def init_db():
    Base.metadata.create_all(_engine)


def get_session():
    return _SessionLocal()


def create_user(username: str, password_hash: str, display_name: str, role: str = "candidate", email: str = "") -> User:
    session = get_session()
    try:
        user = User(
            username=username.strip().lower(),
            password_hash=password_hash,
            display_name=display_name.strip(),
            role=role,
            email=email.strip(),
        )
        session.add(user)
        session.commit()
        session.refresh(user)
        return user
    finally:
        session.close()


def get_user_by_username(username: str) -> User | None:
    session = get_session()
    try:
        return session.query(User).filter(User.username == username.strip().lower()).first()
    finally:
        session.close()


def save_resume(user_id: int, filename: str, raw_bytes: bytes, parsed_json: str = "{}") -> Resume:
    session = get_session()
    try:
        resume = Resume(user_id=user_id, filename=filename, raw_bytes=raw_bytes, parsed_json=parsed_json)
        session.add(resume)
        session.commit()
        session.refresh(resume)
        return resume
    finally:
        session.close()


def save_analysis(resume_id: int, user_id: int, results_json: str, job_description: str, provider: str, model: str, score_total: int) -> Analysis:
    session = get_session()
    try:
        analysis = Analysis(
            resume_id=resume_id, user_id=user_id, results_json=results_json,
            job_description=job_description, provider=provider, model=model, score_total=score_total,
        )
        session.add(analysis)
        session.commit()
        session.refresh(analysis)
        return analysis
    finally:
        session.close()


def save_decisions(analysis_id: int, decisions: dict[str, bool]) -> None:
    session = get_session()
    try:
        session.query(RewriteDecision).filter(RewriteDecision.analysis_id == analysis_id).delete()
        for key, val in decisions.items():
            session.add(RewriteDecision(analysis_id=analysis_id, suggestion_key=key, decision=val))
        session.commit()
    finally:
        session.close()


def save_annotation(analysis_id: int, user_id: int, suggestion_key: str, comment: str) -> Annotation:
    session = get_session()
    try:
        ann = Annotation(analysis_id=analysis_id, user_id=user_id, suggestion_key=suggestion_key, comment=comment.strip())
        session.add(ann)
        session.commit()
        session.refresh(ann)
        return ann
    finally:
        session.close()


def get_annotations(analysis_id: int) -> list[dict]:
    session = get_session()
    try:
        rows = session.query(Annotation, User.display_name).join(User, Annotation.user_id == User.id).filter(
            Annotation.analysis_id == analysis_id
        ).order_by(Annotation.created_at).all()
        return [
            {"key": ann.suggestion_key, "comment": ann.comment, "user": name, "time": ann.created_at.isoformat()}
            for ann, name in rows
        ]
    finally:
        session.close()


def create_session_code(mentor_id: int) -> str:
    import secrets
    code = secrets.token_urlsafe(6)[:8].upper()
    session = get_session()
    try:
        rs = ReviewSession(mentor_id=mentor_id, session_code=code)
        session.add(rs)
        session.commit()
        return code
    finally:
        session.close()


def join_session(session_code: str, user_id: int) -> ReviewSession | None:
    session = get_session()
    try:
        rs = session.query(ReviewSession).filter(
            ReviewSession.session_code == session_code.strip().upper(),
            ReviewSession.active == True,
        ).first()
        if not rs:
            return None
        existing = session.query(SessionParticipant).filter(
            SessionParticipant.session_id == rs.id,
            SessionParticipant.user_id == user_id,
        ).first()
        if not existing:
            session.add(SessionParticipant(session_id=rs.id, user_id=user_id))
            session.commit()
        return rs
    finally:
        session.close()


def get_session_participants(session_code: str) -> list[dict]:
    session = get_session()
    try:
        rs = session.query(ReviewSession).filter(ReviewSession.session_code == session_code.strip().upper()).first()
        if not rs:
            return []
        rows = session.query(User).join(SessionParticipant, SessionParticipant.user_id == User.id).filter(
            SessionParticipant.session_id == rs.id
        ).all()
        return [{"id": u.id, "username": u.username, "display_name": u.display_name, "role": u.role} for u in rows]
    finally:
        session.close()


def get_mentor_candidates(mentor_id: int) -> list[dict]:
    session = get_session()
    try:
        mentor_sessions = session.query(ReviewSession).filter(ReviewSession.mentor_id == mentor_id).all()
        candidates = {}
        for rs in mentor_sessions:
            participants = session.query(User).join(SessionParticipant, SessionParticipant.user_id == User.id).filter(
                SessionParticipant.session_id == rs.id,
                User.role == "candidate",
            ).all()
            for u in participants:
                if u.id not in candidates:
                    candidates[u.id] = {"id": u.id, "username": u.username, "display_name": u.display_name}
        return list(candidates.values())
    finally:
        session.close()


def get_user_analyses(user_id: int) -> list[dict]:
    session = get_session()
    try:
        rows = session.query(Analysis).filter(Analysis.user_id == user_id).order_by(Analysis.created_at.desc()).all()
        return [
            {"id": a.id, "resume_id": a.resume_id, "score": a.score_total, "provider": a.provider,
             "model": a.model, "created_at": a.created_at.isoformat()}
            for a in rows
        ]
    finally:
        session.close()


def get_candidate_analyses(candidate_id: int) -> list[dict]:
    return get_user_analyses(candidate_id)


def save_revision_snapshot(resume_id: int, analysis_id: int, decisions_json: str, score_total: int) -> None:
    session = get_session()
    try:
        snap = RevisionSnapshot(
            resume_id=resume_id, analysis_id=analysis_id,
            decisions_json=decisions_json, score_total=score_total,
        )
        session.add(snap)
        session.commit()
    finally:
        session.close()


def get_revision_history(resume_id: int) -> list[dict]:
    session = get_session()
    try:
        rows = session.query(RevisionSnapshot).filter(
            RevisionSnapshot.resume_id == resume_id
        ).order_by(RevisionSnapshot.created_at).all()
        return [
            {"id": s.id, "analysis_id": s.analysis_id, "score": s.score_total, "time": s.created_at.isoformat()}
            for s in rows
        ]
    finally:
        session.close()


def get_mentor_sessions(mentor_id: int) -> list[dict]:
    session = get_session()
    try:
        rows = session.query(ReviewSession).filter(ReviewSession.mentor_id == mentor_id).order_by(ReviewSession.created_at.desc()).all()
        return [{"id": rs.id, "code": rs.session_code, "active": rs.active, "created_at": rs.created_at.isoformat()} for rs in rows]
    finally:
        session.close()


init_db()
