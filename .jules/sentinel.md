## 2026-10-29 - Missing Access Control Wrapper on API Export
**Vulnerability:** Next.js API route handlers were performing access control logic internally (via `withCurrentIdentityWork`) instead of wrapping the top-level route export (via `withIdentityWork`).
**Learning:** This exposes the endpoint to basic CSRF and bypasses request diagnostics and telemetry that are enforced at the top-level boundary in `withIdentityWork` and similar middleware.
**Prevention:** Always verify that `export const POST = ...`, `export const GET = ...`, etc., are explicitly wrapped with access-control middleware (`withIdentityWork`, `withAdminAccess`, `withCampaignAccess`) to ensure the entire request lifecycle is protected.
