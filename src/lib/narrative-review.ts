import { isDeepStrictEqual } from "node:util";
import { parseUniqueJsonObject } from "./narrative-stream";
import type { NarrativeVerdict } from "./narrative-policy";

export type NarrativeReviewAnswer = {
  id: string; verdict: NarrativeVerdict; reason: string;
  reportedVerdict?: NarrativeVerdict;
  evidence: { path: string; quote: string }[];
};
export type NarrativeReview = { status: "verified" | "rejected" | "uncertain"; answers: NarrativeReviewAnswer[] };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function citesConfirmedHistory(state: Record<string, unknown>, path: string): boolean {
  const match = /^\/historical_evidence\/(?:(sources|agreements)\/)?(0|[1-9]\d*)\//.exec(path);
  if (!match) return false;
  const history = state.historical_evidence;
  const rows = match[1] && record(history) ? history[match[1]] : history;
  if (!Array.isArray(rows)) return false;
  const source = rows[Number(match[2])];
  if (!record(source) || source.role === "player" || !["confirmed_event", "verified_narration"].includes(String(source.authority))) return false;
  const turn = source.turnNumber ?? source.turn;
  if (typeof state.currentTurn === "number" && (typeof turn !== "number" || turn >= state.currentTurn)) return false;
  return true;
}

function citesExplicitRejection(state: Record<string, unknown>, path: string): boolean {
  const match = /^\/rejected_changes\/(0|[1-9]\d*)(?:\/|$)/.exec(path);
  return !!match && Array.isArray(state.rejected_changes) && state.rejected_changes[Number(match[1])] != null;
}
function citesCurrentFact(state: Record<string, unknown>, path: string): boolean {
  return path.startsWith("/before_state/") || path.startsWith("/dice/") || path === "/accepted_outcome"
    || /^\/accepted_changes\/(?:character|world|hp|xp|gold|danger|dead|levelUp)(?:\/|$)/.test(path)
    || (Array.isArray(state.accepted_changes) && /^\/accepted_changes\/(0|[1-9]\d*)(?:\/|$)/.test(path))
    || citesExplicitRejection(state, path) || citesConfirmedHistory(state, path);
}

/** A matching citation proves its source exists, not that the source entails the verdict. */
function resolveCitation(state: Record<string, unknown>, path: unknown, quote?: unknown): { path: string; quote: string } | null {
  if (typeof path !== "string" || !path.startsWith("/") || path.length > 500 || /~(?:[^01]|$)/.test(path)) return null;
  let value: unknown = state;
  for (const token of path.slice(1).split("/")) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return null;
    value = (value as Record<string, unknown>)[key];
  }
  try {
    const resolved = quote === undefined ? (typeof value === "string" ? value : JSON.stringify(value)) : quote;
    if (typeof resolved !== "string" || !resolved.length || resolved.length > (path === "/draft" ? 12000 : 8000)) return null;
    if (typeof value === "string" && value.includes(resolved)) return { path, quote: resolved };
    return isDeepStrictEqual(value, JSON.parse(resolved)) ? { path, quote: resolved } : null;
  } catch { return null; }
}
export function matchesNarrativeCitation(state: Record<string, unknown>, path: unknown, quote: unknown): boolean {
  return typeof quote === "string" && resolveCitation(state, path, quote) !== null;
}

/** Validate the optional review against the exact frozen draft and selected checks. */
export function parseNarrativeReview(text: string, ids: readonly string[], state: Record<string, unknown>): NarrativeReview | null {
  if (!ids.length || ids.length > 12 || new Set(ids).size !== ids.length) return null;
  const parsed = parseUniqueJsonObject(text);
  if (!parsed || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.answers) || parsed.answers.length !== ids.length) return null;
  const answers: NarrativeReviewAnswer[] = [], seen = new Set<string>();
  let citedCharacters = 0;
  const citedValues = new Set<string>();
  for (const a of parsed.answers) {
    if (!record(a) || Object.keys(a).length !== 4 || typeof a.id !== "string" || !ids.includes(a.id) || seen.has(a.id)
      || !["consistent", "contradicts", "insufficient"].includes(String(a.verdict))
      || typeof a.reason !== "string" || !a.reason.trim() || a.reason.length > 1500
      || !Array.isArray(a.evidence) || !a.evidence.length || a.evidence.length > 12) return null;
    const evidence: NarrativeReviewAnswer["evidence"] = [];
    for (const e of a.evidence) {
      if (!record(e) || !Object.hasOwn(e, "path") || Object.keys(e).some(k => k !== "path" && k !== "quote")) return null;
      const citation = resolveCitation(state, e.path, e.quote);
      if (!citation) return null;
      const identity = JSON.stringify([citation.path, citation.quote]);
      if (!citedValues.has(identity)) {
        citedCharacters += citation.quote.length;
        citedValues.add(identity);
      }
      if (citedCharacters > 32000) return null;
      evidence.push(citation);
    }
    seen.add(a.id);
    const answer = { ...a, evidence } as NarrativeReviewAnswer;
    // Missing historical proof is not evidence of the opposite. Preserve the model's original verdict for audit.
    if (answer.id.startsWith("history_") && answer.verdict === "contradicts"
      && !answer.evidence.some(e => citesConfirmedHistory(state, e.path)))
      answers.push({ ...answer, reportedVerdict: answer.verdict, verdict: "insufficient" });
    else if (answer.verdict === "contradicts" && ((answer.id === "accepted_state" && !answer.evidence.some(e => citesCurrentFact(state, e.path)))
      || (answer.id === "unlisted_events" && !answer.evidence.some(e => citesExplicitRejection(state, e.path)))))
      answers.push({ ...answer, reportedVerdict: answer.verdict, verdict: "insufficient" });
    else if (answer.id === "independent_acquisitions" && answer.verdict === "consistent"
      && !answer.evidence.some(e => e.path.startsWith("/before_state/") || citesConfirmedHistory(state, e.path)))
      answers.push({ ...answer, reportedVerdict: answer.verdict, verdict: "insufficient" });
    else answers.push(answer);
  }
  return { status: answers.some(a => a.verdict === "contradicts") ? "rejected"
    : answers.every(a => a.verdict === "consistent") ? "verified" : "uncertain", answers };
}
