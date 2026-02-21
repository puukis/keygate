import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildAuthorizeUrl } from '../oauth.js';
import { generateState, generateCodeVerifier, generateCodeChallenge } from '../pkce.js';

describe('OAuth', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('buildAuthorizeUrl', () => {
    it('builds a correct authorize URL with all parameters', () => {
      const state = generateState();
      const verifier = generateCodeVerifier();
      const challenge = generateCodeChallenge(verifier);

      const url = buildAuthorizeUrl(
        { clientId: 'test-client-id', scope: 'openai.chat' },
        state,
        challenge
      );

      const parsed = new URL(url);
      expect(parsed.origin).toBe('https://auth.openai.com');
      expect(parsed.pathname).toBe('/oauth/authorize');
      expect(parsed.searchParams.get('client_id')).toBe('test-client-id');
      expect(parsed.searchParams.get('response_type')).toBe('code');
      expect(parsed.searchParams.get('code_challenge')).toBe(challenge);
      expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
      expect(parsed.searchParams.get('state')).toBe(state);
      expect(parsed.searchParams.get('scope')).toBe('openai.chat');
      expect(parsed.searchParams.get('redirect_uri')).toContain('127.0.0.1');
    });

    it('uses custom authorization endpoint when provided', () => {
      const url = buildAuthorizeUrl(
        {
          clientId: 'test-id',
          authorizationEndpoint: 'https://custom.auth.example/authorize',
        },
        'test-state',
        'test-challenge'
      );

      const parsed = new URL(url);
      expect(parsed.origin).toBe('https://custom.auth.example');
      expect(parsed.pathname).toBe('/authorize');
    });

    it('uses custom redirect port', () => {
      const url = buildAuthorizeUrl(
        { clientId: 'test-id', redirectPort: 9000 },
        'test-state',
        'test-challenge'
      );

      const parsed = new URL(url);
      expect(parsed.searchParams.get('redirect_uri')).toBe(
        'http://127.0.0.1:9000/auth/callback'
      );
    });
  });

  describe('state mismatch detection', () => {
    it('different states should not match', () => {
      const stateA = generateState();
      const stateB = generateState();
      expect(stateA).not.toBe(stateB);
    });
  });
});
