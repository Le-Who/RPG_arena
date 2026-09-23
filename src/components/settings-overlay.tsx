"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "./dialog";
import { SettingsPanel } from "./settings-panel";

export function SettingsOverlay({ onClose, returnLabel, section = "" }: { onClose: () => void; returnLabel: string; section?: string }) {
  const closeGuard = useRef<(() => void) | null>(null);
  const [closeLabel, setCloseLabel] = useState(returnLabel);
  const closeOverlay = useRef(onClose);
  const register = useCallback((close: (() => void) | null, label?: string) => { closeGuard.current = close; setCloseLabel(close && label ? label : returnLabel); }, [returnLabel]);
  useEffect(() => { closeOverlay.current = onClose; }, [onClose]);
  useEffect(() => {
    const marker = crypto.randomUUID();
    const url = location.href;
    let active = false;
    let leftByBack = false;
    const onPop = (event: PopStateEvent) => {
      if (!active || leftByBack || event.state?.chronicleSettingsOverlay === marker || event.state?.chronicleDirtyGuard) return;
      event.stopImmediatePropagation();
      leftByBack = true;
      closeOverlay.current();
    };
    const timer = window.setTimeout(() => {
      active = true;
      history.pushState({ ...history.state, chronicleSettingsOverlay: marker }, "", url);
      window.addEventListener("popstate", onPop, true);
    }, 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("popstate", onPop, true);
      if (active && !leftByBack && location.href === url && history.state?.chronicleSettingsOverlay === marker) history.back();
    };
  }, []);
  useEffect(() => {
    if (!section) return;
    const timer = setTimeout(() => document.querySelector(`.settings-dialog [id="${CSS.escape(section)}"]`)?.scrollIntoView({ block: "start" }), 100);
    return () => clearTimeout(timer);
  }, [section]);
  return <Dialog title="Настройки пространства" closeLabel={closeLabel} wide className="settings-dialog" onClose={() => (closeGuard.current ?? onClose)()}>
    <SettingsPanel onClose={onClose} returnLabel={returnLabel} onCloseReady={register} />
  </Dialog>;
}
