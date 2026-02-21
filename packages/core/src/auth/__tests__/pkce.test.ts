import { describe, expect, it } from 'vitest';
import { generateCodeVerifier, generateCodeChallenge, generateState } from '../pkce.js';

describe('PKCE', () => {
  it('generates a code verifier of the expected length', () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toHaveLength(64);
    // Must be URL-safe base64
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('generates unique verifiers', () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
  });

  it('generates a valid S256 code challenge', () => {
    const verifier = generateCodeVerifier();
    const challenge = generateCodeChallenge(verifier);

    // Challenge is base64url-encoded SHA-256 (43 chars)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge.length).toBeGreaterThanOrEqual(42);
    expect(challenge.length).toBeLessThanOrEqual(44);
  });

  it('produces deterministic challenges for the same verifier', () => {
    const verifier = 'test-verifier-12345';
    const a = generateCodeChallenge(verifier);
    const b = generateCodeChallenge(verifier);
    expect(a).toBe(b);
  });

  it('produces different challenges for different verifiers', () => {
    const a = generateCodeChallenge('verifier-a');
    const b = generateCodeChallenge('verifier-b');
    expect(a).not.toBe(b);
  });

  it('generates a cryptographically random state', () => {
    const state = generateState();
    expect(state).toHaveLength(32);
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('generates unique states', () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
  });
});
