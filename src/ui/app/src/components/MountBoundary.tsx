import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ProblemState } from "@/components/plain/States";

interface Props {
  /** What failed, in the person's words ("Link issue or PR", "This view"). */
  label: string;
  /** "overlay" floats above the page for dialogs; "inline" replaces the failed region. */
  placement: "overlay" | "inline";
  children: ReactNode;
}
interface State { error: Error | null; generation: number }

/**
 * Without a boundary, one render error unmounts the whole React root and leaves a blank page.
 * This keeps the rest of the page working and offers a fresh start for the failed part:
 * dismissing remounts the children under a new key, which discards their broken state.
 */
export class MountBoundary extends Component<Props, State> {
  state: State = { error: null, generation: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`${this.props.label} failed to render`, error, info.componentStack);
  }

  reset = () => this.setState((s) => ({ error: null, generation: s.generation + 1 }));

  render() {
    const { error, generation } = this.state;
    if (!error) return <Fragment key={generation}>{this.props.children}</Fragment>;
    const problem = (
      <ProblemState
        title={`${this.props.label} stopped because of an error`}
        message={error.message}
        action={<Button size="sm" variant="outline" onClick={this.reset}>{this.props.placement === "overlay" ? "Dismiss" : "Try again"}</Button>}
        className={this.props.placement === "overlay" ? "my-0 bg-background shadow-lg" : undefined}
      />
    );
    return this.props.placement === "overlay"
      ? <div className="fixed inset-x-4 bottom-4 z-[100] mx-auto max-w-readable">{problem}</div>
      : problem;
  }
}
