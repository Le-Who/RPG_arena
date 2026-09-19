import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DEFAULT_READING, normalizeReading, readingAttributes, READING_OPTIONS } from "../src/lib/reading-preferences";
import { buildMapLayout, riskOf, MAP_WIDTH, MAP_HEIGHT, type MapSource } from "../src/lib/world-map";

const place = (over: Partial<MapSource> = {}): MapSource => ({
  id: randomUUID(), name: "Место", description: "", icon: "📍",
  x: 0, y: 0, danger: 10, current: false, discovered: true, connectedTo: [], ...over,
});

test("v2.5 reading: unknown, partial and hostile input always yield a renderable theme", () => {
  assert.deepEqual(normalizeReading(undefined), DEFAULT_READING);
  assert.deepEqual(normalizeReading(null), DEFAULT_READING);
  assert.deepEqual(normalizeReading("sepia"), DEFAULT_READING);
  assert.deepEqual(normalizeReading([{ theme: "sepia" }]), DEFAULT_READING);
  assert.deepEqual(normalizeReading({ theme: "neon", textScale: 12, measure: null }), DEFAULT_READING);
  assert.equal(normalizeReading({ theme: "sepia" }).theme, "sepia");
  assert.equal(normalizeReading({ theme: "sepia" }).measure, "normal", "unspecified keys fall back, never undefined");
  // Prototype pollution attempts must not leak into the result.
  const polluted = normalizeReading(JSON.parse('{"__proto__":{"theme":"neon"},"theme":"contrast"}'));
  assert.equal(polluted.theme, "contrast");
  assert.equal(Object.keys(polluted).length, 4);
});

test("v2.5 reading: every declared option round-trips and maps to data attributes", () => {
  for (const [key, options] of Object.entries(READING_OPTIONS)) {
    for (const option of options) {
      const result = normalizeReading({ [key]: option.value }) as Record<string, string>;
      assert.equal(result[key], option.value, `${key}=${option.value} must survive normalization`);
    }
  }
  assert.deepEqual(readingAttributes({ textScale: "large", measure: "wide", theme: "contrast", motion: "reduced" }), {
    "data-text": "large", "data-measure": "wide", "data-theme": "contrast", "data-motion": "reduced",
  });
});

test("v2.5 map: projects authored coordinates into the viewBox with padding", () => {
  const a = place({ x: 2, y: 2, current: true }), b = place({ x: 10, y: 8 });
  const layout = buildMapLayout([a, b]);
  assert.equal(layout.nodes.length, 2);
  for (const node of layout.nodes) {
    assert.ok(node.x >= 0 && node.x <= MAP_WIDTH, "x stays inside the viewBox");
    assert.ok(node.y >= 0 && node.y <= MAP_HEIGHT, "y stays inside the viewBox");
  }
  const [first, second] = layout.nodes;
  assert.ok(first.x < second.x && first.y < second.y, "relative ordering is preserved");
});

test("v2.5 map: identical or single coordinates never divide by zero", () => {
  const single = buildMapLayout([place({ x: 5, y: 5 })]);
  assert.equal(single.nodes.length, 1);
  assert.equal(single.nodes[0].x, MAP_WIDTH / 2);
  assert.equal(single.nodes[0].y, MAP_HEIGHT / 2);
  for (const node of buildMapLayout([place({ x: 3, y: 3 }), place({ x: 3, y: 3 })]).nodes) {
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y));
  }
  assert.deepEqual(buildMapLayout([]).nodes, []);
  assert.deepEqual(buildMapLayout([place({ x: NaN, y: 2 })]).nodes, []);
});

test("v2.5 map: undiscovered places and their edges stay hidden", () => {
  const known = place({ x: 1, y: 1, current: true }), secret = place({ x: 9, y: 9, discovered: false });
  known.connectedTo = [secret.id];
  const layout = buildMapLayout([known, secret]);
  assert.equal(layout.nodes.length, 1, "unvisited world state must not leak");
  assert.equal(layout.edges.length, 0, "edges to hidden places are dropped");
  assert.ok(!JSON.stringify(layout).includes(secret.id));
});

test("v2.5 map: edges dedupe both directions and ignore self-links", () => {
  const a = place({ x: 0, y: 0 }), b = place({ x: 4, y: 4 });
  a.connectedTo = [b.id, a.id, "missing-id"];
  b.connectedTo = [a.id];
  const layout = buildMapLayout([a, b]);
  assert.equal(layout.edges.length, 1, "a→b and b→a describe one road");
});

test("v2.5 map: danger maps to three honest risk bands", () => {
  assert.equal(riskOf(0), "calm");
  assert.equal(riskOf(30), "calm");
  assert.equal(riskOf(31), "uneasy");
  assert.equal(riskOf(60), "uneasy");
  assert.equal(riskOf(61), "hostile");
  assert.equal(riskOf(Number.NaN), "calm");
});

test("v2.5 map: edge labels anchor inward and long names are truncated", () => {
  const left = place({ x: 0, y: 0, name: "Очень длинное название локации на краю" });
  const right = place({ x: 20, y: 6, name: "Правый край" });
  const middle = place({ x: 10, y: 3, name: "Центр" });
  const layout = buildMapLayout([left, right, middle]);
  const byName = Object.fromEntries(layout.nodes.map((n) => [n.name, n]));
  assert.equal(byName[left.name].anchor, "start", "left edge text must grow rightward");
  assert.equal(byName[right.name].anchor, "end", "right edge text must grow leftward");
  assert.equal(byName[middle.name].anchor, "middle");
  assert.ok(byName[left.name].label.length <= 16, "long names are shortened");
  assert.ok(byName[left.name].label.endsWith("…"));
  assert.equal(byName[middle.name].label, "Центр", "short names stay intact");
});

test("v2.5 map: adjacent labels alternate above and below to avoid collision", () => {
  const nodes = buildMapLayout([
    place({ x: 0, y: 4, name: "Первое место" }),
    place({ x: 5, y: 4, name: "Второе место" }),
    place({ x: 10, y: 4, name: "Третье место" }),
  ]).nodes.sort((a, b) => a.x - b.x);
  assert.notEqual(nodes[0].labelDy, nodes[1].labelDy, "neighbours must not share a label row");
  assert.notEqual(nodes[1].labelDy, nodes[2].labelDy);
  assert.equal(nodes[0].labelDy, nodes[2].labelDy, "the pattern alternates predictably");
});
