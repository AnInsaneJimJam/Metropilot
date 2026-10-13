// Rate-card storage and the two metered cost paths (ACC-4, API-4; funds-and-budgets.md section 5).
// Hosting: each billable slice is reserved before the lease covering it is extended and charged once.
// Model/data calls: worst-case hold before dispatch, one dispatch record, actual settlement capped at the hold,
// unknown outcomes held, escalated after 24 h and then settled at no more than the hold or released.
import { user } from './accounts.ts';
import type { AgentScope, Mode, Sql } from './accounts.ts';
import { AccountingError, invalid } from './errors.ts';
import { uuidv7 } from './ids.ts';
import { serviceChargePostings } from './operations.ts';
import { assertCurrent, hostingSlicePrice, modelCallCeiling, modelCallCharge } from './rates.ts';
import type { ModelCallBounds, RateCard, RateKind } from './rates.ts';
import { markDispatched, markReconciling, release, reserve, settle } from './reservations.ts';

const big = (v: string | null): bigint | undefined => (v === null ? undefined : BigInt(v));

type RateRow = {
  version: string; kind: RateKind; mode: Mode; profile_ref: string; asset_ref: string; slice_seconds: number | null; atomic_per_slice: string | null;
  input_atomic_per_million: string | null; output_atomic_per_million: string | null; atomic_per_request: string | null; margin_bps: number;
  effective_from: Date; expires_at: Date | null; source: string;
};

export interface StoredRateCard extends RateCard {
  readonly mode: Mode;
  readonly source: string;
}

function toCard(r: RateRow): StoredRateCard {
  const card: Record<string, unknown> = {
    version: r.version, kind: r.kind, mode: r.mode, profileRef: r.profile_ref, assetRef: r.asset_ref, marginBps: r.margin_bps, effectiveFrom: r.effective_from, source: r.source,
  };
  if (r.slice_seconds !== null) card['sliceSeconds'] = r.slice_seconds;
  for (const [k, v] of [['atomicPerSlice', r.atomic_per_slice], ['inputAtomicPerMillion', r.input_atomic_per_million], ['outputAtomicPerMillion', r.output_atomic_per_million], ['atomicPerRequest', r.atomic_per_request]] as const) {
    const value = big(v);
    if (value !== undefined) card[k] = value;
  }
  if (r.expires_at) card['expiresAt'] = r.expires_at;
  return card as unknown as StoredRateCard;
}

export async function publishRateCard(c: Sql, card: StoredRateCard): Promise<void> {
  await c.query(
    `insert into rate_cards (version, kind, mode, profile_ref, asset_ref, slice_seconds, atomic_per_slice, input_atomic_per_million,
       output_atomic_per_million, atomic_per_request, margin_bps, effective_from, expires_at, source)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) on conflict (version) do nothing`,
    [card.version, card.kind, card.mode, card.profileRef, card.assetRef, card.sliceSeconds ?? null, card.atomicPerSlice?.toString() ?? null,
      card.inputAtomicPerMillion?.toString() ?? null, card.outputAtomicPerMillion?.toString() ?? null, card.atomicPerRequest?.toString() ?? null,
      card.marginBps, card.effectiveFrom, card.expiresAt ?? null, card.source],
  );
}

/** The newest card in effect for a profile, or undefined (an unknown price refuses the operation upstream). */
export async function currentRateCard(c: Sql, kind: RateKind, mode: Mode, profileRef: string, at: Date): Promise<StoredRateCard | undefined> {
  const r = await c.query<RateRow>(
    `select * from rate_cards where kind = $1 and mode = $2 and profile_ref = $3 and effective_from <= $4 and (expires_at is null or expires_at > $4)
     order by effective_from desc, version desc limit 1`,
    [kind, mode, profileRef, at],
  );
  return r.rows[0] ? toCard(r.rows[0]) : undefined;
}

