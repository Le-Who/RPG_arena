"use client";
import { useState, useMemo, type RefObject } from "react";
import { ACTION_MAX_LENGTH, actionEntitySuggestions, completeActionEntity, type ActionEntitySuggestion } from "@/lib/action-composer";
import type { InteractionState } from "@/lib/interactions";
import "./action-entity-input.css";

const KIND_LABELS = { item: "Вещь", npc: "Персонаж", location: "Место", object: "Окружение", holding: "Вещь в мире" };

export function ActionEntityInput({ value, inputRef, state, disabled, onChange, onItemPick, onSubmit, onLimit }: {
  value: string; inputRef: RefObject<HTMLTextAreaElement | null>; state: InteractionState; disabled: boolean;
  onChange: (text: string) => void; onItemPick: (id: string, name: string) => void; onSubmit: () => void; onLimit: () => void;
}) {
  const [cursor, setCursor] = useState(0);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  // ⚡ Bolt: Memoize expensive suggestions to prevent recalculation when just changing active selection index
  const suggestions = useMemo(() =>
    focused && !dismissed && !disabled ? actionEntitySuggestions(value, cursor, state) : [],
  [focused, dismissed, disabled, value, cursor, state]);
  const selected = Math.min(active, Math.max(0, suggestions.length - 1));
  const pick = (entity: ActionEntitySuggestion) => {
    const result = completeActionEntity(value, entity);
    if (!result) { onLimit(); return; }
    onChange(result.text);
    if (entity.kind === "item") onItemPick(entity.ref, entity.name);
    setCursor(result.caret); setDismissed(true);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(result.caret, result.caret); });
  };
  return <div className="gx-entity-input">
    <textarea ref={inputRef} id="action-input" aria-label="Ваше действие" aria-describedby="action-entity-hint" aria-autocomplete="list" aria-controls={suggestions.length ? "action-entity-options" : undefined} aria-activedescendant={suggestions.length ? `action-entity-option-${selected}` : undefined}
      placeholder="Я хочу… — опишите своё действие, и мир ответит" value={value} maxLength={ACTION_MAX_LENGTH} rows={2} disabled={disabled}
      onFocus={event => { setFocused(true); setCursor(event.currentTarget.selectionStart); }} onBlur={() => setFocused(false)}
      onSelect={event => setCursor(event.currentTarget.selectionStart)}
      onChange={event => { onChange(event.target.value); setCursor(event.target.selectionStart); setActive(0); setDismissed(false); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); onSubmit(); return; }
        if (!suggestions.length) return;
        if (event.key === "Escape") { event.preventDefault(); setDismissed(true); }
        else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActive((selected + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length); }
        else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); pick(suggestions[selected]); }
      }} />
    {!!suggestions.length && <div id="action-entity-options" className="gx-entity-options" role="listbox" aria-label="Имена и предметы мира">
      {suggestions.map((entity, index) => <button key={`${entity.kind}:${entity.ref}:${index}`} id={`action-entity-option-${index}`} type="button" role="option" aria-selected={index === selected} className={index === selected ? "is-selected" : ""} onMouseDown={event => event.preventDefault()} onClick={() => pick(entity)}><span>{entity.name}</span><small>{KIND_LABELS[entity.kind]}</small></button>)}
      <p>↑ ↓ выбрать · Enter вставить · Esc закрыть</p>
    </div>}
    <p id="action-entity-hint" className="gx-entity-hint">Начните вводить имя, вещь или место — появятся подсказки из вашей истории.</p>
  </div>;
}
