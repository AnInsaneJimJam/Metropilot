// Paper and live readiness reported separately with safe reason codes (docs/specs/executor.md section 16).
import type pg from 'pg';

export interface ModeReadiness {
  readonly ready: boolean;
  readonly reasons: readonly string[];
}

export interface Readiness {
  readonly paper: ModeReadiness;
  readonly live: ModeReadiness;
}

/** Live stays disabled until gates E03, E04 and E06 have dated evidence in docs/decisions.md. */
const LIVE: ModeReadiness = { ready: false, reasons: ['LIVE_NOT_IMPLEMENTED', 'GATE_E03_OPEN', 'GATE_E04_OPEN', 'GATE_E06_OPEN'] };

export async function checkReadiness(pool: pg.Pool): Promise<Readiness> {
  try {
    const { rows } = await pool.query<{ version: number }>('select max(version) as version from schema_migrations');
    const paper = (rows[0]?.version ?? 0) >= 2 ? { ready: true, reasons: [] } : { ready: false, reasons: ['MIGRATIONS_PENDING'] };
    return { paper, live: LIVE };
  } catch {
    return { paper: { ready: false, reasons: ['DATABASE_UNAVAILABLE'] }, live: LIVE };
  }
}
