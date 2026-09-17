// ── Офлайн-движок ТОЛЬКО для preset-кампаний (ARCH-1d) ──
// Детерминированный процедурный фолбэк, когда live AI недоступен. Free-кампании его не используют:
// они получают состояние «нужен AI» вместо псевдоадекватного шаблонного ответа.

import { rollD20, roll2d6, dcFor, statModifier } from "./dice";
import type { DiceResult } from "@/db/schema";
import { assessRisk, profileFor } from "./profiles";
import { seededRandom } from "./rng";

export type EngineInput = {
  playerAction: string;
  isFreeAction: boolean;
  /** Reuse the authoritative check; never roll twice for a single action. */
  resolvedDice?: DiceResult | null;
  rulesProfile: string;
  character: { name: string; archetype: string; stats: Record<string, number>; hp: number; maxHp: number };
  world: { worldName: string; currentLocation: string; mainQuest: string; danger: number; chapter: number; tone: string };
  turnCount: number;
  scenarioTitle: string;
  lootPool?: { name: string; kind: string; description: string; icon: string }[];
};

export type EngineOutput = {
  narration: string;
  choices: string[];
  dice: DiceResult | null;
  effects: { hp: number; xp: number; gold: number; danger: number };
  loot: { name: string; kind: string; description: string; icon: string }[];
  conditions: { add: string[]; remove: string[] };
};

const BEATS = [
  "Тишина становится слишком плотной. ",
  "Что-то в сцене сдвигается — едва заметно, но бесповоротно. ",
  "Воздух будто ждёт твоего следующего шага. ",
  "Мелкая деталь, на которую ты не обращал внимания, вдруг становится важной. ",
];
const SUCCESS_TAILS = [
  "Риск окупается: ты получаешь преимущество и время подумать.",
  "Ситуация поддаётся — не до конца, но достаточно, чтобы двигаться дальше.",
  "Ты добиваешься своего, и мир вокруг это замечает.",
];
const COST_TAILS = [
  "Ты добиваешься цели, но цена оказывается выше, чем хотелось.",
  "Получилось — с осложнением, которое ещё напомнит о себе.",
];
const FAIL_TAILS = [
  "Не всё идёт по плану: ты теряешь инициативу, но не надежду.",
  "Цена ошибки — время и уязвимость. Ты запоминаешь этот момент.",
  "Отступление — тоже тактика. Следующий ход должен быть точнее.",
];

function pick<T>(arr: T[], random: () => number): T {
  return arr[Math.floor(random() * arr.length)];
}

export function detectSkill(action: string): { skill: string; stat: string } {
  const a = action.toLowerCase();
  if (/атак|удар|сраж|выстрел|клинок|меч|кинжал|в бой|напада|драк/.test(a)) return { skill: "Ближний бой", stat: "СИЛ" };
  if (/скрыт|крад|незаметно|тихо|украдк|прослед|засад/.test(a)) return { skill: "Скрытность", stat: "ЛОВ" };
  if (/убед|переговор|дипломат|уговори|обая|торг/.test(a)) return { skill: "Убеждение", stat: "ХАР" };
  if (/обман|солг|притвор|афер|блеф/.test(a)) return { skill: "Обман", stat: "ХАР" };
  if (/осмотр|найт|ищи|след|замет|обыск/.test(a)) return { skill: "Восприятие", stat: "МУД" };
  if (/маги|заклин|колд|ритуал/.test(a)) return { skill: "Магия", stat: "ИНТ" };
  if (/взлом|замок|ловушк|хак|код/.test(a)) return { skill: "Взлом", stat: "ЛОВ" };
  if (/леч|перевяз|аптеч|медиц/.test(a)) return { skill: "Медицина", stat: "МУД" };
  if (/бег|прыг|лаз|акробат|уверн/.test(a)) return { skill: "Акробатика", stat: "ЛОВ" };
  if (/запуг|угрож|давл/.test(a)) return { skill: "Запугивание", stat: "ХАР" };
  if (/история|знани|анализ|изуч|вспомн|расчёт|прочит/.test(a)) return { skill: "Анализ", stat: "ИНТ" };
  if (/чини|ремонт|собр|настро|механ/.test(a)) return { skill: "Ремесло", stat: "ИНТ" };
  return { skill: "Выживание", stat: "ВЫН" };
}

