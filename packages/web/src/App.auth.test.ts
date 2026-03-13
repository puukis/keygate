import { describe, expect, it } from 'vitest';
import {
  resolveOperatorSurfaceProbe,
  shouldProbeOperatorSurfaceOnDisconnect,
} from './App';

describe('remote operator auth helpers', () => {
  it('marks 401 responses as token-gated and unauthorized', () => {
    expect(resolveOperatorSurfaceProbe(401)).toEqual({
      authState: 'unauthorized',
      authMode: 'token',
    });
  });

  it('parses token auth mode from a successful status payload', () => {
    expect(resolveOperatorSurfaceProbe(200, {
      remote: {
        authMode: 'token',
      },
    })).toEqual({
      authState: 'authorized',
      authMode: 'token',
    });
  });

  it('defaults successful probes to auth mode off when the payload is missing or invalid', () => {
    expect(resolveOperatorSurfaceProbe(200)).toEqual({
      authState: 'authorized',
      authMode: 'off',
    });

    expect(resolveOperatorSurfaceProbe(200, {
      remote: {
        authMode: 'unexpected',
      },
    })).toEqual({
      authState: 'authorized',
      authMode: 'off',
    });
  });

  it('keeps non-auth API failures authorized so the local UI can continue booting', () => {
    expect(resolveOperatorSurfaceProbe(500)).toEqual({
      authState: 'authorized',
    });
  });

  it('re-probes on disconnect for token auth or after a real websocket connection', () => {
    expect(shouldProbeOperatorSurfaceOnDisconnect('token', false)).toBe(true);
    expect(shouldProbeOperatorSurfaceOnDisconnect('off', true)).toBe(true);
    expect(shouldProbeOperatorSurfaceOnDisconnect('off', false)).toBe(false);
  });
});
