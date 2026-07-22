// Real accounts persist in localStorage (survives closing the tab). Guest sessions live in
// sessionStorage only - closing the tab loses it, and there's no password to log back into
// that identity, so a guest can never return to a past session's data. Every place that
// touches the token/user pair goes through here so both storages stay in sync.
const TOKEN_KEY = "rtr_token"
const USER_KEY = "rtr_user"

export function getToken() {
    return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY)
}

export function getStoredUserRaw() {
    return localStorage.getItem(USER_KEY) || sessionStorage.getItem(USER_KEY)
}

export function setSession(token, user, persistent) {
    const store = persistent ? localStorage : sessionStorage
    const other = persistent ? sessionStorage : localStorage
    other.removeItem(TOKEN_KEY)
    other.removeItem(USER_KEY)
    store.setItem(TOKEN_KEY, token)
    store.setItem(USER_KEY, JSON.stringify(user))
}

export function clearSession() {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
    sessionStorage.removeItem(TOKEN_KEY)
    sessionStorage.removeItem(USER_KEY)
}
