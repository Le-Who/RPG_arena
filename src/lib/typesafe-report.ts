export type TypeSafeVerdict = "supports" | "contradicts" | "unsupported";

export type TypeSafeEvaluation = {
  factIndex: number;
  fact: string;
  evidence: string;
  choice: TypeSafeVerdict;
  probabilities: Record<TypeSafeVerdict, number>;
  confidence: number;
};

export type TypeSafeReportStatus = "disabled" | "no_key" | "empty" | "ok" | "error";

export type TypeSafeReport = {
  status: TypeSafeReportStatus;
  model: "jev-1.13.0";
  promptVersion: "fact-verification-v1";
  evaluations: TypeSafeEvaluation[];
  usage: { inputTokens: number; outputTokens: number } | null;
  latencyMs: number;
  error?: string;
};
