"use client";

import {createContext, useCallback, useContext, useMemo, useState, type ReactNode} from "react";

export type ToastKind = "info" | "success" | "error" | "pending";

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
  href?: string;
  hrefLabel?: string;
}

interface ToastApi {
  push: (toast: Omit<Toast, "id">) => number;
  dismiss: (id: number) => void;
  /** Replaces an existing toast in place — used to turn "submitted" into "confirmed". */
  update: (id: number, toast: Partial<Omit<Toast, "id">>) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let nextId = 1;

const AUTO_DISMISS_MS: Record<ToastKind, number | null> = {
  info: 5_000,
  success: 7_000,
  error: 12_000,
  // Pending toasts stay until the caller resolves them.
  pending: null,
};

export function ToastProvider({children}: {children: ReactNode}) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const scheduleDismiss = useCallback(
    (id: number, kind: ToastKind) => {
      const delay = AUTO_DISMISS_MS[kind];
      if (delay !== null) setTimeout(() => dismiss(id), delay);
    },
    [dismiss],
  );

  const push = useCallback(
    (toast: Omit<Toast, "id">) => {
      const id = nextId++;
      setToasts((current) => [...current, {...toast, id}]);
      scheduleDismiss(id, toast.kind);
      return id;
    },
    [scheduleDismiss],
  );

  const update = useCallback(
    (id: number, patch: Partial<Omit<Toast, "id">>) => {
      setToasts((current) =>
        current.map((toast) => (toast.id === id ? {...toast, ...patch} : toast)),
      );
      if (patch.kind) scheduleDismiss(id, patch.kind);
    },
    [scheduleDismiss],
  );

  const api = useMemo<ToastApi>(() => ({push, dismiss, update}), [push, dismiss, update]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
        role="region"
        aria-label="Notifications"
      >
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const KIND_STYLES: Record<ToastKind, {ring: string; icon: ReactNode}> = {
  info: {ring: "border-white/10", icon: <span className="text-verify-300">i</span>},
  success: {ring: "border-mint-500/40", icon: <span className="text-mint-400">✓</span>},
  error: {ring: "border-flare-600/50", icon: <span className="text-flare-400">!</span>},
  pending: {
    ring: "border-verify-500/40",
    icon: <span className="block h-3 w-3 animate-spin rounded-full border-2 border-verify-400 border-t-transparent" />,
  },
};

function ToastCard({toast, onDismiss}: {toast: Toast; onDismiss: () => void}) {
  const style = KIND_STYLES[toast.kind];

  return (
    <div
      className={`pointer-events-auto animate-fade-up rounded-xl border ${style.ring} bg-ink-850/95 p-3.5 shadow-card backdrop-blur`}
      role={toast.kind === "error" ? "alert" : "status"}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-sm font-bold">
          {style.icon}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-100">{toast.title}</p>
          {toast.body ? <p className="mt-0.5 break-words text-xs text-slate-400">{toast.body}</p> : null}
          {toast.href ? (
            <a
              href={toast.href}
              target="_blank"
              rel="noreferrer"
              className="mt-1.5 inline-block text-xs font-medium text-flare-300 hover:text-flare-200"
            >
              {toast.hrefLabel ?? "View transaction"} ↗
            </a>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss notification"
          className="-mr-1 -mt-1 rounded-lg px-1.5 py-0.5 text-slate-600 hover:bg-white/5 hover:text-slate-300"
        >
          ×
        </button>
      </div>
    </div>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside <ToastProvider>");
  return context;
}
