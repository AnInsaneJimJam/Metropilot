// User-facing funds (docs/specs/api-and-data.md section 4; funds-and-budgets.md sections 3, 6 and 7): custodial
// wallet provisioning, finalized balances, conserved allocation, runway quotes, step-up approvals, verified
// destinations and withdrawals. Live mode only; paper agents keep virtual budgets. Every money command is one
// short transaction; provider calls (wallet creation) run outside it. Withdrawals do not depend on a deployment.
import { createHash, randomInt } from 'node:crypto';
import pg from 'pg';
import { contentHash, validate } from '@monad-hack/contracts';
import type { GeneratedContractMap } from '@monad-hack/contracts';
import {
  AccountingError, agentBalances, allocate, balancedSplit, currentRateCard, hostingPerDay, modelCallCeiling, openFreezes, pendingDeposits,
  QUOTE_TTL_MILLIS, recommendForDays, requestWithdrawal, withdrawalById,
} from '@monad-hack/accounting';
import type { WithdrawalRow } from '@monad-hack/accounting';
import { provisionWallet, walletFor } from '@monad-hack/custody';
import type { CustodyConfig, CustodyProvider } from '@monad-hack/custody';
import { ControlError, newId } from './control.ts';

type Doc<K extends keyof GeneratedContractMap> = GeneratedContractMap[K];
type Purpose = 'withdrawal' | 'destination' | 'allocation' | 'livePolicy';

/** Delivers a one-time step-up code out of band (provider MFA in production, the server log locally). */
export interface StepUpDelivery {
  deliver(tenantId: string, challengeId: string, code: string, purpose: Purpose): Promise<void>;
}

export interface FundsOptions {
  readonly pool: pg.Pool;
  /** Absent: live custody is not configured and wallet provisioning answers CAPABILITY_DISABLED. */
  readonly custody?: { readonly provider: CustodyProvider; readonly config: CustodyConfig };
  readonly stepUp: StepUpDelivery;
  /** Local custody stand-in only: mint test assets into an agent wallet and finalize them. */
  readonly localFaucet?: (address: string, assetRef: string, amount: bigint) => Promise<void>;
  readonly now?: () => Date;
}

const STEP_UP_TTL_MILLIS = 5 * 60_000;
const iso = (d: Date): string => d.toISOString();
const sha = (s: string): string => `0x${createHash('sha256').update(s).digest('hex')}`;

/** Accounting failures in the shared API vocabulary. */
function apiError(error: unknown): never {
  if (error instanceof AccountingError) {
    const map: Record<string, [number, string]> = {
      INSUFFICIENT_BUDGET: [422, 'INSUFFICIENT_BUDGET'], DAILY_LIMIT_EXCEEDED: [422, 'POLICY_DENIED'], RECONCILIATION_REQUIRED: [409, 'RECONCILIATION_REQUIRED'],
      IDEMPOTENCY_CONFLICT: [409, 'IDEMPOTENCY_CONFLICT'], REVISION_CONFLICT: [409, 'REVISION_CONFLICT'], STATE_CONFLICT: [409, 'REVISION_CONFLICT'],
      NOT_FOUND: [404, 'NOT_FOUND'], INVALID: [422, 'SCHEMA_INVALID'],
    };
    const [status, code] = map[error.code]!;
    throw new ControlError(status, code, error.message);
  }
  throw error;
}

function checked<K extends keyof GeneratedContractMap>(kind: K, body: unknown): Doc<K> {
  const result = validate(kind, body);
  if (!result.ok) {
    const issue = result.issues[0]!;
    throw new ControlError(400, 'SCHEMA_INVALID', issue.message, { fieldPath: issue.fieldPath });
  }
  return result.value as Doc<K>;
}

/** The exact terms a step-up approves; a changed amount, asset or destination needs a new approval. */
function actionTerms(purpose: Purpose, agentId: string, body: Record<string, unknown>): Record<string, unknown> {
  if (purpose === 'withdrawal') return { purpose, agentId, assetRef: body['assetRef'], amount: body['amount'], destinationId: body['destinationId'] };
  if (purpose === 'destination') return { purpose, agentId, chainId: body['chainId'], address: body['address'], label: body['label'] };
  if (purpose === 'livePolicy') return { purpose, agentId, limits: body['limits'] };
  return { purpose, agentId, assetRef: body['assetRef'], expectedBudgetVersion: body['expectedBudgetVersion'], targets: body['targets'] };
}

export class FundsService {
  readonly #pool: pg.Pool;
  readonly #o: FundsOptions;
  readonly #now: () => Date;

