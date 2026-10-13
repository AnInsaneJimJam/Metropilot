// Paper sandbox quotas and global admission (issue #17, D58; product.md sandbox contract). Usage comes from
// paper_active_intervals (migration 0021): a session is one launch (one simulation account), so pause and resume
// never reset it; the day is the UTC day. Callers pass their own clock so tests can cross midnight.
import type pg from 'pg';

type Db = pg.Pool | pg.PoolClient;

export type QuotaReason = 'QUOTA_CONCURRENCY' | 'QUOTA_SESSION' | 'QUOTA_DAILY' | 'ADMISSION_FULL';

export interface PaperLimits {
  readonly concurrentPerUser: number;
  readonly sessionSeconds: number;
  readonly dailySeconds: number;
  readonly activeGlobal: number;
}

export interface QuotaRefusal {
  readonly reason: QuotaReason;
  readonly message: string;
}

// Serializes every paper admission (launch and resume) so two concurrent requests cannot both take the last slot.
const ADMISSION_LOCK = 7_204_116_017;

export async function paperLimits(db: Db): Promise<PaperLimits> {
  const { rows } = await db.query<{ paper_concurrent_per_user: number; paper_session_minutes: number; paper_daily_minutes: number; paper_active_global: number }>('select * from platform_limits');
  const row = rows[0];
  if (!row) throw new Error('platform_limits has no row; run the migrations.');
  return { concurrentPerUser: row.paper_concurrent_per_user, sessionSeconds: row.paper_session_minutes * 60, dailySeconds: row.paper_daily_minutes * 60, activeGlobal: row.paper_active_global };
}

/** Start of the UTC day containing `now`. */
export const utcDayStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** Active paper seconds of the tenant within the UTC day of `now` (an interval spanning midnight is split). */
export async function dailySeconds(db: Db, tenantId: string, now: Date): Promise<number> {
  const { rows } = await db.query<{ seconds: string }>(
    `select coalesce(sum(greatest(0, extract(epoch from least(coalesce(ended_at, $2), $2) - greatest(started_at, $3)))), 0)::bigint as seconds
     from paper_active_intervals where tenant_id = $1 and started_at < $2 and coalesce(ended_at, $2) > $3`,
    [tenantId, now, utcDayStart(now)],
  );
  return Number(rows[0]!.seconds);
}

/** Active seconds of one deployment (one paper session) up to `now`. */
export async function sessionSeconds(db: Db, deploymentId: string, now: Date): Promise<number> {
  const { rows } = await db.query<{ seconds: string }>(
    `select coalesce(sum(greatest(0, extract(epoch from least(coalesce(ended_at, $2), $2) - started_at))), 0)::bigint as seconds
     from paper_active_intervals where deployment_id = $1 and started_at < $2`,
    [deploymentId, now],
  );
  return Number(rows[0]!.seconds);
}

const minutes = (seconds: number): string => `${Math.round(seconds / 60)} minute${Math.round(seconds / 60) === 1 ? '' : 's'}`;

/**
 * May this tenant make a paper deployment active (launch, or resume of `deploymentId`)? Call inside the
 * transaction that changes the state; it takes the admission lock, held until that transaction ends.
 */
export async function admitPaper(c: pg.PoolClient, tenantId: string, deploymentId: string | undefined, now: Date): Promise<QuotaRefusal | undefined> {
  await c.query('select pg_advisory_xact_lock($1)', [ADMISSION_LOCK]);
  const limits = await paperLimits(c);
  const active = await c.query<{ mine: string; total: string }>(
    `select count(*) filter (where tenant_id = $1) as mine, count(*) as total from deployments
     where mode = 'paper' and desired_state = 'active' and ($2::uuid is null or id <> $2)`,
    [tenantId, deploymentId ?? null],
  );
  if (Number(active.rows[0]!.mine) >= limits.concurrentPerUser) {
    return { reason: 'QUOTA_CONCURRENCY', message: `Only ${limits.concurrentPerUser} paper agent${limits.concurrentPerUser === 1 ? '' : 's'} can run at a time; pause or stop the running one first.` };
  }
  // A new session starts at zero seconds: launch is refused here too when the session limit allows none.
  if ((deploymentId ? await sessionSeconds(c, deploymentId, now) : 0) >= limits.sessionSeconds) {
    return { reason: 'QUOTA_SESSION', message: `This paper session used its ${minutes(limits.sessionSeconds)}; stop it and launch a new session.` };
  }
  if ((await dailySeconds(c, tenantId, now)) >= limits.dailySeconds) {
    return { reason: 'QUOTA_DAILY', message: `Today's ${minutes(limits.dailySeconds)} of paper time are used; agents can run again after midnight UTC.` };
  }
  if (Number(active.rows[0]!.total) >= limits.activeGlobal) {
    return { reason: 'ADMISSION_FULL', message: 'The paper sandbox is at capacity right now; try again in a few minutes.' };
  }
  return undefined;
}

/** Is a new run allowed for this active deployment now? Session and daily time only; admission already passed. */
export async function runAllowed(db: Db, tenantId: string, deploymentId: string, now: Date): Promise<QuotaReason | undefined> {
  const limits = await paperLimits(db);
  if ((await sessionSeconds(db, deploymentId, now)) >= limits.sessionSeconds) return 'QUOTA_SESSION';
  if ((await dailySeconds(db, tenantId, now)) >= limits.dailySeconds) return 'QUOTA_DAILY';
  return undefined;
}

/** The tenant's paper quota document (GET /v1/quota). Never reveals other tenants' usage, only whether admission is open. */
export async function quotaDocument(db: Db, tenantId: string, now: Date): Promise<Record<string, unknown>> {
  const limits = await paperLimits(db);
  const total = await db.query<{ count: string }>(`select count(*) from deployments where mode = 'paper' and desired_state = 'active'`);
  const { rows: mine } = await db.query<{ id: string; agent_id: string }>(
    `select id, agent_id from deployments where tenant_id = $1 and mode = 'paper' and desired_state = 'active' order by created_at`, [tenantId]);
  const sessions = [];
  for (const d of mine) sessions.push({ agentId: d.agent_id, deploymentId: d.id, usedSeconds: await sessionSeconds(db, d.id, now) });
  const dayStart = utcDayStart(now);
  return {
    schemaVersion: 'paper-quota/1',
    concurrentAgents: { used: mine.length, limit: limits.concurrentPerUser },
    dailySeconds: { used: Math.min(await dailySeconds(db, tenantId, now), 86_400), limit: limits.dailySeconds, resetsAt: new Date(dayStart.getTime() + 86_400_000).toISOString() },
    sessionSecondsLimit: limits.sessionSeconds,
    sessions,
    admissionOpen: Number(total.rows[0]!.count) < limits.activeGlobal,
  };
}
