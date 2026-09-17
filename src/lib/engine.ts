// ── Офлайн-движок процедурной генерации (работает без ключей) ──
// Богатые шаблоны + d20 + состояние мира. Live Gemini (если ключи есть) — поверх этого.

import { rollD20, dcFor, statModifier } from "./dice";

export type EngineInput = {
  playerAction: string;
  character: { name: string; archetype: string; stats: Record<string, number>; hp: number; maxHp: number };
  world: { worldName: string; currentLocation: string; mainQuest: string; danger: number; chapter: number };
  turnCount: number;
  memoryDigest: string;
  scenarioTitle: string;
};

export type EngineOutput = {
  narration: string;
  choices: string[];
  dice: { d20: number; modifier: number; total: number; dc: number; success: boolean; critical: string | null; skill: string; label: string } | null;
  effects: { hp: number; xp: number; gold: number; dangerDelta: number };
  loot: { name: string; kind: string; description: string; icon: string }[];
  locationChange: string | null;
  flags: Record<string, string | number | boolean>;
};

const BEATS = [
  "Тень движется раньше звука. ",
  "Воздух густеет — что-то наблюдает. ",
  "Где-то рядом скрипит то, чему скрипеть не положено. ",
  "Запах озона и старой бумаги. ",
  "Тишина становится слишком громкой. ",
];

const TWISTS = [
  "Незнакомец в плаще делает шаг вперёд и произносит твоё имя — верно, до последней буквы.",
  "На земле — свежий след, ведущий в две стороны одновременно.",
  "Из темноты доносится смех, который ты уже слышал — во сне.",
  "Старая карта в твоём кармане теплеет, и на ней проступает новая метка.",
  "Колокол бьёт один раз. Все вокруг замирают — кроме тебя.",
  "Твой амулет (или то, что ты считал амулетом) начинает тикать.",
];

const SUCCESS_TAILS = [
  "Ты выходишь из переделки с трофеем и историей, которую будут пересказывать.",
  "Риск окупается: удача любит тех, кто действует быстро и думает ещё быстрее.",
  "Мир словно кивает тебе — так держать.",
];

