export type SpicyObedienceMessage = {
  type: 'set_spicy_obedience';
  enabled: boolean;
};

export type EnableSpicyModeMessage = {
  type: 'enable_spicy_mode';
  riskAck: string;
};

export function buildSetSpicyObedienceMessage(enabled: boolean): SpicyObedienceMessage {
  return {
    type: 'set_spicy_obedience',
    enabled,
  };
}

export function buildEnableSpicyModeMessage(riskAck: string): EnableSpicyModeMessage {
  return {
    type: 'enable_spicy_mode',
    riskAck,
  };
}