export async function rateCard(c: Sql, version: string): Promise<StoredRateCard | undefined> {
  const r = await c.query<RateRow>('select * from rate_cards where version = $1', [version]);
  return r.rows[0] ? toCard(r.rows[0]) : undefined;
}

// ---- hosting ----------------------------------------------------------------------------------------------------

export interface HostingSliceInput {
  readonly scope: AgentScope;
  readonly deploymentId: string;
  readonly card: StoredRateCard;
  /** Absolute slice index: floor(epoch seconds / sliceSeconds). Monotonic across restarts. */
  readonly sliceIndex: bigint;
  readonly now: Date;
}

export const sliceIndexAt = (at: Date, sliceSeconds: number): bigint => BigInt(Math.floor(at.getTime() / 1000 / sliceSeconds));

export type HostingOutcome = { readonly status: 'charged' | 'alreadyCharged'; readonly charged: bigint };

/**
 * Authorize and charge one hosting slice from the hosting bucket, once per (deployment, slice). Throws
 * INSUFFICIENT_BUDGET when the bucket cannot pay: the caller must not extend compute past the last paid slice.
 */
export async function chargeHostingSlice(c: Sql, input: HostingSliceInput): Promise<HostingOutcome> {
  const { scope, card } = input;
  assertCurrent(card, input.now);
  const { sliceSeconds, atomic } = hostingSlicePrice(card);
  const key = `hosting:${input.deploymentId}:${input.sliceIndex}`;
  const prior = await c.query<{ charged_atomic: string | null }>('select charged_atomic from usage_records where logical_key = $1', [key]);
  if (prior.rows[0]) return { status: 'alreadyCharged', charged: BigInt(prior.rows[0].charged_atomic ?? '0') };
  if (atomic === 0n) return { status: 'charged', charged: 0n };
  const sliceStart = new Date(Number(input.sliceIndex) * sliceSeconds * 1000);
  await reserve(c, {
    operationKey: key, mode: scope.mode, tenantId: scope.tenantId, agentId: scope.agentId, purpose: 'hostingSlice', rateCardVersion: card.version,
    holds: [{ account: user(scope, 'hosting', card.assetRef), amount: atomic }], now: input.now, expiresAt: new Date(Math.max(input.now.getTime(), sliceStart.getTime()) + sliceSeconds * 1000),
  });
  await c.query(
    `insert into usage_records (id, tenant_id, agent_id, mode, kind, logical_key, reservation_key, rate_card_version, profile_ref, deployment_id, slice_index, state, held_atomic, created_at)
     values ($1, $2, $3, $4, 'hosting', $5, $5, $6, $7, $8, $9, 'reserved', $10, $11)`,
    [uuidv7(input.now.getTime()), scope.tenantId, scope.agentId, scope.mode, key, card.version, card.profileRef, input.deploymentId, input.sliceIndex.toString(), atomic.toString(), input.now],
  );
  // A slice is billed in full once authorized (minimum billing); there is no external dispatch to wait for.
  await markDispatched(c, key, input.now);
  await settle(c, key, { journal: { kind: 'serviceCharge', postings: serviceChargePostings(scope, 'hosting', card.assetRef, atomic), occurredAt: input.now }, now: input.now });
  await c.query(`update usage_records set state = 'settled', charged_atomic = held_atomic, dispatched_at = $2, resolved_at = $2 where logical_key = $1`, [key, input.now]);
  return { status: 'charged', charged: atomic };
}

// ---- model and paid data calls ----------------------------------------------------------------------------------

export interface ModelCallInput {
  readonly scope: AgentScope;
  /** Unique per AI node attempt, e.g. operation-key/1 of the broker request. */
  readonly logicalKey: string;
  readonly card: StoredRateCard;
  readonly bounds: ModelCallBounds;
  readonly now: Date;
}

