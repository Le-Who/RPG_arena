"use client";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { APP_BUILD_ID } from "@/lib/build-version";

type Guard = { blocked: () => string | null; prepare?: () => void };
type Updates = { register: (key: string, guard: Guard) => () => void; isReloading: () => boolean };
const Context = createContext<Updates | null>(null);
export function useAppUpdateGuard(key: string, guard: Guard) {
  const context = useContext(Context);
  useLayoutEffect(() => context?.register(key, guard), [context, key, guard]);
  return context;
}
export function AppUpdateProvider({ children }: { children: ReactNode }) {
  const guards = useRef(new Map<string, Guard>());
  const reloading = useRef(false);
  const [available, setAvailable] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const inFlight = useRef<Promise<string | null> | null>(null);
  const lastCheck = useRef(0);
  const [context] = useState<Updates>(() => ({ register: (key, guard) => { guards.current.set(key, guard); return () => { if (guards.current.get(key) === guard) guards.current.delete(key); }; }, isReloading: () => reloading.current }));
  const check = useCallback((force = false): Promise<string | null> => {
    if (inFlight.current) return inFlight.current;
    if (!navigator.onLine || (!force && (document.visibilityState !== "visible" || Date.now() - lastCheck.current < 30000))) return Promise.resolve(null);
    lastCheck.current = Date.now();
    inFlight.current = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      try {
        const response = await fetch("/api/version", { cache: "no-store", signal: controller.signal });
        if (!response.ok) return null;
        const data: unknown = await response.json();
        const buildId = data && typeof data === "object" && "buildId" in data ? data.buildId : null;
        if (typeof buildId !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(buildId)) return null;
        setAvailable(buildId !== APP_BUILD_ID ? buildId : null);
        return buildId;
      } catch { return null; }
      finally { clearTimeout(timer); inFlight.current = null; }
    })();
    return inFlight.current;
  }, []);
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    const request = () => { void check(); };
    const message = (event: MessageEvent) => { if (event.data?.type === "chronicle:asset-unavailable") { setError("Часть приложения недоступна. Проверьте подключение; обновить страницу можно кнопкой ниже."); void check(); } };
    if (document.readyState === "complete") request(); else window.addEventListener("load", request, { once: true });
    window.addEventListener("focus", request); window.addEventListener("online", request); document.addEventListener("visibilitychange", request);
    navigator.serviceWorker?.addEventListener("message", message);
    const timer = setInterval(request, 300000);
    return () => { clearInterval(timer); window.removeEventListener("load", request); window.removeEventListener("focus", request); window.removeEventListener("online", request); document.removeEventListener("visibilitychange", request); navigator.serviceWorker?.removeEventListener("message", message); };
  }, [check]);
  const update = async () => {
    if (reloading.current) return;
    reloading.current = true; setChecking(true); setError("");
    try {
      if (!navigator.onLine || !(await check(true)) || !navigator.onLine) throw new Error("Нет связи с сервером. Черновик остаётся на экране; попробуйте позже.");
      if (document.querySelector('[role="dialog"]:not([hidden])')) throw new Error("Закройте открытое окно, сохранив изменения, и повторите обновление.");
      const otherForm = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input:not([type="hidden"]), textarea, select, [contenteditable="true"]')).some(node => !node.closest(".gx-composer") && !node.disabled && node.getClientRects().length > 0);
      if (otherForm) throw new Error("Сохраните изменения и закройте форму редактирования перед обновлением.");
      if (!guards.current.has("shell") || (location.pathname.startsWith("/play/") && !guards.current.has("play"))) throw new Error("Дождитесь загрузки страницы перед обновлением.");
      for (const guard of guards.current.values()) { const reason = guard.blocked(); if (reason) throw new Error(reason); }
      // No awaits between the final guards, draft persistence and navigation.
      for (const guard of guards.current.values()) guard.prepare?.();
      window.location.reload();
    } catch (e) { reloading.current = false; setChecking(false); setError(e instanceof Error ? e.message : "Обновить страницу пока не удалось."); }
  };
  return <Context.Provider value={context}>{children}{((available && dismissed !== available) || error) && <aside className="app-update" aria-label="Обновление приложения"><div role="status"><strong>{available ? "Доступна новая версия" : "Проверьте обновление приложения"}</strong><p>{error || "Обновите страницу, когда будете готовы. Черновик действия сохранится в этой вкладке."}</p></div><div className="app-update-actions"><button type="button" className="button primary" disabled={checking} onClick={() => void update()}>{checking ? "Проверяем…" : "Обновить приложение"}</button><button type="button" className="button secondary" disabled={checking} onClick={() => { setDismissed(available); setError(""); }}>Позже</button></div></aside>}</Context.Provider>;
}
