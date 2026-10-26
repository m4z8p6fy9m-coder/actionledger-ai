import { Component, type ErrorInfo, type ReactNode } from "react";
import { TriangleAlert, RefreshCw } from "lucide-react";
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Dashboard rendering failed", error, info.componentStack);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="fatal-error" role="alert">
        <span className="fatal-icon">
          <TriangleAlert size={28} />
        </span>
        <h1>The dashboard needs to reload</h1>
        <p>
          Your persisted actions and approval decisions remain in the local
          ledger. Reload to reconnect, then inspect an action’s state before
          retrying execution.
        </p>
        <button
          className="button primary"
          onClick={() => window.location.reload()}
        >
          <RefreshCw size={16} />
          Reload dashboard
        </button>
      </main>
    );
  }
}