/** One unresolved escalated record pauses further calls for that agent's profile. */
export async function modelProfilePaused(c: Sql, scope: AgentScope, profileRef: string): Promise<boolean> {
  const r = await c.query(`select 1 from usage_records where tenant_id = $1 and agent_id = $2 and mode = $3 and profile_ref = $4 and state = 'escalated' limit 1`,
    [scope.tenantId, scope.agentId, scope.mode, profileRef]);
  return (r.rowCount ?? 0) > 0;
}

/** Hold the worst-case cost in the API bucket. Refuses an unknown price or a paused profile. */
export async function reserveModelCall(c: Sql, input: ModelCallInput): Promise<{ heldAtomic: bigint; duplicate: boolean }> {
  const { scope, card } = input;
  assertCurrent(card, input.now);
  if (await modelProfilePaused(c, scope, card.profileRef)) {
    throw new AccountingError('RECONCILIATION_REQUIRED', 'Calls to this model are paused until an unknown charge is resolved.', { profile: card.profileRef });
  }
  const ceiling = modelCallCeiling(card, input.bounds);
  if (ceiling <= 0n) invalid('A model call has a positive cost ceiling.');
  const key = `model:${input.logicalKey}`;
  const held = await reserve(c, {
    operationKey: key, mode: scope.mode, tenantId: scope.tenantId, agentId: scope.agentId, purpose: card.kind === 'data' ? 'dataCall' : 'modelCall', rateCardVersion: card.version,
    holds: [{ account: user(scope, 'api', card.assetRef), amount: ceiling }], now: input.now, expiresAt: new Date(input.now.getTime() + 10 * 60_000),
  });
  if (!held.duplicate) {
    await c.query(
      `insert into usage_records (id, tenant_id, agent_id, mode, kind, logical_key, reservation_key, rate_card_version, profile_ref, state, held_atomic, usage, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'reserved', $10, $11, $12)`,
      [uuidv7(input.now.getTime()), scope.tenantId, scope.agentId, scope.mode, card.kind, input.logicalKey, key, card.version, card.profileRef, ceiling.toString(),
        { maxInputTokens: input.bounds.maxInputTokens, maxOutputTokens: input.bounds.maxOutputTokens, requests: input.bounds.requests }, input.now],
    );
  }
  return { heldAtomic: ceiling, duplicate: held.duplicate };
}

async function usage(c: Sql, logicalKey: string) {
  const r = await c.query<{ tenant_id: string; agent_id: string; mode: Mode; state: string; held_atomic: string; rate_card_version: string; reservation_key: string; charged_atomic: string | null }>(
    'select tenant_id, agent_id, mode, state, held_atomic, rate_card_version, reservation_key, charged_atomic from usage_records where logical_key = $1 for update', [logicalKey]);
  const row = r.rows[0];
  if (!row) throw new AccountingError('NOT_FOUND', 'No usage record for this call.');
  return row;
}

/** Record the dispatch attempt before sending; one attempt per AI node. */
export async function recordModelDispatch(c: Sql, logicalKey: string, now: Date): Promise<void> {
  const row = await usage(c, logicalKey);
  if (row.state !== 'reserved') {
    if (row.state === 'dispatched') return;
    throw new AccountingError('STATE_CONFLICT', 'This call was already sent; it is never sent again.');
  }
  await markDispatched(c, row.reservation_key, now);
  await c.query(`update usage_records set state = 'dispatched', dispatched_at = $2 where logical_key = $1`, [logicalKey, now]);
}

export interface ReportedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly requests: number;
  readonly providerRequestId?: string;
}

