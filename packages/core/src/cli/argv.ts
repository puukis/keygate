export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const withoutPrefix = token.slice(2);
    const equalsIndex = withoutPrefix.indexOf('=');

    if (equalsIndex >= 0) {
      const key = withoutPrefix.slice(0, equalsIndex);
      const value = withoutPrefix.slice(equalsIndex + 1);
      flags[key] = value;
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags[withoutPrefix] = next;
      i += 1;
      continue;
    }

    flags[withoutPrefix] = true;
  }

  return { positional, flags };
}

export function getFlagString(
  flags: Record<string, string | boolean>,
  key: string,
  fallback = ''
): string {
  const value = flags[key];
  if (typeof value === 'string') {
    return value;
  }

  if (value === true) {
    return 'true';
  }

  return fallback;
}

export function hasFlag(flags: Record<string, string | boolean>, key: string): boolean {
  return Boolean(flags[key]);
}
