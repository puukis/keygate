import { describe, expect, it } from 'vitest';
import {
  getNextThemePreferenceForToggle,
  readThemePreference,
  resolveTheme,
  writeThemePreference,
  type ThemePreference,
} from './theme';

interface MemoryStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function createMemoryStorage(initial: Record<string, string> = {}): MemoryStorage {
  const entries = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
}

describe('theme preference storage', () => {
  it('falls back to system when stored value is invalid', () => {
    const storage = createMemoryStorage({
      'keygate.themePreference': 'neon',
    });

    expect(readThemePreference(storage)).toBe('system');
  });

  it('serializes and deserializes valid preferences', () => {
    const storage = createMemoryStorage();
    const preferences: ThemePreference[] = ['system', 'light', 'dark'];

    for (const preference of preferences) {
      writeThemePreference(preference, storage);
      expect(readThemePreference(storage)).toBe(preference);
    }
  });
});

describe('resolveTheme', () => {
  it('resolves system to the current system theme', () => {
    expect(resolveTheme('system', 'dark')).toBe('dark');
    expect(resolveTheme('system', 'light')).toBe('light');
  });

  it('keeps manual overrides unchanged', () => {
    expect(resolveTheme('light', 'dark')).toBe('light');
    expect(resolveTheme('dark', 'light')).toBe('dark');
  });
});

describe('getNextThemePreferenceForToggle', () => {
  it('switches to explicit opposite theme when currently following system', () => {
    expect(getNextThemePreferenceForToggle('system', 'dark')).toBe('light');
    expect(getNextThemePreferenceForToggle('system', 'light')).toBe('dark');
  });

  it('toggles between explicit light and dark', () => {
    expect(getNextThemePreferenceForToggle('light', 'light')).toBe('dark');
    expect(getNextThemePreferenceForToggle('dark', 'dark')).toBe('light');
  });
});
