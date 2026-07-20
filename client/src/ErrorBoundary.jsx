import { Component } from "react"

export default class ErrorBoundary extends Component {
    constructor(props) {
        super(props)
        this.state = { error: null }
    }

    static getDerivedStateFromError(error) {
        return { error }
    }

    componentDidCatch(error, info) {
        console.error("Unhandled UI error:", error, info)
    }

    render() {
        if (!this.state.error) return this.props.children
        return (
            <main className="app-container">
                <section className="auth-card" style={{ marginTop: "4rem" }}>
                    <h2>Something went wrong</h2>
                    <p className="auth-sub">
                        An unexpected error interrupted the page. Your data is safe — try reloading.
                    </p>
                    <p className="error-msg">{this.state.error.message || String(this.state.error)}</p>
                    <button className="btn-primary full-width" onClick={() => window.location.reload()}>
                        Reload
                    </button>
                </section>
            </main>
        )
    }
}
