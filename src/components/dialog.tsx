"use client";
import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

type ActivationRecord = { target: WeakRef<HTMLElement> | null };
const activationKey = Symbol.for("chronicle.dialog.activation");

function trackDialogActivation(): ActivationRecord | null {
  if (typeof document === "undefined") return null;
  const owner = document as Document & { [activationKey]?: ActivationRecord };
  if (owner[activationKey]) return owner[activationKey];
  const record: ActivationRecord = { target: null };
  owner[activationKey] = record;
  // WebKit does not focus a button on a pointer click. Capture the trigger
  // before React opens its portal, without changing native pointer focus.
  // The per-document record survives HMR and its listeners retain no layer state.
  document.addEventListener("click", event => {
    if (!event.isTrusted) return;
    record.target = null;
    if (event.button !== 0) return;
    for (const node of event.composedPath()) {
      if (!(node instanceof Element)) continue;
      const target = node.closest<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex="-1"]), [contenteditable]:not([contenteditable="false"])');
      if (target) { record.target = new WeakRef(target); break; }
    }
  }, true);
  document.addEventListener("keydown", event => { if (event.isTrusted) record.target = null; }, true);
  document.addEventListener("focusin", event => { if (event.target !== record.target?.deref()) record.target = null; }, true);
  return record;
}

const activation = trackDialogActivation();

type DialogLayer = {
  element: HTMLDivElement;
  backdrop: HTMLElement;
  token: RefObject<DialogLayer | null>;
  parent: RefObject<DialogLayer | null> | null;
  suspended: boolean;
  zIndex: string;
  activeZIndex: string;
  opener: HTMLElement | null;
  close: () => void;
};
const ParentDialog = createContext<RefObject<DialogLayer | null> | null>(null);
// Portals are body siblings even when dialogs are nested in React. One owner must
// restore background attributes and scroll locking only after the last active layer.
const layers: DialogLayer[] = [];
const layerSubscribers = new Set<() => void>();
const subscribeLayers = (listener: () => void) => { layerSubscribers.add(listener); return () => { layerSubscribers.delete(listener); }; };
const activeDialog = () => topLayer()?.element ?? null;
export function useActiveDialogElement() { return useSyncExternalStore(subscribeLayers, activeDialog, () => null); }
const backgroundInert = new Map<Element, string | null>();
let observer: MutationObserver | null = null;
let originalOverflow = "";
let originalOverflowPriority = "";
let backgroundOpener: HTMLElement | null = null;

function topLayer() {
  return layers.findLast(layer => !layer.suspended && layer.element.isConnected);
}

function canRestoreFocus(element: HTMLElement | null): element is HTMLElement {
  return Boolean(element?.isConnected && !element.matches(":disabled") && !element.closest("[inert], [hidden]") && element.getClientRects().length);
}

function focusOpener() {
  const trigger = activation?.target?.deref() ?? null;
  return canRestoreFocus(trigger) ? trigger : document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

function onModalKey(event: KeyboardEvent) {
  const layer = topLayer();
  if (!layer) return;
  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); layer.close(); }
  if (event.key !== "Tab") return;
  const nodes = Array.from(layer.element.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]'))
    .filter(node => node.tabIndex >= 0 && canRestoreFocus(node));
  const first = nodes[0], last = nodes[nodes.length - 1];
  if (!first) { event.preventDefault(); layer.element.focus(); }
  else if (event.shiftKey && (document.activeElement === first || document.activeElement === layer.element)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function keepModalFocus(event: FocusEvent) {
  const layer = topLayer();
  if (layer && event.target instanceof Node && !layer.element.contains(event.target)) layer.element.focus({ preventScroll: true });
}

function syncModalBackground() {
  const top = topLayer();
  if (top && !observer) {
    originalOverflow = document.body.style.getPropertyValue("overflow");
    originalOverflowPriority = document.body.style.getPropertyPriority("overflow");
    backgroundOpener = focusOpener();
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onModalKey);
    document.addEventListener("focusin", keepModalFocus);
    // Late body portals/notifications must not become a route out of the modal.
    observer = new MutationObserver(syncModalBackground);
    observer.observe(document.body, { childList: true });
  }
  for (const child of Array.from(document.body.children)) {
    const ownLayer = layers.find(layer => layer.backdrop === child);
    if (ownLayer) {
      backgroundInert.delete(child);
      ownLayer.backdrop.inert = ownLayer !== top;
      // A nested portal can precede its parent in the DOM on the first mount.
      ownLayer.backdrop.style.zIndex = ownLayer === top ? ownLayer.activeZIndex : ownLayer.zIndex;
    } else if (top) {
      if (!backgroundInert.has(child)) backgroundInert.set(child, child.getAttribute("inert"));
      child.setAttribute("inert", "");
    }
  }
  if (!top && observer) {
    observer.disconnect(); observer = null;
    for (const [element, value] of backgroundInert) {
      if (value === null) element.removeAttribute("inert");
      else element.setAttribute("inert", value);
    }
    backgroundInert.clear();
    if (originalOverflow) document.body.style.setProperty("overflow", originalOverflow, originalOverflowPriority);
    else document.body.style.removeProperty("overflow");
    document.removeEventListener("keydown", onModalKey);
    document.removeEventListener("focusin", keepModalFocus);
  }
  for (const listener of layerSubscribers) listener();
}

