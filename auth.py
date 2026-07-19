import bcrypt
import streamlit as st
from db import create_user, get_user_by_username


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))


def render_auth_page() -> dict | None:
    if st.session_state.get("current_user"):
        return st.session_state["current_user"]

    st.markdown("""
    <div style="max-width:420px;margin:2rem auto;padding:2rem;background:#FFFFFF;border:1px solid #E8EAED;border-radius:16px;box-shadow:0 4px 20px rgba(13,15,17,0.08);">
        <h2 style="font-family:'Instrument Serif',serif;font-weight:400;text-align:center;margin-bottom:0.25rem;">Welcome to RAGsToRiches</h2>
        <p style="text-align:center;color:#6B7280;font-size:0.85rem;margin-bottom:1.5rem;">Sign in or create an account to get started.</p>
    </div>
    """, unsafe_allow_html=True)

    tab_login, tab_register = st.tabs(["Sign In", "Register"])

    with tab_login:
        login_user = st.text_input("Username", key="login_username", placeholder="Enter your username")
        login_pass = st.text_input("Password", type="password", key="login_password", placeholder="Enter your password")
        if st.button("Sign In", key="login_btn", use_container_width=True):
            if not login_user.strip() or not login_pass.strip():
                st.error("Username and password are required.")
            else:
                user = get_user_by_username(login_user)
                if user and verify_password(login_pass, user.password_hash):
                    st.session_state["current_user"] = {
                        "id": user.id, "username": user.username,
                        "display_name": user.display_name, "role": user.role,
                    }
                    st.rerun()
                else:
                    st.error("Invalid username or password.")

    with tab_register:
        reg_display = st.text_input("Display Name", key="reg_display", placeholder="Your full name")
        reg_user = st.text_input("Username", key="reg_username", placeholder="Choose a username")
        reg_email = st.text_input("Email (optional)", key="reg_email", placeholder="you@example.com")
        reg_pass = st.text_input("Password", type="password", key="reg_password", placeholder="Choose a password")
        reg_confirm = st.text_input("Confirm Password", type="password", key="reg_confirm", placeholder="Re-enter password")
        reg_role = st.selectbox("I am a...", ["Candidate", "Mentor"], key="reg_role")

        if st.button("Create Account", key="register_btn", use_container_width=True):
            if not reg_user.strip() or not reg_pass.strip() or not reg_display.strip():
                st.error("Display name, username, and password are required.")
            elif reg_pass != reg_confirm:
                st.error("Passwords do not match.")
            elif len(reg_pass) < 6:
                st.error("Password must be at least 6 characters.")
            elif get_user_by_username(reg_user):
                st.error("Username already taken.")
            else:
                hashed = hash_password(reg_pass)
                user = create_user(
                    username=reg_user,
                    password_hash=hashed,
                    display_name=reg_display,
                    role=reg_role.lower(),
                    email=reg_email,
                )
                st.session_state["current_user"] = {
                    "id": user.id, "username": user.username,
                    "display_name": user.display_name, "role": user.role,
                }
                st.success(f"Account created! Welcome, {user.display_name}.")
                st.rerun()

    st.stop()
    return None
