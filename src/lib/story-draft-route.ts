import { readJsonObject } from "./http";
import { StoryDraftError, type StoryDraftPatch } from "./story-draft";

type Autofill = (draft: unknown, signal?: AbortSignal) => Promise<{ patch: StoryDraftPatch; modelUsed: string }>;

export async function handleStoryDraftAutofillRequest(request: Request, autofill: Autofill, timeoutMs = 30_000): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    const operation = async () => {
      controller.signal.throwIfAborted();
      const body = await readJsonObject(request, 16_384);
      controller.signal.throwIfAborted();
      return autofill(body.draft, controller.signal);
    };
    const expired = new Promise<never>((_, reject) => {
      const fail = () => reject(new StoryDraftError("AI_FAILED", "Заполнение прервано или превысило 30 секунд.", 504));
      if (controller.signal.aborted) fail();
      else controller.signal.addEventListener("abort", fail, { once: true });
    });
    const result = await Promise.race([operation(), expired]);
    return Response.json(result);
  } catch (error) {
    if (error instanceof StoryDraftError) {
      return Response.json({ ok: false, code: error.code, message: error.message }, { status: error.status });
    }
    const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 500;
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "INTERNAL";
    const message = status < 500 && error instanceof Error ? error.message : "Не удалось заполнить черновик.";
    return Response.json({ ok: false, code, message }, { status });
  } finally { clearTimeout(timer); request.signal.removeEventListener("abort", abort); }
}
