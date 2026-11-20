// FILE: web/src/App.tsx
// Application shell showing the connection status of the backend API.
import { useCallback, useEffect, useState } from "react";
import { CircleCheck, CircleX, LoaderCircle, RefreshCw } from "lucide-react";
import { fetchHealth, type DatabaseStatus, type HealthResponse } from "./api-client";

type ConnectionState =
  | { kind: "loading" }
  | { kind: "ready"; health: HealthResponse }
  | { kind: "error"; message: string };

function StatusRow({ label, ok }: { label: string; ok: boolean }) {
  const Icon = ok ? CircleCheck : CircleX;
  return (
    <li className="flex items-center justify-between py-2">
      <span className="text-sm text-slate-700">{label}</span>
      <span
        className={`flex items-center gap-1.5 text-sm font-medium ${ok ? "text-emerald-700" : "text-red-700"}`}
      >
        <Icon size={16} aria-hidden="true" />
        {ok ? "Connected" : "Unavailable"}
      </span>
    </li>
  );
}

const isOk = (status: DatabaseStatus) => status === "ok";

export function App() {
  const [state, setState] = useState<ConnectionState>({ kind: "loading" });

  const check = useCallback((signal?: AbortSignal) => {
    setState({ kind: "loading" });
    fetchHealth(signal)
      .then((health) => setState({ kind: "ready", health }))
      .catch((error: unknown) => {
        if (signal?.aborted) return;
        const message = error instanceof Error ? error.message : "Unknown error.";
        setState({ kind: "error", message });
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    check(controller.signal);
    return () => controller.abort();
  }, [check]);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold text-slate-900">MarketLens AI</h1>
      <p className="mt-1 text-sm text-slate-600">Foundation check: frontend to API connection.</p>

      <section
        className="mt-6 rounded-md border border-slate-200 bg-white px-4 py-3"
        aria-labelledby="status-heading"
      >
        <div className="flex items-center justify-between">
          <h2 id="status-heading" className="text-sm font-semibold text-slate-900">
            Backend status
          </h2>
          <button
            type="button"
            onClick={() => check()}
            className="flex items-center gap-1.5 rounded px-2 py-1 text-sm text-blue-700 hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-blue-700"
          >
            <RefreshCw size={14} aria-hidden="true" />
            Check again
          </button>
        </div>

        <div role="status" aria-live="polite">
          {state.kind === "loading" && (
            <p className="flex items-center gap-2 py-3 text-sm text-slate-600">
              <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
              Contacting the API
            </p>
          )}
          {state.kind === "error" && (
            <p className="py-3 text-sm text-red-700">
              Could not reach the API: {state.message} Check that the API is running (npm run dev:api).
            </p>
          )}
          {state.kind === "ready" && (
            <ul className="divide-y divide-slate-100">
              <StatusRow label="API" ok />
              <StatusRow label="Private database" ok={isOk(state.health.databases.private)} />
              <StatusRow label="Demo database" ok={isOk(state.health.databases.demo)} />
            </ul>
          )}
        </div>
      </section>
    </main>
  );
}