/** Серверная проверка по профилю — общая для live и offline путей (ARCH-1f). */
export function serverCheck(input: { rulesProfile: string; playerAction: string; stats: Record<string, number>; danger: number; turnCount: number }): DiceResult | null {
  const spec = profileFor(input.rulesProfile);
  if (spec.check === "none") return null;
  if (spec.check === "2d6") {
    const risk = assessRisk(input.playerAction, input.danger);
    if (risk === "safe") return null;
    return roll2d6(risk === "desperate" ? "Отчаянный риск" : "Риск", risk === "desperate" ? -1 : 0);
  }
  const { skill, stat } = detectSkill(input.playerAction);
  const mod = statModifier(input.stats[stat] ?? 11);
  return rollD20(skill, mod, dcFor(input.danger, input.turnCount));
}

export function runOfflineEngine(input: EngineInput): EngineOutput {
  const spec = profileFor(input.rulesProfile);
  const dice = input.resolvedDice !== undefined ? input.resolvedDice : input.isFreeAction
    ? serverCheck({ rulesProfile: input.rulesProfile, playerAction: input.playerAction, stats: input.character.stats, danger: input.world.danger, turnCount: input.turnCount })
    : null;

  const random = seededRandom(`${input.scenarioTitle}|${input.world.worldName}|${input.turnCount}|${input.playerAction}|${JSON.stringify(dice)}`);
  const band = dice ? dice.band ?? (dice.success ? "full" : "fail") : "full";
  let narration = `${pick(BEATS, random)}Ты — ${input.character.name}, ${input.character.archetype}. Твоё решение — «${input.playerAction}» — меняет расклад в «${input.world.currentLocation}». `;
  if (band === "full") narration += `${pick(SUCCESS_TAILS, random)} Нить главной цели — «${input.world.mainQuest}» — становится чуть ближе.`;
  else if (band === "cost") narration += `${pick(COST_TAILS, random)} «${input.world.mainQuest}» по-прежнему впереди, но путь стал дороже.`;
  else narration += `${pick(FAIL_TAILS, random)} ${input.world.currentLocation} запоминает твою ошибку.`;
  narration += ` (Автономный режим пресета: подключите ключи Gemini для живого повествования.)`;

  const crit = dice?.critical === "crit";
  const fumble = dice?.critical === "fumble";
  const hp = !spec.resources.hp ? 0 : fumble ? -8 - Math.floor(random() * 6) : band === "fail" ? -3 - Math.floor(random() * 5) : band === "cost" ? -2 : crit ? 4 : 0;
  const xp = !spec.resources.xp ? 0 : crit ? 50 : band === "full" ? 20 + Math.floor(random() * 15) : band === "cost" ? 15 : 8;
  const gold = !spec.resources.gold ? 0 : band === "full" && random() < 0.35 ? 5 + Math.floor(random() * 20) : 0;
  const danger = band === "fail" ? 5 : band === "cost" ? 1 : -3;
  const loot = band === "full" && input.lootPool?.length && random() < (crit ? 0.9 : 0.25) ? [pick(input.lootPool, random)] : [];
  const conditions = { add: [] as string[], remove: [] as string[] };
  if (band === "fail" && spec.resources.conditions) conditions.add.push(fumble ? "серьёзно ранен" : "потрясён");
  if (band === "full" && spec.resources.conditions) conditions.remove.push("потрясён");

  const a = input.playerAction.slice(0, 60);
  const choices = [
    `Осмотреть последствия «${a}» и изучить окружение`,
    band === "fail" ? "Перегруппироваться и сменить подход" : "Развить преимущество, пока оно есть",
    "Заговорить с ближайшим персонажем — информация дороже всего",
  ];
  return { narration, choices, dice, effects: { hp, xp, gold, danger }, loot, conditions };
}

export function openingChoices(): string[] {
  return ["Осмотреться и собрать информацию", "Двигаться к цели напрямую", "Найти союзника: поговорить с местными"];
}
