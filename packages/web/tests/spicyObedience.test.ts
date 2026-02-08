import { describe, expect, it } from 'vitest';
import { buildEnableSpicyModeMessage, buildSetSpicyObedienceMessage } from '../src/spicyObedience';

describe('spicyObedience helpers', () => {
  it('builds the websocket payload for spicy obedience updates', () => {
    expect(buildSetSpicyObedienceMessage(true)).toEqual({
      type: 'set_spicy_obedience',
      enabled: true,
    });
  });

  it('builds the websocket payload for enabling spicy mode', () => {
    expect(buildEnableSpicyModeMessage('I ACCEPT THE RISK')).toEqual({
      type: 'enable_spicy_mode',
      riskAck: 'I ACCEPT THE RISK',
    });
  });
});
