import { createContext, useContext, useState, useEffect } from "react"
import api from "../api/client"
import { getStoredUserRaw, setSession, clearSession } from "../api/session"

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
    const [user, setUser] = useState(() => {
        const stored = getStoredUserRaw()
        if (!stored) return null
        try {
            return JSON.parse(stored)
        } catch {
            // corrupted/partial write - drop it instead of crashing every render forever
            clearSession()
            return null
        }
    })
    const [loading, setLoading] = useState(false)

    async function login(username, password) {
        const res = await api.post("/auth/login", { username, password })
        setSession(res.data.token, res.data.user, true)
        setUser(res.data.user)
        return res.data.user
    }

    async function register(username, password, display_name, role, email) {
        const res = await api.post("/auth/register", { username, password, display_name, role, email })
        setSession(res.data.token, res.data.user, true)
        setUser(res.data.user)
        return res.data.user
    }

    // ephemeral account, kept in sessionStorage only (see api/session.js) so the guest
    // has no way to come back to this identity once the tab closes
    async function continueAsGuest() {
        const res = await api.post("/auth/guest")
        setSession(res.data.token, res.data.user, false)
        setUser(res.data.user)
        return res.data.user
    }

    function logout() {
        clearSession()
        setUser(null)
    }

    return (
        <AuthContext.Provider value={{ user, login, register, continueAsGuest, logout, loading }}>
            {children}
        </AuthContext.Provider>
    )
}

export function useAuth() {
    return useContext(AuthContext)
}
