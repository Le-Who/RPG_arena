import { getAIConfig, logToken, pickModels } from "@/lib/ai-settings";
import { callGeminiWithRotation } from "@/lib/gemini";
import { createStoryDraftAutofillService } from "@/lib/story-draft";
import { handleStoryDraftAutofillRequest } from "@/lib/story-draft-route";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const autofill = createStoryDraftAutofillService({
  loadConfig: getAIConfig,
  selectModels: async (config) => (await pickModels("creation", config)).models,
  generate: callGeminiWithRotation,
  log: logToken,
});

export async function POST(request: Request) {
  return handleStoryDraftAutofillRequest(request, autofill);
}
