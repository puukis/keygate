export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export const THEME_PREFERENCE_STORAGE_KEY = 'keygate.themePreference';
const SYSTEM_THEME_MEDIA_QUERY = '(prefers-color-scheme: dark)';

function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readThemePreference(storage: StorageLike | null = getBrowserStorage()): ThemePreference {
  const rawValue = storage?.getItem(THEME_PREFERENCE_STORAGE_KEY);
  return isThemePreference(rawValue) ? rawValue : 'system';
}

export function writeThemePreference(
  preference: ThemePreference,
  storage: StorageLike | null = getBrowserStorage()
): void {
  try {
    storage?.setItem(THEME_PREFERENCE_STORAGE_KEY, preference);
  } catch {
    // Ignore storage write errors and keep runtime theme state in memory.
  }
}

export function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light';
  }

  return window.matchMedia(SYSTEM_THEME_MEDIA_QUERY).matches ? 'dark' : 'light';
}

export function resolveTheme(preference: ThemePreference, systemTheme: ResolvedTheme): ResolvedTheme {
  return preference === 'system' ? systemTheme : preference;
}

export function applyResolvedTheme(theme: ResolvedTheme): void {
  if (typeof document === 'undefined') {
    return;
  }

  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

export function getNextThemePreferenceForToggle(
  preference: ThemePreference,
  resolvedTheme: ResolvedTheme
): Exclude<ThemePreference, 'system'> {
  if (preference === 'system') {
    return resolvedTheme === 'dark' ? 'light' : 'dark';
  }

  return preference === 'dark' ? 'light' : 'dark';
}
