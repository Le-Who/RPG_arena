import test from "node:test";
import assert from "node:assert/strict";
import { buildVisualPrompt, MAX_VISUAL_PROMPT_LENGTH, styleFor, type PromptInput } from "../src/lib/visual-provider";

const world = { worldName: "Северная провинция", era: "Конец девятнадцатого века", tone: "Готическая драма, сдержанная меланхолия", currentLocation: "Старая библиотека" };
const portrait: PromptInput = { kind: "portrait", world, subjectName: "Пупсик Хихика", passport: "Взрослый архивист, седые волосы, тёмное суконное пальто" };

test("a funny character name keeps its established appearance and the gothic story's visual tone", () => {
  const prompt = buildVisualPrompt(portrait);
  assert.ok(prompt.includes("Пупсик Хихика"));
  assert.ok(prompt.includes("седые волосы, тёмное суконное пальто"));
  assert.ok(prompt.includes(world.tone));
  assert.match(prompt, /dark|gothic/i);
  assert.match(prompt, /names[^.]+(?:mood|costume)/i);
  assert.doesNotMatch(prompt, /comedic|clown|jester|клоун|шутовск/i);
});

test("comedic storytelling adds comic staging without changing the same character's identity", () => {
  const prompt = buildVisualPrompt({ ...portrait, world: { ...world, tone: "Добрая комедия с ироничным юмором" } });
  assert.ok(prompt.includes(portrait.subjectName));
  assert.ok(prompt.includes(portrait.passport));
  assert.match(prompt, /comedic|visual humor/i);
  assert.ok(prompt.includes("Добрая комедия с ироничным юмором"));
  assert.doesNotMatch(prompt, /clown|jester|клоун|шутовск/i);
});

test("mixed gothic and comedic tones remain present together instead of using the first keyword only", () => {
  const prompt = buildVisualPrompt({ ...portrait, world: { ...world, tone: "Готическая комедия с мягким юмором" } });
  assert.match(prompt, /dark|gothic/i);
  assert.match(prompt, /comedic|visual humor/i);
  assert.ok(prompt.includes("Готическая комедия с мягким юмором"));
});

test("a dark science-fiction tone does not invent a gothic setting", () => {
  const style = styleFor("Мрачная научная фантастика", "Дальняя станция");
  assert.match(style, /dark/i);
  assert.match(style, /science-fiction/i);
  assert.doesNotMatch(style, /gothic|fantasy/i);
});

test("an unspecified visual style is neutral and names do not select a genre", () => {
  const neutral = styleFor("", "Неоновый гном Шутник");
  assert.match(neutral, /neutral|context/i);
  assert.doesNotMatch(neutral, /fantasy|cyberpunk|comedic|noir/i);
  const prompt = buildVisualPrompt({ ...portrait, world: { ...world, tone: "Тихий вечер друзей" } });
  assert.doesNotMatch(prompt, /fantasy/i);
  assert.ok(prompt.includes("Тихий вечер друзей"));
});

test("explicitly excluded genres and moods never become inferred visual directions", () => {
  for (const tone of ["Серьёзная история, без юмора/комедии", "Повседневная история без фэнтези", "Serious story, not comedy or fantasy"]) {
    const style = styleFor(tone, "Город");
    assert.match(style, /neutral|context/i);
    assert.doesNotMatch(style, /comedic|fantasy|dark gothic/i);
    assert.ok(buildVisualPrompt({ ...portrait, world: { ...world, tone } }).includes(tone));
  }
});

test("legacy worlds with absent optional story fields still produce a neutral bounded prompt", () => {
  for (const kind of ["portrait", "location", "scene"] as const) {
    const prompt = buildVisualPrompt({ kind, world: { currentLocation: "Тихая площадь" } } as PromptInput);
    assert.ok(prompt.includes("Тихая площадь"));
    assert.match(prompt, /Neutral story illustration/);
    assert.doesNotMatch(prompt, /undefined|null|fantasy/);
    assert.ok(prompt.length <= MAX_VISUAL_PROMPT_LENGTH);
  }
});