/** Settle reported usage once, capped at the hold; an excess is a platform discrepancy, never a user debit. */
export async function settleModelUsage(c: Sql, logicalKey: string, reported: ReportedUsage, now: Date): Promise<{ charged: bigint; excess: bigint }> {
  const row = await usage(c, logicalKey);
  if (row.state === 'settled') return { charged: BigInt(row.charged_atomic!), excess: 0n };
  if (!['dispatched', 'unknown', 'escalated'].includes(row.state)) throw new AccountingError('STATE_CONFLICT', `A ${row.state} call cannot settle.`);
  const card = (await rateCard(c, row.rate_card_version))!;
  const { charge, excess } = modelCallCharge(card, reported, BigInt(row.held_atomic));
  return finish(c, logicalKey, row, charge, now, { ...reported, ...(excess > 0n ? { excessAtomic: excess.toString() } : {}) }).then((charged) => ({ charged, excess }));
}

async function finish(c: Sql, logicalKey: string, row: Awaited<ReturnType<typeof usage>>, charge: bigint, now: Date, detail: Record<string, unknown>): Promise<bigint> {
  const scope = { mode: row.mode, tenantId: row.tenant_id, agentId: row.agent_id };
  const card = (await rateCard(c, row.rate_card_version))!;
  if (charge === 0n) {
    await release(c, row.reservation_key, now, 'No billable usage.');
  } else {
    await settle(c, row.reservation_key, { journal: { kind: 'serviceCharge', postings: serviceChargePostings(scope, 'api', card.assetRef, charge), occurredAt: now }, now });
  }
  await c.query(
    `update usage_records set state = $2, charged_atomic = $3, provider_request_id = coalesce($4, provider_request_id), usage = usage || $5, resolved_at = $6 where logical_key = $1`,
    [logicalKey, charge === 0n ? 'released' : 'settled', charge === 0n ? null : charge.toString(), (detail['providerRequestId'] as string | undefined) ?? null, detail, now],
  );
  return charge;
}

/** A timeout after send: the charge is unknown. Keep the hold; never refund, resend or double charge. */
export async function markModelUnknown(c: Sql, logicalKey: string, now: Date): Promise<void> {
  const row = await usage(c, logicalKey);
  if (row.state === 'unknown' || row.state === 'escalated') return;
  if (row.state !== 'dispatched') throw new AccountingError('STATE_CONFLICT', `A ${row.state} call cannot become unknown.`);
  await markReconciling(c, row.reservation_key, 'Model usage unknown after dispatch.');
  await c.query(`update usage_records set state = 'unknown', usage = usage || $2 where logical_key = $1`, [logicalKey, { unknownSince: now.toISOString() }]);
}

export const UNKNOWN_USAGE_ESCALATION_MILLIS = 24 * 60 * 60_000;

/** Escalate unknown charges older than 24 h: their profile pauses until an operator resolves them. */
export async function escalateUnknownUsage(c: Sql, now: Date): Promise<string[]> {
  const r = await c.query<{ logical_key: string }>(
    `update usage_records set state = 'escalated', escalated_at = $1 where state = 'unknown' and dispatched_at <= $2 returning logical_key`,
    [now, new Date(now.getTime() - UNKNOWN_USAGE_ESCALATION_MILLIS)]);
  return r.rows.map((row) => row.logical_key);
}

/**
 * Operator resolution of an unknown charge: settle at no more than the held maximum with evidence, or release.
 * The platform absorbs anything it cannot evidence.
 */
export async function resolveUnknownUsage(c: Sql, logicalKey: string, resolution: { chargeAtomic: bigint; evidence: string }, now: Date): Promise<bigint> {
  const row = await usage(c, logicalKey);
  if (row.state !== 'unknown' && row.state !== 'escalated') throw new AccountingError('STATE_CONFLICT', 'Only an unknown charge can be resolved this way.');
  if (resolution.chargeAtomic < 0n || resolution.chargeAtomic > BigInt(row.held_atomic)) invalid('A resolved charge is between zero and the held maximum.');
  if (!resolution.evidence.trim()) invalid('Resolution needs evidence.');
  return finish(c, logicalKey, row, resolution.chargeAtomic, now, { resolutionEvidence: resolution.evidence.slice(0, 300) });
}
