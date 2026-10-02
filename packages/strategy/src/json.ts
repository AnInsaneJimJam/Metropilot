import { LanguageError } from './errors.ts';
const encoder = new TextEncoder();
export function parseSource(source: string): unknown {
  if (encoder.encode(source).length > 256 * 1024) throw new LanguageError('LIMIT_EXCEEDED', 'Strategy exceeds 256 KiB.');
  // Scan before JSON.parse: bound nesting and detect duplicate keys, including escaped aliases.
  const tokens = /\s*("(?:[^"\\]|\\.)*"|[{}\[\]:,]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/gy;
  const stack: { kind: string; keys: Set<string> }[] = [];
  let offset = 0;
  try {
    while (offset < source.length && source.slice(offset).trim() !== '') {
      tokens.lastIndex = offset;
      const match = tokens.exec(source);
      if (!match) throw new Error('Invalid JSON token');
      offset = tokens.lastIndex;
      const token = match[1]!;
      if (token === '{' || token === '[') {
        stack.push({ kind: token, keys: new Set() });
        if (stack.length > 64) throw new LanguageError('LIMIT_EXCEEDED', 'JSON nesting exceeds 64.');
      } else if (token === '}' || token === ']') stack.pop();
      else if (token.startsWith('"') && /^\s*:/.test(source.slice(offset))) {
        const key = JSON.parse(token) as string;
        const frame = stack.at(-1);
        if (frame?.kind !== '{' || frame.keys.has(key)) throw new LanguageError('SCHEMA_INVALID', 'Duplicate or misplaced object key.');
        frame.keys.add(key);
      }
    }
    const value: unknown = JSON.parse(source);
    const inspect = (v: unknown): void => {
      if (typeof v === 'string') {
        // Reject lone surrogate code units; escaped malformed Unicode also fails.
        if (!v.isWellFormed()) throw new LanguageError('SCHEMA_INVALID', 'Invalid Unicode string.');
      } else if (typeof v === 'number' && !Number.isFinite(v)) throw new LanguageError('SCHEMA_INVALID', 'Non-finite number.');
      else if (v !== null && typeof v === 'object') for (const [key, child] of Object.entries(v)) { inspect(key); inspect(child); }
    };
    inspect(value);
    return value;
  } catch (error) {
    if (error instanceof LanguageError) throw error;
    throw new LanguageError('SCHEMA_INVALID', 'Use valid JSON with unique object keys.');
  }
}
