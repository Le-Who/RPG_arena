import { test } from "node:test";
import assert from "node:assert/strict";
import { dangerTone, mapEdges, projector, visibleMapLocations, type GraphNode } from "../src/lib/world-graph";

function point(actual: { left: number; top: number }, left: number, top: number) {
  assert.ok(Number.isFinite(actual.left), `left must be finite, received ${actual.left}`);
  assert.ok(Number.isFinite(actual.top), `top must be finite, received ${actual.top}`);
  assert.ok(Math.abs(actual.left - left) < 1e-10, `left: expected ${left}, received ${actual.left}`);
  assert.ok(Math.abs(actual.top - top) < 1e-10, `top: expected ${top}, received ${actual.top}`);
}

function node(id: string, x: number, y: number): GraphNode {
  return { id, name: id, x, y };
}

// A changed comparison at either boundary would mislabel an adjacent location.
for (const [danger, tone] of [[24, "ok"], [25, "warn"], [49, "warn"], [50, "bad"]] as const) {
  test(`danger ${danger} uses ${tone} map tone`, () => assert.equal(dangerTone(danger), tone));
}

test("one location projects to the center regardless of its world origin", () => {
  point(projector([node("a", -30, 90)])(-30, 90), 50, 50);
});

test("empty map projector returns the center rather than NaN", () => {
  point(projector([])(0, 0), 50, 50);
});

test("coincident locations keep both axes centered", () => {
  const nodes = [node("a", 7, -4), node("b", 7, -4), node("c", 7, -4), node("d", 7, -4)];
  const place = projector(nodes);
  for (const location of nodes) point(place(location.x, location.y), 50, 50);
});

test("horizontal locations center only the degenerate y axis", () => {
  const place = projector([node("a", -10, 8), node("b", 10, 8)]);
  point(place(-10, 8), 27.68, 50);
  point(place(10, 8), 72.32, 50);
});

test("vertical locations center only the degenerate x axis", () => {
  const place = projector([node("a", 8, -10), node("b", 8, 10)]);
  point(place(8, -10), 50, 27.68);
  point(place(8, 10), 50, 72.32);
});

test("two locations retain the compact diagonal geometry", () => {
  const place = projector([node("a", -10, 20), node("b", 10, 60)]);
  point(place(-10, 20), 27.68, 27.68);
  point(place(10, 60), 72.32, 72.32);
});

test("three locations retain compact extrema and interpolate the middle", () => {
  const place = projector([node("a", -10, 20), node("b", 0, 30), node("c", 10, 60)]);
  point(place(-10, 20), 27.68, 27.68);
  point(place(0, 30), 50, 38.84);
  point(place(10, 60), 72.32, 72.32);
});

test("four locations fill the inset and interpolate ordinary finite coordinates", () => {
  const place = projector([node("a", -10, 20), node("b", -5, 30), node("c", 0, 40), node("d", 10, 60)]);
  point(place(-10, 20), 14, 14);
  point(place(-5, 30), 32, 32);
  point(place(0, 40), 50, 50);
  point(place(10, 60), 86, 86);
});

test("ordinary inset and spread arguments retain their geometry", () => {
  const place = projector([node("a", 0, 0), node("b", 10, 10)], 20, 0.5);
  point(place(0, 0), 35, 35);
  point(place(10, 10), 65, 65);
});

// Invalid bounds must not move valid pins, and the invalid pin must retain its valid axis.
for (const invalid of [NaN, Infinity, -Infinity]) {
  test(`invalid x ${invalid} centers its axis without poisoning valid locations or y`, () => {
    const place = projector([node("a", 0, 0), node("b", 10, 10), node("c", invalid, 5)]);
    point(place(0, 0), 27.68, 27.68);
    point(place(10, 10), 72.32, 72.32);
    point(place(invalid, 5), 50, 50);
    point(place(invalid, 0), 50, 27.68);
  });

  test(`invalid y ${invalid} centers its axis without poisoning valid locations or x`, () => {
    const place = projector([node("a", 0, 0), node("b", 10, 10), node("c", 5, invalid)]);
    point(place(0, 0), 27.68, 27.68);
    point(place(10, 10), 72.32, 72.32);
    point(place(5, invalid), 50, 50);
    point(place(0, invalid), 27.68, 50);
  });
}

test("an entirely invalid axis centers while the valid axis keeps its full four-pin range", () => {
  const place = projector([
    node("a", NaN, 0), node("b", Infinity, 10), node("c", -Infinity, 20), node("d", NaN, 30),
  ]);
  point(place(NaN, 0), 50, 14);
  point(place(Infinity, 10), 50, 38);
  point(place(-Infinity, 20), 50, 62);
  point(place(NaN, 30), 50, 86);
});

test("invalid query coordinates center independently even when all bounds are finite", () => {
  const place = projector([node("a", 0, 0), node("b", 10, 10)]);
  point(place(NaN, 0), 50, 27.68);
  point(place(10, Infinity), 72.32, 50);
  point(place(-Infinity, NaN), 50, 50);
});

test("graph helpers preserve frozen caller data and return original visible nodes and edge endpoints", () => {
  const nodes = [
    { id: "a", name: "Площадь", x: NaN, y: 0, discovered: true, connectedTo: ["b", "b", "a", "missing"] },
    { id: "b", name: "Башня", x: 10, y: 10, discovered: true, connectedTo: ["a"] },
    { id: "hidden", name: "Секрет", x: 5, y: 5, discovered: false, connectedTo: [] },
  ];
  const before = structuredClone(nodes);
  for (const location of nodes) {
    Object.freeze(location.connectedTo);
    Object.freeze(location);
  }
  Object.freeze(nodes);
  const visible = visibleMapLocations(nodes);
  assert.deepEqual(visible.map((location) => location.id), ["a", "b"]);
  assert.equal(visible[0], nodes[0]);
  assert.equal(visible[1], nodes[1]);
  const edges = mapEdges(visible);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].a, nodes[0]);
  assert.equal(edges[0].b, nodes[1]);
  const place = projector(visible);
  place(nodes[0].x, nodes[0].y);
  place(nodes[1].x, nodes[1].y);
  assert.deepEqual(nodes, before);
});
