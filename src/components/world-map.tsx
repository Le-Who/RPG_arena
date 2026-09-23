"use client";
import { useRef, useState } from "react";
import { Expand, MapPin } from "lucide-react";
import { Dialog } from "./dialog";
import type { Snapshot } from "@/lib/ui-data";
import { dangerTone, mapEdges, projector, visibleMapLocations } from "@/lib/world-graph";

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
  const visibleLocations = visibleMapLocations(locations);

  function closeExpanded() {
    setExpanded(false);
    expandButtonRef.current?.focus();
  }

  if (visibleLocations.length === 0) {
    return <div className="gx-map-empty"><MapPin size={22} /><p>Локации ещё не открыты</p></div>;
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
          <button ref={expandButtonRef} className="gx-map-expand" onClick={() => setExpanded(true)} aria-label="Открыть карту крупно">
            <Expand size={14} />Крупно
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
