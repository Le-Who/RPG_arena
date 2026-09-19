"use client";
import { useRef, useState } from "react";
import { Expand, MapPin, X } from "lucide-react";
import type { Snapshot } from "@/lib/ui-data";
import { dangerTone, mapEdges, projector } from "@/lib/world-graph";

type Location = Snapshot["locations"][number];
const TONE: Record<string, string> = { ok: "var(--ok)", warn: "var(--warn)", bad: "var(--bad)" };

/**
 * Карта мира. Геометрия — SVG, подписи — обычный HTML поверх него:
 * так текст не масштабируется viewBox и остаётся читаемым (и попадает в аудит).
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

  function closeExpanded() {
    setExpanded(false);
    expandButtonRef.current?.focus();
  }

  if (locations.length === 0) {
    return <div className="gx-map-empty"><MapPin size={22} /><p>Локации ещё не открыты</p></div>;
  }

  const canvas = <MapCanvas locations={locations} currentLocation={currentLocation} onLocationClick={onLocationClick} large={false} />;

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
          <button ref={expandButtonRef} className="gx-map-expand" onClick={() => setExpanded(true)} aria-label="Открыть карту крупно">
            <Expand size={14} />Крупно
          </button>
        </div>
      </div>

      {expanded && (
        <div className="gx-map-overlay" role="dialog" aria-modal="true" aria-label="Карта мира"
          onKeyDown={(e) => { if (e.key === "Escape") closeExpanded(); }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) closeExpanded(); }}>
          <div className="gx-map-modal">
            <header>
              <div>
                <strong>Карта мира</strong>
                <span>{locations.length} локаций · вы в «{currentLocation}»</span>
              </div>
              <button className="icon-button" onClick={closeExpanded} aria-label="Закрыть карту" autoFocus><X size={19} /></button>
            </header>
            <MapCanvas locations={locations} currentLocation={currentLocation} large
              onLocationClick={onLocationClick ? (name) => { onLocationClick(name); closeExpanded(); } : undefined} />
          </div>
        </div>
      )}
    </>
  );
}

function MapCanvas({
  locations, currentLocation, onLocationClick, large,
}: {
  locations: Location[]; currentLocation: string; onLocationClick?: (name: string) => void; large: boolean;
}) {
  const place = projector(locations, large ? 10 : 15);
  const edges = mapEdges(locations);
  const interactive = Boolean(onLocationClick);

  return (
    <div className={`gx-map-canvas ${large ? "is-large" : ""}`}>
      <svg className="gx-map-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {edges.map(({ a, b }) => {
          const from = place(a.x, a.y), to = place(b.x, b.y);
          return <line key={`${a.id}-${b.id}`} x1={from.left} y1={from.top} x2={to.left} y2={to.top}
            stroke="var(--accent-line)" strokeWidth="0.4" strokeDasharray="1.6 1.2" vectorEffect="non-scaling-stroke" />;
        })}
      </svg>

      <div className="gx-map-nodes">
        {locations.map((loc) => {
          const { left, top } = place(loc.x, loc.y);
          const tone = TONE[dangerTone(loc.danger)];
          const Tag = interactive ? "button" : "div";
          return (
            <Tag
              key={loc.id}
              className={`gx-map-pin ${loc.current ? "is-current" : ""}`}
              style={{ left: `${left}%`, top: `${top}%`, "--pin": tone } as React.CSSProperties}
              {...(interactive ? { onClick: () => onLocationClick!(loc.name), type: "button" as const,
                "aria-label": `Отправиться в «${loc.name}». Опасность ${loc.danger} из 100${loc.current ? ". Вы здесь" : ""}` } : {})}
            >
              <span className="gx-map-dot-wrap">
                <span className="gx-map-dot">{loc.icon || "📍"}</span>
                <span className="gx-map-danger">{loc.danger}</span>
              </span>
              <span className="gx-map-name">{loc.name}</span>
            </Tag>
          );
        })}
      </div>

      {/* Текстовая альтернатива графики для скринридеров. */}
      <p className="sr-only">
        {`Карта: ${locations.length} локаций, ${edges.length} пройденных маршрутов. Текущая — ${currentLocation}.`}
        {edges.map(({ a, b }) => ` Путь: ${a.name} — ${b.name}.`).join("")}
      </p>
    </div>
  );
}
