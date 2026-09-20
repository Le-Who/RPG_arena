"use client";
import { useCallback, useEffect, useRef } from "react";

type Guard = {
  marker: string;
  url: string;
  released: boolean;
  completed: boolean;
  restoring: boolean;
  afterRelease: Array<() => void>;
  onPop: (event: PopStateEvent) => void;
};

function finishRelease(guard: Guard) {
  if (guard.completed) return;
  guard.completed = true;
  for (const callback of guard.afterRelease.splice(0)) callback();
}

function releaseGuard(guard: Guard, afterRelease?: () => void) {
  if (afterRelease) {
    if (guard.completed) { afterRelease(); return; }
    guard.afterRelease.push(afterRelease);
  }
  if (guard.released) return;
  guard.released = true;
  window.removeEventListener("popstate", guard.onPop, true);
  if (location.href !== guard.url || history.state?.chronicleDirtyGuard !== guard.marker) {
    finishRelease(guard);
    return;
  }
  const finish = () => {
    window.removeEventListener("popstate", finish, true);
    finishRelease(guard);
  };
  window.addEventListener("popstate", finish, true);
  history.back();
}

/** A same-URL history sentinel makes browser Back reviewable before a dirty form unmounts. */
export function useDirtyHistory(
  dirty: boolean,
  requestLeave: (leave: () => void) => void,
  onOverlayBack?: () => void,
) {
  const handler = useRef(requestLeave);
  const overlayBack = useRef(onOverlayBack);
  const guardRef = useRef<Guard | null>(null);
  useEffect(() => { handler.current = requestLeave; }, [requestLeave]);
  useEffect(() => { overlayBack.current = onOverlayBack; }, [onOverlayBack]);

  const release = useCallback((afterRelease?: () => void) => {
    const guard = guardRef.current;
    if (guard) releaseGuard(guard, afterRelease);
    else afterRelease?.();
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const url = location.href;
    const marker = crypto.randomUUID();
    const guard: Guard = {
      marker,
      url,
      released: false,
      completed: false,
      restoring: false,
      afterRelease: [],
      onPop: () => {},
    };
    guard.onPop = (event) => {
      if (guard.released) return;
      event.stopImmediatePropagation();
      if (!guard.restoring) {
        guard.restoring = true;
        history.forward();
        return;
      }
      guard.restoring = false;
      handler.current(() => releaseGuard(guard, () => {
        const closeOverlay = overlayBack.current;
        if (closeOverlay) closeOverlay();
        else history.back();
      }));
    };
    guardRef.current = guard;
    history.pushState({ ...history.state, chronicleDirtyGuard: marker }, "", url);
    window.addEventListener("popstate", guard.onPop, true);
    return () => {
      window.removeEventListener("popstate", guard.onPop, true);
      releaseGuard(guard, () => {
        if (guardRef.current === guard) guardRef.current = null;
      });
    };
  }, [dirty]);

  return release;
}
