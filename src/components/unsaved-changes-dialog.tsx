"use client";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, LoaderCircle, Save } from "lucide-react";
import { Dialog } from "./dialog";

/** A blocked departure must ask for a visible decision, including inside settings overlays. */
export function UnsavedChangesDialog({ saving, onSave, onLeave, onDiscard, onCancel }: {
  saving: boolean;
  onSave: () => Promise<boolean>;
  onLeave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  const active = useRef(true), pending = useRef(false);
  const [incomplete, setIncomplete] = useState(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const cancel = () => { active.current = false; onCancel(); };
  const saveAndLeave = async () => {
    if (saving || pending.current) return;
    pending.current = true; setIncomplete(false);
    try {
      const saved = await onSave();
      // Cancelling this decision while saving also cancels the deferred departure.
      if (active.current) { if (saved) onLeave(); else setIncomplete(true); }
    } catch { if (active.current) setIncomplete(true); }
    finally { pending.current = false; }
  };
  return <Dialog title="Есть несохранённые изменения" className="unsaved-changes-dialog" onClose={cancel}>
    <div className="unsaved-changes-summary"><AlertTriangle size={28} aria-hidden="true" /><p>Сохранить изменения перед выходом?<br />Без сохранения последние правки будут потеряны.</p></div>
    {incomplete && <p className="notice error-notice" role="alert">Не все изменения сохранены. Продолжите редактирование и проверьте настройки.</p>}
    <div className="unsaved-changes-actions">
      <button type="button" className="button primary" disabled={saving} onClick={() => void saveAndLeave()}>{saving ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}Сохранить и выйти</button>
      <button type="button" className="button secondary unsaved-changes-discard" disabled={saving} onClick={onDiscard}>Выйти без сохранения</button>
      <button type="button" className="text-button" onClick={cancel}>Продолжить редактирование</button>
    </div>
  </Dialog>;
}
