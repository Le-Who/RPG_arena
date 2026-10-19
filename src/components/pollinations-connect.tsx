"use client";
import { useCallback, useEffect, useState } from "react";
import { ExternalLink, LoaderCircle, X } from "lucide-react";
import { ContextualHelp } from "./contextual-help";
import { SUCCESS_NOTICE_MS } from "./feedback";
import { api, jsonBody } from "@/lib/api-client";

const outcomes = {
  connected: { title: "Аккаунт Pollinations подключён", text: "Выберите модель для рассказчика или личных иллюстраций в настройках ниже." },
  cancelled: { title: "Подключение Pollinations отменено", text: "Вход можно повторить ниже. Ранее сохранённые ключи не изменены." },
  failed: { title: "Подключение Pollinations не завершено", text: "Повторите подключение ниже. Ранее сохранённые ключи не изменены." },
};
type Outcome = keyof typeof outcomes;
export function PollinationsConnectionNotice() {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      const value = new URL(window.location.href).searchParams.get("pollinations");
      if (active && value && Object.hasOwn(outcomes, value)) setOutcome(value as Outcome);
    });
    return () => { active = false; };
  }, []);
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const dismiss = useCallback((restoreFocus = false) => {
    setOutcome(null);
    const url = new URL(window.location.href);
    if (url.searchParams.get("pollinations") === outcome) {
      url.searchParams.delete("pollinations");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
    if (restoreFocus) {
      const select = document.querySelector<HTMLElement>("#text-provider select");
      (select?.getClientRects().length ? select : document.getElementById("text-provider-heading"))?.focus();
    }
  }, [outcome]);
  useEffect(() => {
    if (!outcome || outcome === "failed" || hovered || focused) return;
    const timer = window.setTimeout(() => dismiss(), SUCCESS_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [outcome, hovered, focused, dismiss]);
  if (!outcome) return null;
  return <div className={`notice pollinations-result${outcome === "failed" ? " error-notice" : ""}`} role={outcome === "failed" ? "alert" : "status"} aria-live={outcome === "failed" ? "assertive" : "polite"}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <div><strong>{outcomes[outcome].title}</strong><p>{outcomes[outcome].text}</p></div>
    <button type="button" className="icon-button" aria-label="Закрыть сообщение Pollinations" onClick={() => dismiss(true)}><X aria-hidden="true" size={18} /></button>
  </div>;
}

export function PollinationsConnect({ disabled, beforeConnect, configured, onConnectingChange }: {
  disabled?: boolean; configured?: boolean; beforeConnect: () => Promise<boolean>; onConnectingChange?: (busy: boolean) => void;
}) {
  const [available, setAvailable] = useState<boolean | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const check = useCallback(async () => {
    try { setAvailable((await api<{ available: boolean }>("/api/settings/pollinations/connect")).available); setError(""); }
    catch { setError("Не удалось проверить доступность входа Pollinations."); }
  }, []);
  useEffect(() => { void Promise.resolve().then(check); }, [check]);
  const connect = async () => {
    if (disabled || busy || !available) return;
    setBusy(true); setError("");
    try {
      if (!await beforeConnect()) return;
      onConnectingChange?.(true);
      const result = await api<{ url: string }>("/api/settings/pollinations/connect", jsonBody({}));
      const url = new URL(result.url);
      if (url.origin !== "https://enter.pollinations.ai" || url.username || url.password) throw new Error("Неподдерживаемый адрес входа Pollinations.");
      window.location.assign(url.href);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось открыть вход Pollinations."); }
    finally { setBusy(false); onConnectingChange?.(false); }
  };
  return <div className="pollinations-connect">
    <button type="button" className="button primary" disabled={disabled || busy || available !== true} onClick={() => void connect()}>{busy ? <LoaderCircle aria-hidden="true" className="spin" size={15} /> : <ExternalLink aria-hidden="true" size={15} />}{busy ? "Открываем Pollinations…" : configured ? "Переподключить аккаунт Pollinations" : "Подключить аккаунт Pollinations"}</button>
    <p className="settings-footnote">Расходы списываются с вашего аккаунта Pollinations.</p><ContextualHelp title="Вход через Pollinations"><p>Вход, создание ключа, бюджет и срок доступа подтверждаются на сайте Pollinations. Этот аккаунт можно использовать для рассказчика и иллюстраций.</p><p>Для настройки входа администратору нужен публичный HTTPS-адрес приложения либо App Key Pollinations.</p></ContextualHelp>
    {available === false && <p className="settings-footnote" role="status">Вход через Pollinations пока недоступен. Можно подключить API-ключ вручную.</p>}
    {available === null && !error && <p role="status" className="settings-footnote">Проверяем доступность входа Pollinations…</p>}
    {error && <><p role="alert">{error}</p><button type="button" className="text-button" disabled={busy} onClick={() => void check()}>Повторить проверку входа</button></>}
  </div>;
}
