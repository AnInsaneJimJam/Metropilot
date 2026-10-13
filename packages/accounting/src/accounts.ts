// Ledger account identities (docs/specs/funds-and-budgets.md section 2). Every account is one asset in one mode;
// paper and live identities never share an account. The canonical key is also the lock order.
import type pg from 'pg';
import { AccountingError, invalid } from './errors.ts';
import { uuidv7 } from './ids.ts';

export type Mode = 'paper' | 'live';
export type Bucket = 'unallocated' | 'hosting' | 'api' | 'trading';
/** Service revenue lines; the API bucket's charges earn `api` revenue, hosting slices `hosting`. */
export type RevenueLine = 'hosting' | 'api';
export type Side = 'debit' | 'credit';
/** Anything that runs a query: a pool for unlocked reads, a client inside a transaction for writes. */
export type Sql = Pick<pg.ClientBase, 'query'>;

export const BUCKETS: readonly Bucket[] = ['unallocated', 'hosting', 'api', 'trading'];

export type AccountRef =
  | { readonly kind: 'wallet'; readonly mode: Mode; readonly tenantId: string; readonly agentId: string; readonly assetRef: string }
  | { readonly kind: 'user'; readonly mode: Mode; readonly tenantId: string; readonly agentId: string; readonly bucket: Bucket; readonly assetRef: string }
  | { readonly kind: 'revenue'; readonly mode: Mode; readonly tenantId: string; readonly agentId: string; readonly line: RevenueLine; readonly assetRef: string }
  | { readonly kind: 'treasury'; readonly mode: Mode; readonly assetRef: string }
  | { readonly kind: 'platformExpense'; readonly mode: Mode; readonly assetRef: string };

export interface AgentScope {
  readonly mode: Mode;
  readonly tenantId: string;
  readonly agentId: string;
}

const ASSET = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9][A-Za-z0-9_-]*)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const wallet = (scope: AgentScope, assetRef: string): AccountRef => ({ kind: 'wallet', ...scope, assetRef });
export const user = (scope: AgentScope, bucket: Bucket, assetRef: string): AccountRef => ({ kind: 'user', ...scope, bucket, assetRef });
export const revenue = (scope: AgentScope, line: RevenueLine, assetRef: string): AccountRef => ({ kind: 'revenue', ...scope, line, assetRef });
export const treasury = (mode: Mode, assetRef: string): AccountRef => ({ kind: 'treasury', mode, assetRef });
export const platformExpense = (mode: Mode, assetRef: string): AccountRef => ({ kind: 'platformExpense', mode, assetRef });

export function accountKey(ref: AccountRef): string {
  if (!ASSET.test(ref.assetRef) || ref.assetRef.length > 128) invalid(`Invalid asset reference ${ref.assetRef}.`);
  if ('agentId' in ref && (!UUID.test(ref.agentId) || !UUID.test(ref.tenantId))) invalid('Account identity needs UUIDv7 tenant and agent IDs.');
  switch (ref.kind) {
    case 'wallet': return `${ref.mode}:${ref.agentId}:wallet:${ref.assetRef}`;
    case 'user': return `${ref.mode}:${ref.agentId}:user:${ref.bucket}:${ref.assetRef}`;
    case 'revenue': return `${ref.mode}:${ref.agentId}:revenue:${ref.line}:${ref.assetRef}`;
    case 'treasury': return `${ref.mode}:platform:treasury:${ref.assetRef}`;
    case 'platformExpense': return `${ref.mode}:platform:expense:${ref.assetRef}`;
  }
}

