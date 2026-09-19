export type MapSource = { id: string; name: string; description: string; icon: string; x: number; y: number; danger: number; current: boolean; discovered: boolean; connectedTo: string[] | null };
export type MapNode = { id: string; name: string; label: string; anchor: "start" | "middle" | "end"; labelDy: number; description: string; icon: string; danger: number; current: boolean; risk: "calm" | "uneasy" | "hostile"; x: number; y: number };
export type MapEdge = { id: string; x1: number; y1: number; x2: number; y2: number };
export type MapLayout = { nodes: MapNode[]; edges: MapEdge[]; width: number; height: number };

export const MAP_WIDTH = 100;
export const MAP_HEIGHT = 68;
const PAD = 13;

/** Long names at the edges would spill outside the card, so anchor follows position. */
export function labelAnchor(x: number): MapNode["anchor"] {
  if (x < MAP_WIDTH * 0.24) return "start";
  return x > MAP_WIDTH * 0.76 ? "end" : "middle";
}

export function shortLabel(name: string, max = 16): string {
  const clean = name.trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

export function riskOf(danger: number): MapNode["risk"] {
  if (!Number.isFinite(danger) || danger <= 30) return "calm";
  return danger <= 60 ? "uneasy" : "hostile";
}

/**
 * Projects authored grid coordinates into a stable viewBox.
 * Only discovered places are exposed: the map must never leak unvisited world state.
 */
export function buildMapLayout(locations: MapSource[]): MapLayout {
  const visible = locations.filter((location) => location.discovered && Number.isFinite(location.x) && Number.isFinite(location.y));
  if (!visible.length) return { nodes: [], edges: [], width: MAP_WIDTH, height: MAP_HEIGHT };

  const xs = visible.map((l) => l.x), ys = visible.map((l) => l.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX, spanY = maxY - minY;
  const project = (value: number, min: number, span: number, size: number) =>
    span === 0 ? size / 2 : PAD + ((value - min) / span) * (size - PAD * 2);

  const nodes: MapNode[] = visible.map((location) => {
    const x = Math.round(project(location.x, minX, spanX, MAP_WIDTH) * 100) / 100;
    return {
    id: location.id,
    name: location.name,
    label: shortLabel(location.name),
    anchor: labelAnchor(x),
    labelDy: -6.4,
    description: location.description,
    icon: location.icon,
    danger: location.danger,
    current: location.current,
    risk: riskOf(location.danger),
    x,
    y: Math.round(project(location.y, minY, spanY, MAP_HEIGHT) * 100) / 100,
  };
  });

  // Neighbouring labels would collide, so stagger them above/below by x order.
  [...nodes].sort((a, b) => a.x - b.x || a.y - b.y).forEach((node, index) => { node.labelDy = index % 2 === 0 ? -6.4 : 9.2; });

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: MapEdge[] = [];
  const seen = new Set<string>();
  for (const location of visible) {
    for (const target of location.connectedTo ?? []) {
      const a = byId.get(location.id), b = byId.get(target);
      if (!a || !b || a.id === b.id) continue;
      const key = [a.id, b.id].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ id: key, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
  }
  return { nodes, edges, width: MAP_WIDTH, height: MAP_HEIGHT };
}
