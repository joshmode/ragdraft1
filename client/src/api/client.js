import axios from "axios"

const api = axios.create({
    baseURL: "/api",
    timeout: 300000,
})

api.interceptors.request.use((config) => {
    const token = localStorage.getItem("rtr_token")
    if (token) {
        config.headers.Authorization = `Bearer ${token}`
    }
    return config
})

api.interceptors.response.use(
    (res) => res,
    (err) => {
        if (err.response?.status === 401) {
            localStorage.removeItem("rtr_token")
            localStorage.removeItem("rtr_user")
            window.location.reload()
        }
        return Promise.reject(err)
    }
)

export default api
