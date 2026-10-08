// Server-generated identifiers: lower-case UUIDv7 (RFC 9562) as required by common.schema.json uuidv7.
import { randomBytes } from 'node:crypto';

export function uuidv7(nowMillis: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(nowMillis, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
