import { loadTextModelCatalog } from "@/lib/text-model-catalog";

export const dynamic = "force-dynamic";

/** The upstream catalog is public metadata; no settings, identities or keys are read. */
export async function GET(request: Request) {
  const provider = new URL(request.url).searchParams.get("provider");
  if (provider !== "openrouter" && provider !== "pollinations") return Response.json({ error: "Укажите OpenRouter или Pollinations." }, { status: 400 });
  try {
    return Response.json({ models: await loadTextModelCatalog(provider) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Не удалось загрузить каталог моделей. Укажите ID модели вручную." }, { status: 502 });
  }
}
