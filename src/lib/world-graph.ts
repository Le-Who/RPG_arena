/**
 * Граф карты мира. connectedTo хранит ID соседних локаций (не имена):
 * переименование не рвёт связь, а ремаппинг ID при форке переносит граф целиком.
 */
export type GraphNode = { id: string; name: string; x: number; y: number; connectedTo?: string[] | null };
export type GraphEdge<T> = { a: T; b: T };

/** Уникальные рёбра: A→B и B→A дают одну линию. Висячие ссылки отбрасываются. */
export function mapEdges<T extends GraphNode>(nodes: T[]): GraphEdge<T>[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const edges: GraphEdge<T>[] = [];
  for (const node of nodes) {
    for (const targetId of node.connectedTo ?? []) {
      if (targetId === node.id) continue; // петля не рисуется
      const target = byId.get(targetId);
      if (!target) continue; // соседа нет в выборке (не открыт / другая кампания)
      const key = [node.id, target.id].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ a: node, b: target });
    }
  }
  return edges;
}

/**
 * Проекция координат мира в проценты области просмотра.
 *
 * Работает в долях, а не в пикселях: подписи рисуются обычным HTML поверх SVG,
 * поэтому не масштабируются viewBox и остаются читаемыми на любом размере.
 * `spread` не даёт двум-трём точкам растянуться по углам.
 */
export function projector(nodes: GraphNode[], inset = 14, spread = 0.62) {
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const rangeX = maxX - minX, rangeY = maxY - minY;
  const usable = 100 - inset * 2;
  // Мало точек или вырожденный диапазон — сжимаем к центру, а не к краям.
  const factorX = rangeX === 0 ? 0 : Math.min(1, nodes.length > 3 ? 1 : spread);
  const factorY = rangeY === 0 ? 0 : Math.min(1, nodes.length > 3 ? 1 : spread);
  return (x: number, y: number) => {
    const nx = rangeX === 0 ? 0.5 : (x - minX) / rangeX;
    const ny = rangeY === 0 ? 0.5 : (y - minY) / rangeY;
    const centeredX = 0.5 + (nx - 0.5) * factorX;
    const centeredY = 0.5 + (ny - 0.5) * factorY;
    return { left: inset + centeredX * usable, top: inset + centeredY * usable };
  };
}

/** Порог опасности → семантический цвет дизайн-системы. */
export function dangerTone(danger: number): "ok" | "warn" | "bad" {
  return danger < 25 ? "ok" : danger < 50 ? "warn" : "bad";
}
