"use client";
import { useState, type FormEvent } from "react";
import { api, jsonBody } from "@/lib/api-client";
import { parseIdentityResponse } from "@/lib/ui-identity";
import { useApp } from "./app-shell";

/** Account creation is optional; switching profiles must not discard an open draft. */
export function AccountSettings({ unsaved }: { unsaved: boolean }) {
  const { identity, applyIdentityChange, hasOpenDraft, notify } = useApp();
  const [mode, setMode] = useState<"login" | "register">("register");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [adopting, setAdopting] = useState(false);
  if (!identity) return null;
  const switchBlocked = unsaved || hasOpenDraft;
  async function act(action: string, body: object, switchesProfile = false) {
    if (busy) return;
    if (switchesProfile && switchBlocked) { setError("Сначала сохраните настройки и завершите или закройте создание истории. При смене профиля несохранённые данные не переносятся."); return; }
    setBusy(true); setError("");
    try {
      const next = parseIdentityResponse(await api(`/api/auth/${action}`, jsonBody(body)));
      setPassword(""); setOldPassword(""); setNewPassword(""); setAdopting(false);
      await applyIdentityChange(next);
      notify(action === "password" ? "Пароль изменён. Войдите заново на нужных устройствах." : action === "adopt-guest" ? "Гостевые кампании перенесены в аккаунт." : "Профиль обновлён.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось обновить профиль."); }
    finally { setBusy(false); }
  }
  const submit = (event: FormEvent) => { event.preventDefault(); void act(mode, { login, password }, mode === "login"); };
  return <section className="settings-card account-settings" id="account" aria-busy={busy}>
    <div className="settings-card-heading"><div><h2>{identity.account ? `Аккаунт · ${identity.account.login}` : "Играйте без регистрации"}</h2><p>{identity.account ? "Кампании доступны после входа с другого устройства." : "Гостевые кампании принадлежат этому браузеру. Аккаунт нужен только для доступа с других устройств."}</p></div></div>
    {error && <p className="notice error-notice" role="alert">{error}</p>}
    {identity.kind === "guest" ? <>
      <p>При регистрации текущие кампании и настройки останутся с вами. При входе в существующий аккаунт перенос кампаний предлагается отдельно.</p>
      <div className="reading-choices"><button type="button" className={`reading-choice ${mode === "register" ? "selected" : ""}`} aria-pressed={mode === "register"} onClick={() => { setMode("register"); setError(""); }}>Новый аккаунт</button><button type="button" className={`reading-choice ${mode === "login" ? "selected" : ""}`} aria-pressed={mode === "login"} onClick={() => { setMode("login"); setError(""); }}>Уже есть аккаунт</button></div>
      <form onSubmit={submit} className="account-form">
        <label className="field"><span>Логин</span><input value={login} onChange={e => setLogin(e.target.value)} required minLength={3} maxLength={40} pattern="[A-Za-z0-9_][A-Za-z0-9_.\-]{2,39}" autoComplete="username" autoCapitalize="none" spellCheck={false} /></label>
        <label className="field"><span>Пароль</span><input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={mode === "register" ? 12 : 1} maxLength={256} autoComplete={mode === "register" ? "new-password" : "current-password"} /></label>
        <p className="settings-footnote">Логин: 3–40 латинских букв, цифр, _, . или -. {mode === "register" ? "Новый пароль: от 12 символов. " : ""}Восстановления пароля пока нет — сохраните его в менеджере паролей.</p>
        <button className="button primary" disabled={busy}>{busy ? "Подождите…" : mode === "register" ? "Создать аккаунт" : "Войти"}</button>
      </form>
    </> : <>
      {identity.pendingGuestCampaigns > 0 && <div className="notice"><div><strong>В этом браузере есть гостевые кампании: {identity.pendingGuestCampaigns}</strong><p>Они ещё не принадлежат аккаунту. Без переноса вы увидите их после выхода. Ключи и настройки гостя не заменят настройки аккаунта.</p>{adopting ? <><p>Перенести все эти кампании в текущий аккаунт? После переноса гостевой профиль станет пустым.</p><button className="button primary" disabled={busy} onClick={() => void act("adopt-guest", {})}>Подтвердить перенос</button><button className="text-button" disabled={busy} onClick={() => setAdopting(false)}>Отмена</button></> : <button className="button secondary" disabled={busy} onClick={() => setAdopting(true)}>Перенести гостевые кампании</button>}</div></div>}
      <div className="settings-close-actions"><button className="button secondary" disabled={busy} onClick={() => void act("logout", {}, true)}>Выйти</button><button className="text-button" disabled={busy} onClick={() => void act("logout-all", {}, true)}>Выйти на всех устройствах</button></div>
      <p className="settings-footnote">Выход не удаляет кампании аккаунта. Вы вернётесь к гостевому профилю этого браузера.</p>
      <details><summary>Изменить пароль</summary><form className="account-form" onSubmit={event => { event.preventDefault(); void act("password", { oldPassword, newPassword }, true); }}>
        <label className="field"><span>Текущий пароль</span><input type="password" required value={oldPassword} onChange={e => setOldPassword(e.target.value)} autoComplete="current-password" /></label>
        <label className="field"><span>Новый пароль</span><input type="password" required minLength={12} maxLength={256} value={newPassword} onChange={e => setNewPassword(e.target.value)} autoComplete="new-password" /></label>
        <p>Смена пароля завершит все сеансы, включая этот.</p><button className="button secondary" disabled={busy}>Изменить пароль и выйти</button>
      </form></details>
    </>}
  </section>;
}
