import { getAIConfig, logToken, pickModels } from "@/lib/ai-settings";
import { callGeminiWithRotation } from "@/lib/gemini";
import { createStoryDraftAutofillService } from "@/lib/story-draft";
import { handleStoryDraftAutofillRequest } from "@/lib/story-draft-route";
import { withIdentityWork } from "@/lib/owner-work";
import { quotaAdmission } from "@/lib/quota";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const autofill = createStoryDraftAutofillService({
  loadConfig: getAIConfig,
  selectModels: async (config) => (await pickModels("creation", config)).models,
  generate: callGeminiWithRotation,
  beforeAttempt: (config, model) => quotaAdmission(config)(model),
  log: logToken,
});

async function handlePOST(request: Request) {
  return handleStoryDraftAutofillRequest(request, autofill);
}
export const POST = withIdentityWork(handlePOST);
