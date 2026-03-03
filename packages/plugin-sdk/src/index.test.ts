import { describe, expect, it } from 'vitest';
import { definePlugin, definePluginConfigSchema, isPluginHttpResult } from './index';

describe('@puukis/plugin-sdk', () => {
  it('returns the original plugin object from definePlugin', () => {
    const plugin = {
      setup() {
        return undefined;
      },
    };

    expect(definePlugin(plugin)).toBe(plugin);
  });

  it('returns the original schema object from definePluginConfigSchema', () => {
    const schema = {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
      },
      required: ['enabled'],
    };

    expect(definePluginConfigSchema(schema)).toBe(schema);
  });

  it('accepts http result objects with a finite numeric status', () => {
    expect(isPluginHttpResult({ status: 200, json: { ok: true } })).toBe(true);
    expect(isPluginHttpResult({ status: 204, text: '' })).toBe(true);
    expect(isPluginHttpResult({ status: 201, body: new Uint8Array(), contentType: 'application/octet-stream' })).toBe(true);
  });

  it('rejects non-object values and objects without a finite status', () => {
    expect(isPluginHttpResult(null)).toBe(false);
    expect(isPluginHttpResult('nope')).toBe(false);
    expect(isPluginHttpResult([])).toBe(false);
    expect(isPluginHttpResult({})).toBe(false);
    expect(isPluginHttpResult({ status: Number.NaN })).toBe(false);
    expect(isPluginHttpResult({ status: '200' })).toBe(false);
  });
});
