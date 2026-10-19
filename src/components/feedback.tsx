"use client";
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, X } from "lucide-react";
import { useActiveDialogElement } from "./dialog";

export const SUCCESS_NOTICE_MS = 4500;
export type FeedbackKind = "success" | "warning" | "error";
type Notification = { id: number; text: string; kind: FeedbackKind; scope?: string };

/** Each accepted result restarts its own timer, even when its text is unchanged. */
export function useFeedbackState<T>(empty: T, isSuccess: (value: T) => boolean): [T, Dispatch<SetStateAction<T>>] {
  const [entry, setEntry] = useState({ value: empty, revision: 0 });
  const update = useCallback<Dispatch<SetStateAction<T>>>(value => {
    setEntry(old => ({ value: typeof value === "function" ? (value as (old: T) => T)(old.value) : value, revision: old.revision + 1 }));
  }, []);
  const transient = isSuccess(entry.value);
  useEffect(() => {
    if (!transient) return;
    const timer = window.setTimeout(() => setEntry(current => current.revision === entry.revision ? { value: empty, revision: current.revision + 1 } : current), SUCCESS_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [empty, entry.revision, transient]);
  return [entry.value, update];
}

export function useNotifications() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const sequence = useRef(0);
  const publish = useCallback((text: string, error: boolean | "warning" = false, scope?: string) => {
    const kind = error === "warning" ? "warning" : error ? "error" : "success";
    const next: Notification = { id: ++sequence.current, text, kind, scope };
    setNotifications(old => [...old.filter(item => scope ? item.scope !== scope : item.text !== text || item.kind !== kind), next]);
  }, []);
  const dismiss = useCallback((id: number) => setNotifications(old => old.filter(item => item.id !== id)), []);
  const clear = useCallback(() => setNotifications([]), []);
  const clearScope = useCallback((scope: string) => setNotifications(old => old.filter(item => item.scope !== scope)), []);
  return { notifications, publish, dismiss, clear, clearScope };
}

function NotificationItem({ notification, dismiss }: { notification: Notification; dismiss: (id: number) => void }) {
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  useEffect(() => {
    if (notification.kind !== "success" || hovered || focused) return;
    const timer = window.setTimeout(() => dismiss(notification.id), SUCCESS_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notification.id, notification.kind, hovered, focused, dismiss]);
  return <div className={`feedback-notification feedback-${notification.kind}`} role={notification.kind === "success" ? "status" : "alert"}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    {notification.kind === "success" ? <Check size={20} aria-hidden="true" /> : <AlertTriangle size={20} aria-hidden="true" />}
    <span>{notification.text}</span><button type="button" className="icon-button" aria-label="Закрыть уведомление" onClick={() => dismiss(notification.id)}><X size={16} aria-hidden="true" /></button>
  </div>;
}

/** Keep the one notification surface inside the active modal's focus/inert boundary. */
export function NotificationViewport({ notifications, dismiss }: { notifications: Notification[]; dismiss: (id: number) => void }) {
  const dialog = useActiveDialogElement();
  const stack = useRef<HTMLElement>(null);
  const latest = notifications.at(-1)?.id;
  useEffect(() => {
    const node = stack.current;
    if (!node) return;
    // Reveal each new result; keep a notification being read with the keyboard in view.
    if (document.activeElement instanceof HTMLElement && node.contains(document.activeElement)) document.activeElement.scrollIntoView({ block: "nearest" });
    else node.scrollTop = 0;
  }, [latest, dialog]);
  if (typeof document === "undefined" || !notifications.length) return null;
  return createPortal(<section ref={stack} className={`feedback-stack${dialog ? " feedback-in-dialog" : ""}`} aria-label={`Уведомления: ${notifications.length}`}>
    {[...notifications].reverse().map(notification => <NotificationItem key={notification.id} notification={notification} dismiss={dismiss} />)}
  </section>, dialog ?? document.body);
}
