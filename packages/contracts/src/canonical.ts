// RFC 8785 JSON Canonicalization Scheme and the 0x SHA-256 content hash used for strategy ASTs,
// catalog entries and manifests. Input must already be parsed JSON: duplicate keys are a parser concern.

/** Canonical JSON text: sorted keys (UTF-16 code-unit order), no whitespace, ES number serialization. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON forbids non-finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new TypeError('canonical JSON forbids lone surrogates');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    // Default sort compares UTF-16 code units, which is what RFC 8785 section 3.2.3 requires.
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${canonicalize(key)}:${canonicalize((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new TypeError(`canonical JSON forbids ${typeof value} values`);
}

/** Lower-case 0x SHA-256 of the canonical UTF-8 bytes. Uses Web Crypto, so it also runs in browsers. */
export async function contentHash(value: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalize(value)));
  return `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
