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

const MAX_429_RETRIES = 4
const BASE_RETRY_DELAY_MS = 1000
const MAX_RETRY_DELAY_MS = 15000

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

api.interceptors.response.use(
    (res) => res,
    async (err) => {
        // only reload on a 401 that HAD a token - a bad login/register attempt has no
        // Authorization header and needs to reach the form's own error handling instead
        if (err.response?.status === 401 && err.config?.headers?.Authorization) {
            localStorage.removeItem("rtr_token")
            localStorage.removeItem("rtr_user")
            window.location.reload()
            return Promise.reject(err)
        }

        // 429 is transient, retry with backoff+jitter before surfacing it as an error
        if (err.response?.status === 429) {
            const config = err.config || {}
            const attempt = config.__retryCount || 0
            if (attempt < MAX_429_RETRIES) {
                config.__retryCount = attempt + 1
                const retryAfterSec = Number(err.response.data?.retry_after) || 0
                const backoffMs = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** attempt)
                const jitterMs = Math.random() * 400
                await sleep((retryAfterSec > 0 ? retryAfterSec * 1000 : backoffMs) + jitterMs)
                return api(config)
            }
        }

        return Promise.reject(err)
    }
)

export default api