  constructor(options: FundsOptions) {
    this.#pool = options.pool;
    this.#o = options;
    this.#now = options.now ?? (() => new Date());
  }

  get liveCustody(): boolean {
    return Boolean(this.#o.custody);
  }

  async #tx<T>(work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.#pool.connect();
    try {
      await c.query('begin');
      const result = await work(c);
      await c.query('commit');
      return result;
    } catch (error) {
      await c.query('rollback').catch(() => undefined);
      apiError(error);
    } finally {
      c.release();
    }
  }

  async #idempotent<T extends object>(c: pg.PoolClient, tenantId: string, scope: string, key: string, request: unknown, work: () => Promise<T>): Promise<T> {
    const hash = await contentHash(request);
    await c.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`${tenantId}:${scope}:${key}`]);
    const replay = await c.query<{ request_hash: string; response: T }>('select request_hash, response from control_requests where tenant_id = $1 and scope = $2 and key = $3', [tenantId, scope, key]);
    if (replay.rows[0]) {
      if (replay.rows[0].request_hash !== hash) throw new ControlError(409, 'IDEMPOTENCY_CONFLICT', 'This request key was already used for a different request.');
      return replay.rows[0].response;
    }
    const response = await work();
    await c.query('insert into control_requests (tenant_id, scope, key, request_hash, response) values ($1, $2, $3, $4, $5)', [tenantId, scope, key, hash, response]);
    return response;
  }

  async #agent(c: Pick<pg.ClientBase, 'query'>, tenantId: string, agentId: string): Promise<{ budget_version: number }> {
    const r = await c.query<{ budget_version: number }>('select budget_version from agents where tenant_id = $1 and id = $2', [tenantId, agentId]);
    if (!r.rows[0]) throw new ControlError(404, 'NOT_FOUND', 'Agent not found.');
    return r.rows[0];
  }

  #custody(): NonNullable<FundsOptions['custody']> {
    if (!this.#o.custody) throw new ControlError(503, 'CAPABILITY_DISABLED', 'Live custody is not configured; this workspace is paper-only until the wallet provider proof (E03) passes.');
    return this.#o.custody;
  }

  // ---- wallet and balances -------------------------------------------------------------------------------------

  async wallet(tenantId: string, agentId: string): Promise<Record<string, unknown>> {
    await this.#agent(this.#pool, tenantId, agentId);
    const { provider, config } = this.#custody();
    const w = await provisionWallet(this.#pool, provider, config, tenantId, agentId, this.#now());
    return {
      address: w.address, chainId: w.chainId, networkRef: w.networkRef, provider: w.provider,
      acceptedAssets: config.assets.filter((a) => a.funding).map((a) => ({ assetRef: a.assetRef, token: a.token, decimals: a.decimals })),
      // Trade proceeds the wallet can hold and withdraw but never receive as deposits (for display decimals).
      tradedAssets: (config.tradedAssets ?? []).map((a) => ({ assetRef: a.assetRef, token: a.token, decimals: a.decimals })),
      note: 'Deposits credit only after the block is finalized. Send only the listed assets; other tokens are quarantined, not credited.',
    };
  }

  async balances(tenantId: string, agentId: string): Promise<Doc<'agentFunds'>> {
    const agent = await this.#agent(this.#pool, tenantId, agentId);
    const scope = { mode: 'live' as const, tenantId, agentId };
    const chainId = this.#o.custody?.config.chainId;
    const w = chainId === undefined ? undefined : await walletFor(this.#pool, tenantId, agentId, chainId);
    const rows = await agentBalances(this.#pool, scope);
    const deposits = await pendingDeposits(this.#pool, tenantId, agentId);
    const freezes = await openFreezes(this.#pool, 'live', tenantId, agentId);
    return {
      schemaVersion: 'agent-funds/1', agentId, mode: 'live', budgetVersion: agent.budget_version,
      wallet: w ? { address: w.address, chainId: w.chainId, networkRef: w.networkRef, provider: w.provider as 'privy' | 'local' } : null,
      buckets: rows.filter((r) => r.kind === 'user').map((r) => ({ bucket: r.bucket!, assetRef: r.assetRef, balance: r.balance.toString(), held: r.held.toString(), available: r.available.toString() })),
      pendingDeposits: deposits.map((d) => ({
        txHash: d.txHash, logIndex: d.logIndex, ...(d.assetRef ? { assetRef: d.assetRef } : {}), amount: d.amount.toString(), state: d.state as 'pending' | 'quarantined', blockHeight: d.blockNumber.toString(),
      })),
      frozen: freezes.length > 0, freezeReasons: [...new Set(freezes.map((f) => f.reasonCode))], asOf: iso(this.#now()),
    };
  }

  get hasLocalFaucet(): boolean {
    return Boolean(this.#o.localFaucet);
  }

  /** Development stack only: test assets on the local chain, labelled local and never real. */
  async localFaucet(tenantId: string, agentId: string, body: unknown): Promise<{ address: string; assetRef: string; amount: string; note: string }> {
    if (!this.#o.localFaucet || !this.#o.custody) throw new ControlError(404, 'NOT_FOUND', 'Not found.');
    const b = body as { assetRef?: unknown; amount?: unknown } | null;
    if (!b || typeof b.assetRef !== 'string' || typeof b.amount !== 'string' || !/^[1-9][0-9]{0,30}$/.test(b.amount)) throw new ControlError(400, 'SCHEMA_INVALID', 'Send {assetRef, amount}.');
    const w = await walletFor(this.#pool, tenantId, agentId, this.#o.custody.config.chainId);
    if (!w) throw new ControlError(409, 'FUNDING_PENDING', 'Create the wallet first.');
    await this.#o.localFaucet(w.address, b.assetRef, BigInt(b.amount));
    return { address: w.address, assetRef: b.assetRef, amount: b.amount, note: 'Local test assets on the local chain; the scanner credits them after finality.' };
  }

  // ---- step-up ---------------------------------------------------------------------------------------------------

  async startStepUp(tenantId: string, body: unknown): Promise<{ challengeId: string; expiresAt: string; delivery: string }> {
    const request = checked('stepUpRequest', body) as unknown as Record<string, unknown> & { purpose: Purpose; agentId: string };
    await this.#agent(this.#pool, tenantId, request.agentId);
    const now = this.#now();
    const id = newId();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const actionHash = await contentHash(actionTerms(request.purpose, request.agentId, request));
    await this.#pool.query(
      `insert into step_up_challenges (tenant_id, id, purpose, action_hash, code_hash, created_at, expires_at) values ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, id, request.purpose, actionHash, sha(`${id}:${code}`), now, new Date(now.getTime() + STEP_UP_TTL_MILLIS)]);
    await this.#o.stepUp.deliver(tenantId, id, code, request.purpose);
    return { challengeId: id, expiresAt: iso(new Date(now.getTime() + STEP_UP_TTL_MILLIS)), delivery: 'out-of-band one-time code' };
  }

  async verifyStepUp(tenantId: string, challengeId: string, body: unknown): Promise<{ challengeId: string; verified: true }> {
    const { code } = checked('stepUpVerification', body);
    // A wrong code commits its attempt count before the refusal, so guessing is bounded.
    const matched = await this.#tx(async (c) => {
      const r = await c.query<{ code_hash: string; attempts: number; expires_at: Date; verified_at: Date | null }>(
        'select code_hash, attempts, expires_at, verified_at from step_up_challenges where tenant_id = $1 and id = $2 for update', [tenantId, challengeId]);
      const ch = r.rows[0];
      if (!ch) throw new ControlError(404, 'NOT_FOUND', 'Approval not found.');
      if (ch.verified_at) return true;
      if (ch.expires_at <= this.#now() || ch.attempts >= 5) throw new ControlError(409, 'REVISION_CONFLICT', 'This approval expired; start a new one.');
      if (sha(`${challengeId}:${code}`) !== ch.code_hash) {
        await c.query('update step_up_challenges set attempts = attempts + 1 where tenant_id = $1 and id = $2', [tenantId, challengeId]);
        return false;
      }
      await c.query('update step_up_challenges set verified_at = $3 where tenant_id = $1 and id = $2', [tenantId, challengeId, this.#now()]);
      return true;
    });
    if (!matched) throw new ControlError(403, 'FORBIDDEN', 'The code does not match.');
    return { challengeId, verified: true };
  }

  /** Consume a verified, unexpired approval for exactly these terms, inside the command's transaction. */
  async #consumeStepUp(c: pg.PoolClient, tenantId: string, stepUpId: string, purpose: Purpose, terms: Record<string, unknown>): Promise<void> {
    const r = await c.query<{ purpose: Purpose; action_hash: string; expires_at: Date; verified_at: Date | null; consumed_at: Date | null }>(
      'select purpose, action_hash, expires_at, verified_at, consumed_at from step_up_challenges where tenant_id = $1 and id = $2 for update', [tenantId, stepUpId]);
    const ch = r.rows[0];
    // Both bounds hold: the challenge's advertised expiry and the freshness window after verification.
    const now = this.#now().getTime();
    const fresh = ch?.verified_at && ch.verified_at.getTime() + STEP_UP_TTL_MILLIS > now && ch.expires_at.getTime() > now;
    if (!ch || !fresh || ch.consumed_at || ch.purpose !== purpose || ch.action_hash !== (await contentHash(terms))) {
      throw new ControlError(403, 'FORBIDDEN', 'A fresh step-up approval for these exact terms is required.', { fieldPath: '/stepUpId' });
    }
    await c.query('update step_up_challenges set consumed_at = $3 where tenant_id = $1 and id = $2', [tenantId, stepUpId, this.#now()]);
  }

  // ---- live trading caps (D61) ---------------------------------------------------------------------------------

  /**
   * Set the agent's live trading caps as a new immutable policy version. Consent is a step-up approval for exactly
   * these limits; the executor combines them with the platform limits by the most restrictive value.
   */
  async setLivePolicy(tenantId: string, agentId: string, body: unknown): Promise<{ policyVersion: number; limits: Record<string, unknown> }> {
    const request = checked('livePolicyRequest', body);
    return this.#tx(async (c) => {
      await this.#agent(c, tenantId, agentId);
      await c.query('select 1 from agents where tenant_id = $1 and id = $2 for update', [tenantId, agentId]);
      await this.#consumeStepUp(c, tenantId, request.stepUpId, 'livePolicy', actionTerms('livePolicy', agentId, request as unknown as Record<string, unknown>));
      const next = await c.query<{ version: number }>('select coalesce(max(version), 0) + 1 as version from policies where tenant_id = $1 and agent_id = $2', [tenantId, agentId]);
      // The approval that set these caps is recorded: a live launch must name it (deployment/1 stepUpApprovalId).
      const limits = { mode: 'live', ...request.limits, approvedBy: request.stepUpId };
      await c.query('insert into policies (tenant_id, agent_id, version, limits) values ($1, $2, $3, $4)', [tenantId, agentId, next.rows[0]!.version, limits]);
      return { policyVersion: next.rows[0]!.version, limits };
    });
  }

  // ---- allocation and quotes -------------------------------------------------------------------------------------

  async allocate(tenantId: string, agentId: string, body: unknown, key: string): Promise<Record<string, unknown>> {
    const request = checked('allocationRequest', body);
    return this.#tx((c) => this.#idempotent(c, tenantId, `POST /v1/agents/${agentId}/allocations`, key, request, async () => {
      await this.#agent(c, tenantId, agentId);
      const scope = { mode: 'live' as const, tenantId, agentId };
      const targets = Object.fromEntries(request.targets.map((t) => [t.bucket, BigInt(t.amount)]));
      if (request.targets.length !== Object.keys(targets).length) throw new ControlError(400, 'SCHEMA_INVALID', 'Each bucket appears once.', { fieldPath: '/targets' });
      // More trading funds is more financial authority: it needs a fresh step-up for these terms.
      const trading = (await agentBalances(c, scope)).find((b) => b.kind === 'user' && b.bucket === 'trading' && b.assetRef === request.assetRef)?.balance ?? 0n;
      if (targets['trading'] !== undefined && targets['trading'] > trading) {
        if (!request.stepUpId) throw new ControlError(403, 'FORBIDDEN', 'Increasing trading funds needs a step-up approval.', { fieldPath: '/stepUpId' });
        await this.#consumeStepUp(c, tenantId, request.stepUpId, 'allocation', actionTerms('allocation', agentId, request as unknown as Record<string, unknown>));
      }
      const result = await allocate(c, { scope, assetRef: request.assetRef, expectedBudgetVersion: request.expectedBudgetVersion, targets, actor: `user:${tenantId}`, now: this.#now() });
      return { budgetVersion: result.budgetVersion, balances: Object.entries(result.balances).map(([bucket, amount]) => ({ bucket, assetRef: request.assetRef, amount: amount.toString() })) };
    }));
  }

  async fundingQuote(tenantId: string, agentId: string, body: unknown): Promise<Doc<'fundingQuote'>> {
    const r = checked('fundingQuoteRequest', body);
    await this.#agent(this.#pool, tenantId, agentId);
    const now = this.#now();
    const hosting = await currentRateCard(this.#pool, 'hosting', 'live', r.resourceProfileRef, now);
    if (!hosting || hosting.assetRef !== r.assetRef) throw new ControlError(422, 'CAPABILITY_DISABLED', 'No hosting price is published for this profile and asset.', { fieldPath: '/resourceProfileRef' });
    let apiPerDay = 0n;
    const versions = [hosting.version];
    if (r.aiCallsPerDay > 0) {
      const model = r.modelProfileRef ? await currentRateCard(this.#pool, 'model', 'live', r.modelProfileRef, now) : undefined;
      if (!model || model.assetRef !== r.assetRef) throw new ControlError(422, 'CAPABILITY_DISABLED', 'No bounded price is published for this model profile.', { fieldPath: '/modelProfileRef' });
      apiPerDay = BigInt(r.aiCallsPerDay) * modelCallCeiling(model, { maxInputTokens: r.maxInputTokens, maxOutputTokens: r.maxOutputTokens, requests: 1 });
      versions.push(model.version);
    }
    const base = { depositAtomic: BigInt(r.depositAtomic), minTradingAtomic: BigInt(r.minTradingAtomic), gasAtomic: BigInt(r.gasAtomic), hostingPerDayAtomic: hostingPerDay(hosting), apiPerDayAtomic: apiPerDay, marginBps: r.marginBps };
    let allocations: { hosting: bigint; api: bigint; trading: bigint };
    let feasible: boolean;
    let shortfall = 0n;
    let runway: bigint | undefined;
    if (r.operatingDays !== undefined) {
      const plan = recommendForDays({ ...base, operatingDaysMilli: BigInt(r.operatingDays) * 1000n });
      allocations = { hosting: plan.hostingAtomic, api: plan.apiAtomic, trading: plan.tradingAtomic < 0n ? 0n : plan.tradingAtomic };
      feasible = plan.feasible;
      shortfall = plan.shortfallAtomic;
      if (feasible) runway = BigInt(r.operatingDays) * 86_400n;
    } else {
      const plan = balancedSplit(base);
      allocations = { hosting: plan.hostingAtomic, api: plan.apiAtomic, trading: plan.tradingAtomic };
      feasible = plan.feasible;
      if (!feasible) shortfall = -plan.operatingAtomic;
      runway = plan.runwaySeconds;
    }
    const id = newId();
    const doc: Doc<'fundingQuote'> = {
      schemaVersion: 'funding-quote/1', id, agentId, assetRef: r.assetRef, rateCardVersions: versions as [string, ...string[]],
      allocations: [
        { bucket: 'hosting', amount: allocations.hosting.toString() }, { bucket: 'api', amount: allocations.api.toString() }, { bucket: 'trading', amount: allocations.trading.toString() },
      ],
      gasAtomic: r.gasAtomic, feasible, shortfallAtomic: shortfall.toString(), ...(runway !== undefined ? { runwaySeconds: Number(runway) } : {}),
      dailyCost: [{ bucket: 'hosting', amount: base.hostingPerDayAtomic.toString() }, { bucket: 'api', amount: apiPerDay.toString() }],
      createdAt: iso(now), expiresAt: iso(new Date(now.getTime() + QUOTE_TTL_MILLIS)),
    };
    await this.#pool.query(
      `insert into funding_quotes (tenant_id, id, agent_id, mode, asset_ref, rate_card_versions, inputs, plan, created_at, expires_at) values ($1, $2, $3, 'live', $4, $5, $6, $7, $8, $9)`,
      [tenantId, id, agentId, r.assetRef, versions, r, doc, now, new Date(now.getTime() + QUOTE_TTL_MILLIS)]);
    return doc;
  }

  // ---- destinations and withdrawals ------------------------------------------------------------------------------

  async addDestination(tenantId: string, agentId: string, body: unknown, key: string): Promise<Record<string, unknown>> {
    const r = checked('destinationRequest', body);
    return this.#tx((c) => this.#idempotent(c, tenantId, `POST /v1/agents/${agentId}/withdrawal-destinations`, key, r, async () => {
      await this.#agent(c, tenantId, agentId);
      await this.#consumeStepUp(c, tenantId, r.stepUpId, 'destination', actionTerms('destination', agentId, r as unknown as Record<string, unknown>));
      const id = newId();
      // Replacing an address for the same chain revokes the old one; its approvals no longer apply.
      await c.query(`update withdrawal_destinations set revoked_at = $3 where tenant_id = $1 and agent_id = $2 and chain_id = $4 and revoked_at is null`, [tenantId, agentId, this.#now(), r.chainId]);
      await c.query(`insert into withdrawal_destinations (tenant_id, id, agent_id, chain_id, address, label, step_up_id, verified_at) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [tenantId, id, agentId, r.chainId, r.address, r.label, r.stepUpId, this.#now()]);
      return { id, chainId: r.chainId, address: r.address, label: r.label, verifiedAt: iso(this.#now()) };
    }));
  }

  async withdraw(tenantId: string, agentId: string, body: unknown, key: string): Promise<Doc<'withdrawal'>> {
    const r = checked('withdrawalRequest', body);
    const { config } = this.#custody();
    const requestHash = await contentHash({ agentId, ...r });
    const row = await this.#tx(async (c) => {
      await c.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`${tenantId}:withdrawal:${key}`]);
      await this.#agent(c, tenantId, agentId);
      const prior = await c.query<{ id: string; request_hash: string }>('select id, request_hash from withdrawals where tenant_id = $1 and idempotency_key = $2', [tenantId, key]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash) throw new ControlError(409, 'IDEMPOTENCY_CONFLICT', 'This request key was already used for a different withdrawal.');
        return (await withdrawalById(c, tenantId, prior.rows[0].id))!;
      }
      const dest = await c.query<{ chain_id: number }>('select chain_id from withdrawal_destinations where tenant_id = $1 and id = $2 and agent_id = $3 and revoked_at is null', [tenantId, r.destinationId, agentId]);
      if (!dest.rows[0] || dest.rows[0].chain_id !== config.chainId) throw new ControlError(422, 'UNKNOWN_REFERENCE', 'Withdraw only to a verified destination on this network.', { fieldPath: '/destinationId' });
      // Funding assets and trade proceeds (traded assets) are withdrawable; neither list credits the other.
      const asset = [...config.assets, ...(config.tradedAssets ?? [])].find((a) => a.assetRef === r.assetRef);
      if (!asset) throw new ControlError(422, 'UNKNOWN_REFERENCE', 'This asset cannot be withdrawn on this network.', { fieldPath: '/assetRef' });
      const w = await walletFor(c, tenantId, agentId, config.chainId);
      if (!w) throw new ControlError(409, 'FUNDING_PENDING', 'This agent has no wallet.');
      await this.#consumeStepUp(c, tenantId, r.stepUpId, 'withdrawal', actionTerms('withdrawal', agentId, r as unknown as Record<string, unknown>));
      const { withdrawal } = await requestWithdrawal(c, {
        tenantId, agentId, idempotencyKey: key, requestHash, walletId: w.id, destinationId: r.destinationId, assetRef: r.assetRef, amount: BigInt(r.amount),
        gasAssetRef: config.gasAssetRef, gasCeiling: WITHDRAWAL_GAS_CEILING, stepUpId: r.stepUpId, now: this.#now(),
      });
      return withdrawal;
    });
    return this.#withdrawalDoc(row);
  }

  async withdrawal(tenantId: string, id: string): Promise<Doc<'withdrawal'>> {
    const w = await withdrawalById(this.#pool, tenantId, id);
    if (!w) throw new ControlError(404, 'NOT_FOUND', 'Withdrawal not found.');
    return this.#withdrawalDoc(w);
  }

  async #withdrawalDoc(w: WithdrawalRow): Promise<Doc<'withdrawal'>> {
    const d = await this.#pool.query<{ id: string; chain_id: number; address: string; label: string }>('select id, chain_id, address, label from withdrawal_destinations where tenant_id = $1 and id = $2', [w.tenantId, w.destinationId]);
    const dest = d.rows[0]!;
    return {
      schemaVersion: 'withdrawal/1', id: w.id, agentId: w.agentId, state: w.state, assetRef: w.assetRef, amount: w.amount.toString(), gasAssetRef: w.gasAssetRef,
      gasCeiling: w.gasCeiling.toString(), destination: { id: dest.id, chainId: dest.chain_id, address: dest.address, label: dest.label },
      ...(w.txHash ? { transactionHash: w.txHash } : {}), ...(w.gasUsed !== undefined ? { gasUsed: w.gasUsed.toString() } : {}),
      ...(w.failureReason ? { failureReason: w.failureReason } : {}), createdAt: iso(w.createdAt), updatedAt: iso(w.updatedAt),
    };
  }
}

/** Native fee ceiling held for one ERC-20 or native transfer (100k gas at 100 gwei); actual fee is charged. */
export const WITHDRAWAL_GAS_CEILING = 100_000n * 100_000_000_000n;
