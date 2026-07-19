import { createContext, useContext, useState, useEffect } from "react"
import api from "../api/client"

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
    const [user, setUser] = useState(() => {
        const stored = localStorage.getItem("rtr_user")
        return stored ? JSON.parse(stored) : null
    })
    const [loading, setLoading] = useState(false)

    async function login(username, password) {
        const res = await api.post("/auth/login", { username, password })
        localStorage.setItem("rtr_token", res.data.token)
        localStorage.setItem("rtr_user", JSON.stringify(res.data.user))
        setUser(res.data.user)
        return res.data.user
    }

    async function register(username, password, display_name, role, email) {
        const res = await api.post("/auth/register", { username, password, display_name, role, email })
        localStorage.setItem("rtr_token", res.data.token)
        localStorage.setItem("rtr_user", JSON.stringify(res.data.user))
        setUser(res.data.user)
        return res.data.user
    }

    function logout() {
        localStorage.removeItem("rtr_token")
        localStorage.removeItem("rtr_user")
        setUser(null)
    }

    return (
        <AuthContext.Provider value={{ user, login, register, logout, loading }}>
            {children}
        </AuthContext.Provider>
    )
}

export function useAuth() {
    return useContext(AuthContext)
}
