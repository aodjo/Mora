import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

export type ToastVariant = "error" | "info" | "success";

interface ToastItem {
  id: string;
  message: string;
  variant: ToastVariant;
  duration: number;
}

interface ToastOptions {
  variant?: ToastVariant;
  duration?: number;
}

interface ToastContextValue {
  showToast: (message: string, options?: ToastOptions) => string;
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, number>());

  const dismissToast = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback((message: string, options: ToastOptions = {}) => {
    const id = crypto.randomUUID();
    const duration = Math.min(15_000, Math.max(1_500, options.duration ?? 4_500));
    const toast: ToastItem = { id, message, variant: options.variant ?? "success", duration };
    setToasts((current) => [...current, toast]);
    timers.current.set(id, window.setTimeout(() => dismissToast(id), duration));
    return id;
  }, [dismissToast]);

  useEffect(() => () => {
    for (const timer of timers.current.values()) window.clearTimeout(timer);
    timers.current.clear();
  }, []);

  const value = useMemo(() => ({ showToast, dismissToast }), [dismissToast, showToast]);
  return <ToastContext.Provider value={value}>
    {children}
    <div className="toast-region" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => <Toast key={toast.id} toast={toast} onDismiss={dismissToast}/>) }
    </div>
  </ToastContext.Provider>;
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (value === null) throw new Error("useToast must be used inside ToastProvider");
  return value;
}

function Toast({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: string) => void }) {
  const Icon = toast.variant === "error" ? AlertCircle : toast.variant === "info" ? Info : CheckCircle2;
  const style = { "--toast-duration": `${toast.duration}ms` } as CSSProperties;
  return <section className={`toast-card ${toast.variant}`} role={toast.variant === "error" ? "alert" : "status"} style={style}>
    <span className="toast-icon"><Icon size={17}/></span>
    <p>{toast.message}</p>
    <button type="button" className="toast-close" aria-label="알림 닫기" onClick={() => onDismiss(toast.id)}><X size={15}/></button>
    <span className="toast-progress" aria-hidden="true"><i/></span>
  </section>;
}
