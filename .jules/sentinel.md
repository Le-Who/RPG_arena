## 2023-10-27 - [Fix timing leak / DoS in verifyPassword]
**Vulnerability:** The password verification short-circuited constant-time evaluation for non-existent users (!!valid && timingSafeEqual(...)), which could potentially allow user enumeration timing attacks or crash when handling invalid inputs.
**Learning:** `timingSafeEqual` must be called unconditionally with a valid fallback buffer to avoid early returns or crashes on `Buffer.from(undefined)`.
**Prevention:** Always evaluate `timingSafeEqual` with a safe dummy buffer (e.g. `Buffer.alloc(64)`) unconditionally for constant-time cryptographic validation.
