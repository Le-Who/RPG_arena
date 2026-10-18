import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const braces = require("../tooling/braces") as {
  (input: string | string[], options?: Record<string, unknown>): string[];
  parse(input: string): unknown;
  compile(input: unknown): string;
  expand(input: unknown, options?: Record<string, unknown>): string[];
  stringify(input: unknown): string;
};

for (const [pattern, expected] of [
  ["app-{01..03}", ["app-01", "app-02", "app-03"]],
  ["app-{1..3..2}", ["app-1", "app-3"]],
  ["a/[{a,b}]", ["a/[{a,b}]"]],
  ['a/"{a,b}"', ["a/{a,b}"]],
  ["a/{a},b}", ["a/{a},b}"]],
  ["{a,,b}", ["a", "", "b"]],
] as const) {
  test(`patched braces retains expansion grammar for ${pattern}`, () => {
    assert.deepEqual(braces(pattern, { expand: true }), [...expected]);
  });
}

test("patched braces retains default compilation and duplicate filtering", () => {
  assert.deepEqual(braces("app/{a,b}"), ["app/(a|b)"]);
  assert.deepEqual(braces(["{a,a}", "a"], { expand: true, nodupes: true }), ["a"]);
  assert.equal(braces.stringify(braces.parse("app/{a,b}")), "app/{a,b}");
});

test("patched braces retains the existing numeric range rejection", () => {
  assert.throws(() => braces.expand("{1..1001}"), /exceeds range limit/);
});

test("patched braces accepts nesting at the supported boundary", () => {
  assert.doesNotThrow(() => braces.parse("{".repeat(128) + "a,b" + "}".repeat(128)));
  assert.throws(() => braces.parse("{".repeat(129) + "a,b" + "}".repeat(129)), {
    name: "SyntaxError", code: "ERR_BRACES_DEPTH",
  });
});

test("patched braces does not count bracket or quoted literals as nesting", () => {
  const bracket = "[" + "{".repeat(200) + "]";
  assert.equal(braces.stringify(braces.parse(bracket)), bracket);
  const quoted = '"' + "(".repeat(200) + '"';
  assert.equal(braces.stringify(braces.parse(quoted)), "(".repeat(200));
});

test("caller options cannot disable the patched parser depth bound", () => {
  const input = "{".repeat(4500) + "a,b" + "}".repeat(4500);
  assert.throws(() => braces(input, { expand: true, maxDepth: Infinity }), {
    name: "SyntaxError", code: "ERR_BRACES_DEPTH",
  });
});

for (const method of ["parse", "compile", "expand", "stringify"] as const) {
  test(`patched braces ${method} rejects deeply nested input with a controlled error`, () => {
    const input = "{".repeat(4500) + "a,b" + "}".repeat(4500);
    assert.throws(() => braces[method](input), { name: "SyntaxError", code: "ERR_BRACES_DEPTH" });
  });
}

for (const method of ["compile", "expand", "stringify"] as const) {
  test(`patched braces ${method} bounds caller-supplied AST depth`, () => {
    let node: object = { type: "text", value: "a" };
    for (let index = 0; index < 4500; index++) {
      node = { type: "root", nodes: [node] };
    }
    assert.throws(() => braces[method](node), { name: "SyntaxError", code: "ERR_BRACES_DEPTH" });
  });
}

test("patched braces counts parentheses as recursive parser depth", () => {
  assert.throws(() => braces.parse("(".repeat(4500) + "a" + ")".repeat(4500)), {
    name: "SyntaxError", code: "ERR_BRACES_DEPTH",
  });
});
