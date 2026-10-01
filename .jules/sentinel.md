## 2025-02-18 - Missing global security headers
**Vulnerability:** Next.js application was missing standard HTTP security headers globally.
**Learning:** Only service worker had security headers configured.
**Prevention:** Global Next.js header configuration in next.config.ts should cover all routes.
