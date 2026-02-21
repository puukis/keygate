import { randomBytes, createHash } from 'node:crypto';

/**
 * Generate a cryptographically random string suitable for OAuth state or PKCE verifier.
 */
export function generateRandomString(length = 64): string {
  return randomBytes(length).toString('base64url').slice(0, length);
}

/**
 * Generate a PKCE code verifier (43–128 URL-safe chars).
 */
export function generateCodeVerifier(): string {
  return generateRandomString(64);
}

/**
 * Derive the S256 code challenge from a code verifier.
 */
export function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Generate a cryptographically random state parameter.
 */
export function generateState(): string {
  return generateRandomString(32);
}
