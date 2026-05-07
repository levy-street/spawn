export function normalizeCommandText(value: string): string {
  return value.replace(/—/g, "--").replace(/–/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

export function parseArgv(value: string): string[] {
  const input = normalizeCommandText(value).trim();
  if (!input) return [];

  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }

    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      started = true;
      continue;
    }

    if (quote === '"') {
      if (char === "\\") escaped = true;
      else if (char === '"') quote = null;
      else current += char;
      started = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      started = true;
      continue;
    }

    current += char;
    started = true;
  }

  if (escaped) throw new Error("Trailing escape character.");
  if (quote) throw new Error(`Unterminated ${quote === "'" ? "single" : "double"} quote.`);
  if (started) args.push(current);
  return args;
}

export function parseEnvLines(value: string): Record<string, string> {
  const env: Record<string, string> = {};
  const lines = normalizeCommandText(value).split(/\r?\n/);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const eq = trimmed.indexOf("=");
    if (eq <= 0) throw new Error(`Env line ${index + 1} must be KEY=value.`);

    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Env line ${index + 1} has an invalid key.`);
    }

    env[key] = trimmed.slice(eq + 1);
  });

  return env;
}
