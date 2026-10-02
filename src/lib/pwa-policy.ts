/** ECO-1: captures `beforeinstallprompt` before hydration so the install entry never misses it.
 * Kept outside "use client" modules: server layouts need the literal string, not a client reference. */
export const INSTALL_CAPTURE_SCRIPT = "window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__chronicleInstallPrompt=e;window.dispatchEvent(new Event('chronicle:installable'));});window.addEventListener('appinstalled',function(){window.__chronicleInstallPrompt=null;window.dispatchEvent(new Event('chronicle:installable'));});";
