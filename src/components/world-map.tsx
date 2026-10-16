"use client";
import { useMemo, useRef, useState, type FocusEvent } from "react";
import { Expand, MapPin } from "lucide-react";
import { Dialog } from "./dialog";
import type { Snapshot } from "@/lib/ui-data";
import { dangerTone, mapEdges, projector, visibleMapLocations } from "@/lib/world-graph";

type Location = Snapshot["locations"][number];
const TONE: Record<string, string> = { ok: "var(--ok)", warn: "var(--warn)", bad: "var(--bad)" };

function revealFocusedLocation(event: FocusEvent<HTMLElement>) {
  const button = event.currentTarget;
  // Firefox can reveal only part of a focused button. Run after native focus
  // scrolling, and leave pointer focus or a subsequently focused control alone.
  requestAnimationFrame(() => {
    if (button.isConnected && document.activeElement === button && button.matches(":focus-visible")) {
      button.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    }
  });
}

/**
 * География — дополнительный номерной обзор; полные названия и действия
 * находятся в одном списке. Плотность координат не влияет на читаемость
 * и порядок клавиатурной навигации.
 */
export function WorldMap({
  locations,
  currentLocation,
  onLocationClick,
}: {
  locations: Location[];
  currentLocation: string;
  onLocationClick?: (name: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const visibleLocations = useMemo(() => visibleMapLocations(locations), [locations]);

  function closeExpanded() {
    setExpanded(false);
    expandButtonRef.current?.focus();
  }

  if (visibleLocations.length === 0) {
    return <div className="gx-map-empty"><MapPin size={22} aria-hidden="true" /><p>Локации ещё не открыты</p></div>;
  }

  const canvas = <MapCanvas locations={visibleLocations} currentLocation={currentLocation} onLocationClick={onLocationClick} large={false} />;

  return (
    <>
      <div className="gx-map-block">
        {canvas}
        <div className="gx-map-footer">
          <div className="gx-map-legend">
            <span><i style={{ background: "var(--ok)" }} />Спокойно</span>
            <span><i style={{ background: "var(--warn)" }} />Риск</span>
            <span><i style={{ background: "var(--bad)" }} />Опасно</span>
          </div>
          <button type="button" ref={expandButtonRef} className="gx-map-expand" onClick={() => setExpanded(true)} aria-label="Открыть карту крупно" aria-haspopup="dialog" aria-expanded={expanded}>
            <Expand size={14} aria-hidden="true" />Крупно
          </button>
        </div>
      </div>

      {expanded && (
        <Dialog title="Карта мира" wide className="map-dialog" onClose={closeExpanded}>
            <p className="dialog-intro">{visibleLocations.length} локаций · вы в «{currentLocation}»</p>
            <MapCanvas locations={visibleLocations} currentLocation={currentLocation} large
              onLocationClick={onLocationClick ? (name) => { onLocationClick(name); closeExpanded(); } : undefined} />
        </Dialog>
      )}
    </>
  );
}

function MapCanvas({
  locations, currentLocation, onLocationClick, large,
}: {
  locations: Location[]; currentLocation: string; onLocationClick?: (name: string) => void; large: boolean;
}) {
  const overview = useMemo(() => {
    const place = projector(locations, 15);
    const groups = new Map<string, { number: number; x: number; y: number; count: number }>();
    const points = new Map<string, { number: number; x: number; y: number }>();
    // Fixed SVG cells keep even coincident locations from drawing overlapping
    // number labels. A shared number links the group to every full-name entry.
    for (const loc of locations) {
      const { left, top } = place(loc.x, loc.y);
      const column = Math.min(7, Math.floor(left * 8 / 100));
      const row = Math.min(4, Math.floor(top * 5 / 100));
      const key = `${column}:${row}`;
      let group = groups.get(key);
      if (!group) {
        group = { number: groups.size + 1, x: column * 40 + 20, y: row * 40 + 20, count: 0 };
        groups.set(key, group);
      }
      group.count++;
      points.set(loc.id, group);
    }
    if (groups.size === 1) {
      const group = groups.values().next().value!;
      group.x = 160;
      group.y = 100;
    }
    return { groups: [...groups.values()], points };
  }, [locations]);
  const edges = useMemo(() => mapEdges(locations), [locations]);
  const interactive = Boolean(onLocationClick);

  return (
    <div className={`gx-map-canvas ${large ? "is-large" : ""}`}
      tabIndex={interactive ? -1 : 0}
      {...(!interactive ? { role: "region", "aria-label": "Карта мира, список локаций" } : {})}>
      <svg className="gx-map-svg" viewBox="0 0 320 200" aria-hidden="true" focusable="false">
        {edges.map(({ a, b }) => {
          const from = overview.points.get(a.id)!, to = overview.points.get(b.id)!;
          return <line key={`${a.id}-${b.id}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y}
            stroke="var(--accent-line)" strokeWidth="1.5" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />;
        })}
        {overview.groups.map(group => <g key={group.number}>
          <circle cx={group.x} cy={group.y} r="16" fill="var(--raised)" stroke="var(--accent)" strokeWidth="2" />
          <text x={group.x} y={group.y} dy=".35em" textAnchor="middle">{group.number}{group.count > 1 ? "+" : ""}</text>
        </g>)}
      </svg>
      <p className="gx-map-hint">Номера связывают обзор со списком. «+» объединяет соседние локации.</p>
      <ol className="gx-map-nodes" aria-label="Локации карты" role="list">
        {locations.map((loc) => {
          const tone = TONE[dangerTone(loc.danger)];
          const Tag = interactive ? "button" : "div";
          return (
            <li key={loc.id}>
              <Tag
                className={`gx-map-pin ${loc.current ? "is-current" : ""}`}
                style={{ "--pin": tone } as React.CSSProperties}
                aria-current={loc.current ? "location" : undefined}
                onFocus={interactive ? revealFocusedLocation : undefined}
                {...(interactive ? { onClick: () => onLocationClick!(loc.name), type: "button" as const,
                  "aria-label": `Отправиться в «${loc.name}». Опасность ${loc.danger} из 100${loc.current ? ". Вы здесь" : ""}` } : {})}
              >
                <span className="gx-map-number" aria-hidden="true">{overview.points.get(loc.id)!.number}</span>
                <span className="gx-map-dot" aria-hidden="true">{loc.icon || "📍"}</span>
                <span className="gx-map-label">
                  <span className="gx-map-name">{loc.name}</span>
                  <span className="gx-map-details">Опасность {loc.danger} из 100{loc.current && <span className="gx-map-current"> · Вы здесь</span>}</span>
                </span>
              </Tag>
            </li>
          );
        })}
      </ol>

      {edges.length > 0 && <p className="gx-map-routes">
        <strong>Пройденные маршруты:</strong>
        {edges.map(({ a, b }) => <span key={`${a.id}-${b.id}`}>{a.name} — {b.name}</span>)}
      </p>}

      {/* Текстовая альтернатива графики для скринридеров. */}
      <p className="sr-only">
        {`Карта: ${locations.length} локаций, ${edges.length} пройденных маршрутов. Текущая — ${currentLocation}.`}
      </p>
    </div>
  );
}