/** Account class, holder, bucket and normal side as stored. */
function shape(ref: AccountRef): { cls: string; holder: string; bucket: Bucket | null; normal: Side } {
  switch (ref.kind) {
    case 'wallet': return { cls: 'asset', holder: 'agentWallet', bucket: null, normal: 'debit' };
    case 'user': return { cls: 'liability', holder: 'user', bucket: ref.bucket, normal: 'credit' };
    case 'revenue': return { cls: 'revenue', holder: 'service', bucket: null, normal: 'credit' };
    case 'treasury': return { cls: 'asset', holder: 'treasury', bucket: null, normal: 'debit' };
    case 'platformExpense': return { cls: 'expense', holder: 'platform', bucket: null, normal: 'debit' };
  }
}

export const normalSide = (ref: AccountRef): Side => shape(ref).normal;

export interface AccountRow {
  readonly id: string;
  readonly key: string;
  readonly ref: AccountRef;
  readonly balance: bigint;
  readonly held: bigint;
}

/** Create missing accounts (idempotent) and return them keyed by account key. Does not lock. */
export async function ensureAccounts(c: Sql, refs: readonly AccountRef[]): Promise<Map<string, string>> {
  const byKey = new Map<string, AccountRef>();
  for (const ref of refs) byKey.set(accountKey(ref), ref);
  for (const [key, ref] of byKey) {
    const s = shape(ref);
    await c.query(
      `insert into ledger_accounts (id, account_key, mode, tenant_id, agent_id, class, holder, bucket, asset_ref, normal_side)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict (account_key) do nothing`,
      [uuidv7(), key, ref.mode, 'tenantId' in ref ? ref.tenantId : null, 'agentId' in ref ? ref.agentId : null, s.cls, s.holder, s.bucket, ref.assetRef, s.normal],
    );
  }
  const rows = await c.query<{ id: string; account_key: string }>('select id, account_key from ledger_accounts where account_key = any($1)', [[...byKey.keys()]]);
  return new Map(rows.rows.map((r) => [r.account_key, r.id]));
}

/**
 * Create and lock accounts in canonical key order (the single lock order shared by posting, reservation,
 * settlement, allocation and withdrawal). Call inside a transaction.
 */
export async function lockAccounts(c: Sql, refs: readonly AccountRef[]): Promise<Map<string, AccountRow>> {
  const ids = await ensureAccounts(c, refs);
  const byKey = new Map(refs.map((ref) => [accountKey(ref), ref]));
  const rows = await c.query<{ id: string; account_key: string; balance: string; held: string }>(
    'select id, account_key, balance, held from ledger_accounts where id = any($1) order by account_key for update',
    [[...ids.values()]],
  );
  if (rows.rowCount !== byKey.size) throw new AccountingError('NOT_FOUND', 'A ledger account could not be locked.');
  return new Map(rows.rows.map((r) => [r.account_key, { id: r.id, key: r.account_key, ref: byKey.get(r.account_key)!, balance: BigInt(r.balance), held: BigInt(r.held) }]));
}

export interface BalanceRow {
  readonly key: string;
  readonly kind: AccountRef['kind'];
  readonly bucket: Bucket | null;
  readonly assetRef: string;
  readonly balance: bigint;
  readonly held: bigint;
  readonly available: bigint;
}

/** Every account of one agent in one mode, unlocked (a display read, not an authorization input). */
export async function agentBalances(c: Sql, scope: AgentScope): Promise<BalanceRow[]> {
  const rows = await c.query<{ account_key: string; holder: string; bucket: Bucket | null; asset_ref: string; balance: string; held: string }>(
    `select account_key, holder, bucket, asset_ref, balance, held from ledger_accounts
     where tenant_id = $1 and agent_id = $2 and mode = $3 order by account_key`,
    [scope.tenantId, scope.agentId, scope.mode],
  );
  const kinds: Record<string, AccountRef['kind']> = { agentWallet: 'wallet', user: 'user', service: 'revenue' };
  return rows.rows.map((r) => {
    const balance = BigInt(r.balance);
    const held = BigInt(r.held);
    return { key: r.account_key, kind: kinds[r.holder]!, bucket: r.bucket, assetRef: r.asset_ref, balance, held, available: balance - held };
  });
}
