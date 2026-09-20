import { scopeNarrativeChecks, selectNarrativeChecks, type NarrativeCheckSelection } from "./narrative-policy";
import type { NarrativeVerification } from "./narrative-verifier";
import type { ResolutionPayload } from "./resolution";
import { parseNarrativeReview, type NarrativeReview } from "./narrative-review";

/** Count both proposals and automatic reducer consequences (including free-text flags). */
export function hasNarrativeStateChanges(
  payload: Pick<ResolutionPayload, "effects" | "stateChanges">,
  derived: Record<string, unknown> = {},
): boolean {
  const material = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.length > 0;
    if (v && typeof v === "object") return Object.values(v).some(material);
    return typeof v === "number" ? v !== 0 : v !== null && v !== undefined && v !== "" && v !== false;
  };
  return Object.keys(payload.stateChanges.flags).length > 0
    || material(payload.effects) || material(payload.stateChanges) || material(derived);
}

type Draft = { narration: string; choices: string[] };
type Audit = { selection: NarrativeCheckSelection; checkSelections: NarrativeCheckSelection[]; checks: NarrativeVerification[];
  reviews: { attempt: number; result: NarrativeReview; model: string; latencyMs: number }[]; repaired: boolean };
export type NarrativeGuardResult = ({ ok: true } & Draft & Audit) | ({ ok: false; reason: string } & Audit);

/** A repair may change only prose and choices. The resolved state is copied for every call. */
export async function guardNarrative(input: {
  action: string; narration: string; choices: string[]; declaration: unknown;
  hasDice: boolean; hasStateChanges: boolean; rejected: readonly string[];
  hasProvisionalIndependentAdds?: boolean;
  state: Record<string, unknown>; emittedPrefix: string; remainingMs: () => number;
  verify: (state: Record<string, unknown>, selection: NarrativeCheckSelection) => Promise<NarrativeVerification>;
  review?: (state: Record<string, unknown>, selection: NarrativeCheckSelection) => Promise<{ text: string; model: string; latencyMs: number } | null>;
  repair: (state: Record<string, unknown>, report: NarrativeVerification, emittedPrefix: string, review: NarrativeReview | null) => Promise<Draft | null>;
}): Promise<NarrativeGuardResult> {
  const selection = selectNarrativeChecks(input);
  const checks: NarrativeVerification[] = [];
  const audit: Audit = { selection, checkSelections: [], checks, reviews: [], repaired: false };
  const fail = (reason: string): NarrativeGuardResult => ({ ok: false, reason, ...audit });
  let draft: Draft = { narration: input.narration, choices: [...input.choices] };
  if (!draft.narration.startsWith(input.emittedPrefix)) return fail("emitted_prefix_changed");
  if (!selection.required) return { ok: true, ...draft, ...audit };
  // Preserve an independent snapshot even if a provider adapter mutates its argument.
  const fixedState = structuredClone(input.state);
  const state = () => ({ ...structuredClone(fixedState), draft: draft.narration, draft_choices: [...draft.choices] });
  for (let attempt = 0; attempt < 2; attempt++) {
    if (input.remainingMs() < 3000) return fail("deadline");
    const currentState = state();
    const currentSelection = scopeNarrativeChecks(selection, currentState);
    let report: NarrativeVerification;
    try { report = await input.verify(currentState, structuredClone(currentSelection)); }
    catch { return fail("verification_failed"); }
    checks.push(report);
    audit.checkSelections.push(currentSelection);
    if (input.remainingMs() <= 0) return fail("deadline");
    if (report.status === "unavailable" || report.status === "skipped") return fail(report.status);
    let reviewed: NarrativeReview | null = null;
    if (report.status === "uncertain" && input.review) {
      if (input.remainingMs() < 8000) return fail("deadline");
      try {
        const response = await input.review(state(), structuredClone(currentSelection));
        if (response) {
          reviewed = parseNarrativeReview(response.text, Object.keys(currentSelection.questions), state());
          if (reviewed) audit.reviews.push({ attempt, result: reviewed, model: response.model, latencyMs: response.latencyMs });
        }
      } catch { return fail("review_failed"); }
      if (input.remainingMs() <= 0) return fail("deadline");
      if (!reviewed) return fail("invalid_review");
    }
    if (input.hasProvisionalIndependentAdds) {
      const independence = report.answers.independent_acquisitions;
      const reviewedIndependence = reviewed?.answers.find(a => a.id === "independent_acquisitions")?.verdict === "consistent";
      if (!reviewedIndependence && (!independence || independence.choice !== "consistent" || independence.confidence < .8 || independence.probabilities.consistent < .9))
        return fail("independence_not_verified");
    }
    if (report.status === "verified" || reviewed?.status === "verified") return { ok: true, ...draft, ...audit };
    if (attempt || input.remainingMs() < 15000) return fail(attempt ? "repair_not_verified" : "deadline");
    let repaired: Draft | null;
    try { repaired = await input.repair(state(), structuredClone(report), input.emittedPrefix, structuredClone(reviewed)); }
    catch { return fail("repair_failed"); }
    if (!repaired || typeof repaired.narration !== "string" || !repaired.narration.trim()
      || repaired.narration.length > 12000 || !Array.isArray(repaired.choices)
      || repaired.choices.length > 3 || repaired.choices.some(c => typeof c !== "string" || c.length > 160)) return fail("invalid_repair");
    if (!repaired.narration.startsWith(input.emittedPrefix)) return fail("emitted_prefix_changed");
    draft = { narration: repaired.narration, choices: [...repaired.choices] };
    audit.repaired = true;
  }
  return fail("repair_not_verified");
}