const FAIL_TAILS = [
  "Цена ошибки — боль и урок. Ты утираешь кровь и запоминаешь этот момент.",
  "Не всё идёт по плану, но отступление — тоже тактика.",
  "Ты теряешь преимущество, но не надежду: следующий ход будет точнее.",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function detectSkill(action: string): { skill: string; stat: string } {
  const a = action.toLowerCase();
  if (/атак|удар|сраж|выстрел|клинок|меч|кинжал|в бой|напада/.test(a)) return { skill: "Ближний бой", stat: "СИЛ" };
  if (/скрыт|крад|незаметно|тихо|украдк|прослед|засад/.test(a)) return { skill: "Скрытность", stat: "ЛОВ" };
  if (/убед|переговор|дипломат|уговори|обая/.test(a)) return { skill: "Убеждение", stat: "ХАР" };
  if (/обман|солг|притвор|афер/.test(a)) return { skill: "Обман", stat: "ХАР" };
  if (/осмотр|найт|ищи|след|замет/.test(a)) return { skill: "Восприятие", stat: "МУД" };
  if (/маги|заклин|колд/.test(a)) return { skill: "Магия", stat: "ИНТ" };
  if (/взлом|замок|ловушк/.test(a)) return { skill: "Ловкость рук", stat: "ЛОВ" };
  if (/леч|перевяз|зелье/.test(a)) return { skill: "Медицина", stat: "МУД" };
  if (/бег|прыг|лаз|акробат/.test(a)) return { skill: "Акробатика", stat: "ЛОВ" };
  if (/запуг|угрож/.test(a)) return { skill: "Запугивание", stat: "ХАР" };
  if (/история|знани|анализ|изуч/.test(a)) return { skill: "Анализ", stat: "ИНТ" };
  return { skill: "Выживание", stat: "ВЫН" };
}

const LOOT_POOL = [
  { name: "Зелье берёзового света", kind: "consumable", description: "Восстанавливает 25 HP, пахнет весной.", icon: "🧪" },
  { name: "Кинжал шёпота", kind: "weapon", description: "+2 к Скрытности, иногда подсказывает.", icon: "🗡️" },
  { name: "Карта второго дна", kind: "quest", description: "Показывает скрытый проход в текущей локации.", icon: "🗺️" },
  { name: "Монета с двумя орлами", kind: "misc", description: "Всегда падает нужной стороной. Почти.", icon: "🪙" },
  { name: "Плащ из тумана", kind: "armor", description: "+1 к уклонению в темноте.", icon: "🧥" },
  { name: "Свиток «Тихий шаг»", kind: "spell", description: "Одноразовое заклятие бесшумности.", icon: "📜" },
];

export function runOfflineEngine(input: EngineInput): EngineOutput {
  const { skill, stat } = detectSkill(input.playerAction);
  const statScore = input.character.stats[stat] ?? 11;
  const mod = statModifier(statScore);
  const dc = dcFor(input.world.danger, input.turnCount);
  const risky = /атак|риск|прыг|взлом|маги|бой|украд|проник|погон|ловушк|яд|огонь|демон|бой/i.test(input.playerAction);
  const dice = risky || Math.random() < 0.45 ? { ...rollD20(skill, mod, dc) } : null;

  let narration = `${pick(BEATS)}Ты — ${input.character.name}, ${input.character.archetype}. Твоё решение — «${input.playerAction}» — меняет воздух вокруг. `;
  if (dice) {
    narration += `Проверка: **${skill}** (d20=${dice.d20}${dice.modifier >= 0 ? "+" : ""}${dice.modifier}, DC ${dice.dc}) — ${dice.success ? "**успех**" : "**неудача**"}${dice.critical === "crit" ? " КРИТИЧЕСКИЙ УСПЕХ! Легенды слагают песни о таких бросках." : dice.critical === "fumble" ? " Критическая неудача: кости сегодня жестоки." : ""} `;
  }
  if (!dice || dice.success) {
    narration += `${pick(SUCCESS_TAILS)} ${pick(TWISTS)} `;
    narration += `Отголосок главного квеста — «${input.world.mainQuest}» — становится чуть ближе: в ${input.world.currentLocation} открывается новая нить.`;
  } else {
    narration += `${pick(FAIL_TAILS)} ${pick(TWISTS)} `;
    narration += `Ты отступаешь на шаг, тяжело дыша. ${input.world.currentLocation} запоминает твою ошибку — и ждёт реванша.`;
  }

  const success = !dice || dice.success;
  const crit = dice?.critical === "crit";
  const fumble = dice?.critical === "fumble";
  const hp = fumble ? -12 - Math.floor(Math.random() * 8) : dice && !dice.success ? -4 - Math.floor(Math.random() * 6) : crit ? 6 : 0;
  const xp = crit ? 60 : success ? 25 + Math.floor(Math.random() * 20) : 10;
  const gold = success && Math.random() < 0.4 ? 5 + Math.floor(Math.random() * 25) : 0;
  const dangerDelta = success ? -3 : 5;

  const loot = success && Math.random() < (crit ? 0.9 : 0.3) ? [pick(LOOT_POOL)] : [];
  const locationChange: string | null = null; // офлайн не телепортирует без причины

  const a = input.playerAction.slice(0, 60);
  const choices = [
    `Осмотреть последствия «${a}» и обыскать округу`,
    dice && !dice.success ? "Перегруппироваться: перевязать раны и сменить тактику" : "Надавить на успех: развить преимущество",
    "Заговорить с ближайшим NPC — информация дороже золота",
  ];

  return {
    narration,
    choices,
    dice: dice as EngineOutput["dice"],
    effects: { hp, xp, gold, dangerDelta },
    loot,
    locationChange,
    flags: success ? { [`turn_${input.turnCount}_success`]: true } : { [`turn_${input.turnCount}_setback`]: "wound" },
  };
}

export function openingChoices(mainQuest: string): string[] {
  return [
    "Осмотреться и собрать информацию",
    "Двигаться к цели квеста напрямую",
    "Найти союзника: поговорить с местными",
  ];
}