function registerLayer(layer: DialogLayer) {
  const previousTop = topLayer();
  // Child effects can run before parent effects on the initial mount.
  const descendant = layers.findIndex(candidate => {
    for (let parent = candidate.parent; parent; parent = parent.current?.parent ?? null) {
      if (parent === layer.token) return true;
    }
    return false;
  });
  if (descendant < 0) layers.push(layer);
  else layers.splice(descendant, 0, layer);
  syncModalBackground();
  const top = topLayer();
  if (top && top !== previousTop) top.element.focus();
  return () => {
    // Passive cleanup runs after React has detached the closing portal.
    const wasTop = layers.findLast(candidate => !candidate.suspended) === layer;
    const fallback = backgroundOpener;
    layers.splice(layers.indexOf(layer), 1);
    // React owns the suspended state; it may have changed before effect cleanup.
    layer.backdrop.inert = layer.backdrop.hidden;
    layer.backdrop.style.zIndex = layer.zIndex;
    syncModalBackground();
    if (!wasTop) return;
    const next = topLayer();
    const target = next
      ? canRestoreFocus(layer.opener) && next.element.contains(layer.opener) ? layer.opener : next.element
      : canRestoreFocus(layer.opener) ? layer.opener : fallback;
    if (canRestoreFocus(target)) target.focus({ preventScroll: true });
  };
}

export function Dialog({ children, onClose, title, wide = false, className = "", suspended = false, closeLabel }: { children: ReactNode; onClose: () => void; title: string; wide?: boolean; className?: string; suspended?: boolean; closeLabel?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const layerRef = useRef<DialogLayer | null>(null);
  const parent = useContext(ParentDialog);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const element = ref.current;
    const backdrop = element?.parentElement;
    if (!element || !backdrop) return;
    const layer: DialogLayer = { element, backdrop, token: layerRef, parent, suspended, zIndex: backdrop.style.zIndex, activeZIndex: String((Number.parseInt(getComputedStyle(backdrop).zIndex, 10) || 100) + 1), opener: focusOpener(), close: () => closeRef.current() };
    layerRef.current = layer;
    const unregister = registerLayer(layer);
    return () => { unregister(); layerRef.current = null; };
  }, [parent, suspended]);
  if (typeof document === "undefined") return null;
  return <ParentDialog.Provider value={layerRef}>{createPortal(<div className="dialog-backdrop" hidden={suspended} inert={suspended} onMouseDown={(event) => { if (event.target === event.currentTarget && topLayer()?.element === ref.current) onClose(); }}><div className={`dialog ${wide ? "dialog-wide" : ""} ${className}`} role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}><header className="dialog-header"><strong>{title}</strong><button type="button" className={`icon-button dialog-close ${closeLabel ? "has-label" : ""}`} onClick={onClose} aria-label={closeLabel ?? "Закрыть"}>{closeLabel && <span>{closeLabel}</span>}<X size={19} aria-hidden="true" /></button></header><div className="dialog-body" tabIndex={-1}>{children}</div></div></div>, document.body)}</ParentDialog.Provider>;
}