test("portraits, places and scenes all retain explicit setting, tone, latest moment and narrator direction", () => {
  for (const kind of ["portrait", "location", "scene"] as const) {
    const prompt = buildVisualPrompt({
      ...portrait, kind,
      world: { ...world, narrator: { realism: "grounded", tension: "calm", note: "Обыденность важнее зрелищности" } },
      sceneNarration: "Архивист бережно разворачивает письмо у окна",
      partOfDay: "поздний вечер",
      locationDescription: "Узкие окна и дубовые книжные шкафы",
    });
    for (const context of [world.worldName, world.era, world.tone, world.currentLocation, "grounded", "calm", "Обыденность важнее зрелищности", "Архивист бережно разворачивает письмо у окна", "поздний вечер"]) assert.ok(prompt.includes(context), `${kind} retains ${context}`);
  }
});

test("an explicit visual override replaces automatic styling while retaining world and appearance facts", () => {
  const prompt = buildVisualPrompt({ ...portrait, styleOverride: "Плоская акварель, пастельные пятна" });
  assert.ok(prompt.includes("Плоская акварель, пастельные пятна"));
  assert.match(prompt, /override[^.]+(?:controls|priority)/i);
  assert.ok(prompt.includes(world.tone));
  assert.ok(prompt.includes(world.worldName));
  assert.ok(prompt.includes(portrait.passport));
  assert.doesNotMatch(prompt, /dark atmospheric illustration|dark gothic atmosphere/i);
  assert.equal(buildVisualPrompt({ ...portrait, styleOverride: "   " }), buildVisualPrompt(portrait));
});

test("field budgets retain all three core characters and setting even when optional context is oversized", () => {
  for (const kind of ["portrait", "location", "scene"] as const) {
    const prompt = buildVisualPrompt({
      ...portrait, kind,
      world: { worldName: "WORLD " + "w".repeat(5000), era: "ERA " + "e".repeat(5000), tone: "TONE " + "t".repeat(5000), currentLocation: "PLACE " + "l".repeat(5000), narrator: { realism: "heightened", tension: "balanced", note: "NOTE " + "n".repeat(5000) } },
      subjectName: "SUBJECT " + "s".repeat(5000), passport: "APPEARANCE " + "a".repeat(5000),
      styleOverride: "STYLE " + "v".repeat(5000), sceneNarration: "MOMENT " + "m".repeat(5000),
      locationDescription: "LOCATION " + "d".repeat(5000), partOfDay: "TIME " + "p".repeat(5000),
      presentPassports: ["FIRST", "SECOND", "THIRD", "FOURTH"].map(name => ({ name: name + "x".repeat(5000), passport: name + "_APPEARANCE " + "x".repeat(5000) })),
      objects: Array.from({ length: 20 }, () => "OBJECT " + "o".repeat(5000)),
    });
    assert.ok(prompt.length <= MAX_VISUAL_PROMPT_LENGTH && prompt.length <= 2200, `${kind} has ${prompt.length} characters`);
    for (const marker of ["WORLD", "ERA", "TONE", "PLACE", "STYLE", "MOMENT", "NOTE"]) assert.ok(prompt.includes(marker), `${kind} retains ${marker}`);
    if (kind === "scene") {
      for (const marker of ["FIRST_APPEARANCE", "SECOND_APPEARANCE", "THIRD_APPEARANCE"]) assert.ok(prompt.includes(marker));
      assert.ok(!prompt.includes("FOURTH"));
    } else assert.ok(prompt.includes(kind === "portrait" ? "APPEARANCE" : "LOCATION"));
    assert.match(prompt, /No text, no watermark\.$/);
  }
});

test("visual context is a bounded excerpt and does not serialize unrelated state or story history", () => {
  const input = {
    ...portrait,
    world: { ...world, privateState: "PRIVATE_STATE_SENTINEL", history: "WORLD_HISTORY_SENTINEL" },
    history: "FULL_HISTORY_SENTINEL",
    sceneNarration: "Текущий момент " + "x".repeat(1000) + "OLD_EXCERPT_TAIL_SENTINEL",
  };
  const prompt = buildVisualPrompt(input);
  assert.ok(prompt.includes("Текущий момент"));
  assert.doesNotMatch(prompt, /PRIVATE_STATE_SENTINEL|WORLD_HISTORY_SENTINEL|FULL_HISTORY_SENTINEL|OLD_EXCERPT_TAIL_SENTINEL/);
});
