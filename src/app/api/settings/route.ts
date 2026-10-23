import { readJsonObject, httpError } from "@/lib/http";
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
    const s = decodeGeminiSecrets(await getRawSettingsRow());
    const currentKeys = ((s.keys as string[]) ?? []).filter(Boolean);

    let keys = currentKeys;
    if (typeof body.keysText === "string") {
      const parsed = body.keysText.split(/[\n,;\s]+/).map((k: string) => k.trim()).filter((k: string) => k.length > 10);
      keys = body.append === false ? parsed : [...new Set([...currentKeys, ...parsed])];
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
    const geminiKeyOperation = typeof body.keysText === "string" || Array.isArray(body.removeIndex) || body.clearKeys === true;
    const selectedCredentialCount = s.textProvider === "openrouter" ? Number(Boolean(s.openrouterKey)) : s.textProvider === "pollinations" ? Number(Boolean(s.pollinationsKey)) : keys.length;
    // A missing connection affects readiness, not the saved narrator preference on unrelated writes.
    // Explicit Live changes and the legacy Gemini key controls retain their credential guards.
    const useLiveAI = body.useLiveAI === undefined && !geminiKeyOperation ? s.useLiveAI : boolInAuto(body.useLiveAI, s.useLiveAI, selectedCredentialCount);
    const embeddingDims = intIn(body.embeddingDims, 128, 3072, s.embeddingDims);
    const embeddingModel = "gemini-embedding-2";

    const [saved] = await db
      .update(aiSettings)
      .set({
        // This endpoint receives partial drafts. Omitted fields must retain the
        // committed row, including connections saved concurrently in another tab.
        ...(geminiKeyOperation ? { keys: prepareGeminiKeysWrite(s.id, keys) } : {}),
        ...(body.routingProfile !== undefined ? { routingProfile: profile } : {}),
        ...(body.narrationModel !== undefined || body.routingProfile ? { narrationModel } : {}),
        ...(body.customActionModel !== undefined || body.routingProfile ? { customActionModel } : {}),
        ...(body.compactionModel !== undefined || body.routingProfile ? { compactionModel } : {}),
        ...(body.fastTaskModel !== undefined || body.routingProfile ? { fastTaskModel } : {}),
        ...(body.useLiveAI !== undefined || geminiKeyOperation ? { useLiveAI } : {}),
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

    // RETURNING replaces the canonical row read, not its final revocation fence.
    await currentIdentity();
    return NextResponse.json({ ok: true, ...settingsView(saved) });
  } catch (err) {
    return httpError(err);
  }
}

/** Live нельзя включить без ключей; при удалении всех ключей — выключаем автоматически. */
function boolInAuto(v: unknown, cur: boolean, totalKeys: number) {
  const next = typeof v === "boolean" ? v : cur;
  return totalKeys > 0 ? next : false;
}
export const GET = withIdentityWork(handleGET);
export const POST = withIdentityWork(handlePOST);
