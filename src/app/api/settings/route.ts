import { readJsonObject, httpError, HttpError } from "@/lib/http";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { aiSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { MODEL_CATALOG, ROUTING_PROFILES, RoutingProfile } from "@/lib/gemini";
import { getRawSettingsRow, prepareGeminiKeysWrite } from "@/lib/ai-settings";
import { decodeGeminiSecrets } from "@/lib/secret-vault";
import { withIdentityWork } from "@/lib/owner-work";
import { currentIdentity } from "@/lib/identity";
import { settingsView } from "@/lib/settings-view";

export const dynamic = "force-dynamic";

const MAX_KEYS = 10;
const KNOWN_MODELS = new Set<string>(MODEL_CATALOG.map((m) => m.id));

async function handleGET() {
  try {
    return NextResponse.json(settingsView(await getRawSettingsRow()));
  } catch (err) {
    return httpError(err);
  }
}

async function handlePOST(req: Request) {
  try {
    const body = await readJsonObject(req, 16384);
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Некорректные настройки" }, { status: 400 });
    if (body.embeddingModel && body.embeddingModel !== "gemini-embedding-2") return NextResponse.json({ error: "Поддерживается только gemini-embedding-2" }, { status: 400 });
    const initial = await getRawSettingsRow();
    const geminiKeyOperation = typeof body.keysText === "string" || Array.isArray(body.removeIndex) || body.clearKeys === true;
    const write = async (s: typeof initial, writer: Pick<typeof db, "update">) => {
      const currentKeys = ((s.keys as string[]) ?? []).filter(Boolean);

      let keys = currentKeys;
      const writesNewKeys = typeof body.keysText === "string" && body.clearKeys !== true;
      if (writesNewKeys) {
        const keysText = body.keysText as string;
        const parsed = keysText.split(/[\n,;\s]+/).map((k: string) => k.trim()).filter((k: string) => k.length > 10);
        // Only merging needs the old plaintext. Replacement/clear/removal must work
        // even when an old credential can no longer be opened.
        keys = body.append === false ? parsed : [...new Set([...((decodeGeminiSecrets(s).keys ?? []).filter(Boolean)), ...parsed])];
      }
      const removeIndex = body.removeIndex;
      if (Array.isArray(removeIndex)) keys = keys.filter((_, i) => !removeIndex.includes(i));
      if (body.clearKeys === true) keys = [];
      keys = keys.slice(0, MAX_KEYS); // DATA-1d: лимит ключей во всех путях

      const requestedProfile = typeof body.routingProfile === "string" ? body.routingProfile : "";
      const profile: RoutingProfile = Object.prototype.hasOwnProperty.call(ROUTING_PROFILES, requestedProfile) ? requestedProfile as RoutingProfile : ((s.routingProfile as RoutingProfile) ?? "balanced");
      const pickModel = (v: unknown, cur: string) => (typeof v === "string" && KNOWN_MODELS.has(v) ? v : cur);
      let narrationModel = pickModel(body.narrationModel, s.narrationModel);
      let customActionModel = pickModel(body.customActionModel, s.customActionModel);
      let compactionModel = pickModel(body.compactionModel, s.compactionModel);
      let fastTaskModel = pickModel(body.fastTaskModel, s.fastTaskModel);
      if (body.routingProfile && profile !== "custom") {
        const pConf = ROUTING_PROFILES[profile].config;
        narrationModel = pConf.narrationModel;
        customActionModel = pConf.customActionModel;
        compactionModel = pConf.compactionModel;
        fastTaskModel = pConf.fastTaskModel;
      }
      const intIn = (v: unknown, lo: number, hi: number, cur: number) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : cur);
      const boolIn = (v: unknown, cur: boolean) => (typeof v === "boolean" ? v : cur);
      // Readiness is derived separately. Replacing/removing a credential must never
      // erase the user's narrator preference (including an intentional off state).
      const useLiveAI = boolIn(body.useLiveAI, s.useLiveAI);
      const embeddingDims = intIn(body.embeddingDims, 128, 3072, s.embeddingDims);
      const embeddingModel = "gemini-embedding-2";

      const [saved] = await writer
        .update(aiSettings)
        .set({
          // This endpoint receives partial drafts. Omitted fields must retain the
          // committed row, including connections saved concurrently in another tab.
          ...(geminiKeyOperation ? { keys: writesNewKeys ? prepareGeminiKeysWrite(s.id, keys) : keys } : {}),
          ...(body.routingProfile !== undefined ? { routingProfile: profile } : {}),
          ...(body.narrationModel !== undefined || body.routingProfile ? { narrationModel } : {}),
          ...(body.customActionModel !== undefined || body.routingProfile ? { customActionModel } : {}),
          ...(body.compactionModel !== undefined || body.routingProfile ? { compactionModel } : {}),
          ...(body.fastTaskModel !== undefined || body.routingProfile ? { fastTaskModel } : {}),
          ...(body.useLiveAI !== undefined ? { useLiveAI } : {}),
          ...(body.dailyFlashLimit !== undefined ? { dailyFlashLimit: intIn(body.dailyFlashLimit, 0, 100000, s.dailyFlashLimit) } : {}),
          ...(body.dailyLiteLimit !== undefined ? { dailyLiteLimit: intIn(body.dailyLiteLimit, 0, 1000000, s.dailyLiteLimit) } : {}),
          ...(body.dailyEmbeddingLimit !== undefined ? { dailyEmbeddingLimit: intIn(body.dailyEmbeddingLimit, 0, 1000000, s.dailyEmbeddingLimit) } : {}),
          ...(body.keysSharedProject !== undefined ? { keysSharedProject: boolIn(body.keysSharedProject, s.keysSharedProject) } : {}),
          ...(body.enforceLimits !== undefined ? { enforceLimits: boolIn(body.enforceLimits, s.enforceLimits) } : {}),
          ...(body.embeddingsEnabled !== undefined ? { embeddingsEnabled: boolIn(body.embeddingsEnabled, s.embeddingsEnabled) } : {}),
          ...(body.embeddingModel !== undefined ? { embeddingModel } : {}),
          ...(body.embeddingDims !== undefined ? { embeddingDims } : {}),
          ...(body.semanticExtractionEnabled !== undefined ? { semanticExtractionEnabled: boolIn(body.semanticExtractionEnabled, s.semanticExtractionEnabled) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(aiSettings.id, s.id)).returning();
      if (!saved) throw new HttpError(409, "SETTINGS_CHANGED", "Настройки изменились во время сохранения. Повторите попытку.");
      return saved;
    };
    // Append/removal depend on the committed key list. Lock before reading it;
    // every competing UPDATE (connections, rotation or another settings save)
    // shares PostgreSQL's row lock, so deleted keys cannot be resurrected or
    // newer keys discarded by this request's preliminary settings snapshot.
    const saved = geminiKeyOperation ? await db.transaction(async tx => {
      const [current] = await tx.select().from(aiSettings).where(eq(aiSettings.id, initial.id)).for("update");
      if (!current) throw new HttpError(409, "SETTINGS_CHANGED", "Настройки изменились во время сохранения. Повторите попытку.");
      if (Array.isArray(body.removeIndex) && JSON.stringify(current.keys) !== JSON.stringify(initial.keys)) {
        throw new HttpError(409, "SETTINGS_CHANGED", "Список ключей изменился. Обновите настройки перед удалением ключа.");
      }
      return write(current, tx);
    }) : await write(initial, db);

    // RETURNING replaces the canonical row read, not its final revocation fence.
    await currentIdentity();
    return NextResponse.json({ ok: true, ...settingsView(saved) });
  } catch (err) {
    return httpError(err);
  }
}

export const GET = withIdentityWork(handleGET);
export const POST = withIdentityWork(handlePOST);
