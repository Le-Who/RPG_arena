/** Safe error metadata distinguishes local admission from an ambiguous provider outcome. */
export class QuotaAdmissionError extends Error {
  constructor(readonly code: "QUOTA_EXHAUSTED" | "QUOTA_UNAVAILABLE" | "QUOTA_ADMISSION_TIMEOUT" | "QUOTA_ADMISSION_CANCELLED", readonly providerAttempts = 0) {
    super(code);
    this.name = "QuotaAdmissionError";
  }
}
export function quotaDeferredWithoutFetch(error: unknown) {
  return error instanceof QuotaAdmissionError && error.providerAttempts === 0;
}
