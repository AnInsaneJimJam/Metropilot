// Synthetic paper seed data: every row and catalog entry referenced by the normative deployment/1 and
// strategy/1 examples. IDs and refs are read from the contracts fixtures so they cannot drift from the specs.
// Seeds are local/CI test data only; they never describe real networks, contracts or accounts.
import { catalogSeeds } from '@monad-hack/connectors/registry';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contentHash, validate, type DeploymentRequest, type Strategy } from '@monad-hack/contracts';
import { syntheticCatalog } from '@monad-hack/strategy';
import type pg from 'pg';

const fixture = (path: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(import.meta.resolve(`@monad-hack/contracts/fixtures/${path}`)), 'utf8'));

function validFixture<K extends 'strategy' | 'deploymentRequest'>(kind: K, path: string) {
  const result = validate(kind, fixture(path));
  if (!result.ok) throw new Error(`seed fixture ${path} is invalid: ${JSON.stringify(result.issues)}`);
  return result.value;
}

export const seedTenantId = '019a0000-0000-7000-8000-000000000000';

type CatalogSeed = { kind: string; ref: string; version: string; modes: string[]; definition: Record<string, unknown> };

export function paperSeed() {
  const request: DeploymentRequest = validFixture('deploymentRequest', 'deploymentRequest/valid/spec-paper-request.json');
  const strategy: Strategy = validFixture('strategy', 'strategy/valid/spec-threshold-sale.json');
  const paper = ['paper'];
  const paperAsset = (assetRef: string, decimals: number): CatalogSeed => ({
    kind: 'asset',
    ref: assetRef,
    version: '1.0.0',
    modes: paper,
    definition: { identity: { kind: 'paper', networkRef: request.networkRef, assetRef }, decimals },
  });
  const catalog: CatalogSeed[] = [
    { kind: 'network', ref: request.networkRef, version: '1.0.0', modes: paper, definition: { registry: 'paper', finality: 'simulated' } },
    ...request.connectorSelections.map((selection) => ({
      kind: 'connector',
      ref: selection.ref,
      version: selection.version,
      modes: paper,
      definition: { networkRef: request.networkRef, capabilities: ['price.read', 'swap.quote', 'swap.exactInput'] },
    })),
    paperAsset('paper.WETH', 18),
    paperAsset('paper.USD', 6),
    paperAsset('paper.MON', 18),
    // The second paper venue and the synthetic model profile the presets use (strategy syntheticCatalog).
    { kind: 'connector', ref: 'paper.kuru', version: '1.0.0', modes: paper, definition: { networkRef: request.networkRef, capabilities: ['price.read', 'swap.quote', 'swap.exactInput'] } },
    {
      kind: 'feed', ref: 'paper.weth-usd-kuru', version: '1.0.0', modes: paper,
      definition: { networkRef: request.networkRef, baseAssetRef: 'paper.WETH', quoteUnit: 'USD', source: 'recorded' },
    },
    { kind: 'modelProfile', ref: 'paper.kimi', version: '1.0.0', modes: paper, definition: { provider: 'synthetic', note: 'Scripted answers; no model is called.' } },
    {
      kind: 'feed',
      ref: 'paper.weth-usd',
      version: '1.0.0',
      modes: paper,
      definition: { networkRef: request.networkRef, baseAssetRef: 'paper.WETH', quoteUnit: 'USD', source: 'recorded' },
    },
    {
      kind: 'resourceProfile',
      ref: request.resourceProfileRef,
      version: '1.0.0',
      modes: paper,
      definition: { note: 'Synthetic paper profile; CPU/memory sizing is measured at G4.' },
    },
    ...completePaperCatalog(),
  ];
  return { request, strategy, catalog: [...catalog, ...catalogSeeds()] };
}

/**
 * Version 1.1.0 of every paper entry: the complete definitions the API compiles against (issue #18, D42). The 1.0.0
 * rows above predate this format and stay for the records and executor fixtures that pin them; catalog rows are
 * immutable, so completing them means publishing new versions. Built from the strategy package's synthetic
 * catalog so the database registry and the offline rehearsal catalog cannot drift. Existing keys the executor
 * reads (connector networkRef/capabilities, asset identity) keep their meaning.
 */
function completePaperCatalog(): CatalogSeed[] {
  const c = JSON.parse(JSON.stringify(syntheticCatalog)) as typeof syntheticCatalog;
  const paper = ['paper'];
  const version = '1.1.0';
  return [
    ...Object.entries(c.networks).map(([ref, n]) => ({
      kind: 'network', ref, version, modes: paper, definition: { registry: 'paper', finality: 'simulated', ...n },
    })),
    ...Object.entries(c.assets).map(([ref, a]) => ({
      kind: 'asset', ref, version, modes: paper,
      definition: { identity: { kind: 'paper', networkRef: a.networkRef, assetRef: ref }, decimals: a.decimals, ...(a.native ? { native: true } : {}) },
    })),
    ...Object.entries(c.connectors).map(([ref, k]) => ({
      kind: 'connector', ref, version, modes: paper,
      definition: {
        networkRef: k.networkRef, capabilities: ['price.read', 'swap.quote', 'swap.exactInput'],
        adapterVersion: k.version, venue: k.venue, actions: k.actions, reads: c.reads[ref] ?? {},
      },
    })),
    ...Object.entries(c.feeds).map(([ref, f]) => ({
      kind: 'feed', ref, version, modes: paper, definition: { networkRef: c.connectors[f.connectorRef]!.networkRef, ...f },
    })),
    ...Object.entries(c.modelProfiles).map(([ref, m]) => ({
      kind: 'modelProfile', ref, version, modes: paper,
      definition: { provider: m.provider, modelId: m.modelId, maxTimeoutSeconds: m.maxTimeoutSeconds, maxOutputTokens: m.maxOutputTokens, note: 'Scripted answers; no model is called.' },
    })),
  ];
}

/** Insert the paper seed in one transaction. Re-running is a no-op; a conflicting existing row is an error. */
export async function seedPaper(client: pg.Client): Promise<void> {
  const { request, strategy, catalog } = paperSeed();
  const revisionHash = await contentHash(strategy);
  await client.query('begin');
  try {
    for (const entry of catalog) {
      const hash = await contentHash(entry.definition);
      await client.query(
        `insert into catalog_versions (kind, ref, version, modes, content_hash, definition)
         values ($1, $2, $3, $4, $5, $6) on conflict (ref, version) do nothing`,
        [entry.kind, entry.ref, entry.version, entry.modes, hash, entry.definition],
      );
      const { rows } = await client.query<{ content_hash: string }>(
        'select content_hash from catalog_versions where ref = $1 and version = $2',
        [entry.ref, entry.version],
      );
      if (rows[0]?.content_hash !== hash) throw new Error(`catalog ${entry.ref}@${entry.version} exists with different content`);
    }
    await client.query(
      `insert into tenants (id, auth_subject) values ($1, 'synthetic|paper-demo') on conflict do nothing`,
      [seedTenantId],
    );
    await client.query(
      `insert into agents (tenant_id, id, name, budget_version) values ($1, $2, 'Paper threshold demo', $3)
       on conflict do nothing`,
      [seedTenantId, request.agentId, request.budgetVersion],
    );
    await client.query(
      `insert into strategy_revisions (tenant_id, id, agent_id, language_version, content_hash, ast, validation)
       values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing`,
      [
        seedTenantId,
        request.strategyRevisionId,
        request.agentId,
        strategy.schemaVersion,
        revisionHash,
        strategy,
        { schema: 'valid', semantic: 'pending G2 validator' },
      ],
    );
    const { rows } = await client.query<{ content_hash: string }>('select content_hash from strategy_revisions where id = $1', [
      request.strategyRevisionId,
    ]);
    if (rows[0]?.content_hash !== revisionHash) throw new Error('seed strategy revision exists with different content');
    await client.query(
      `insert into policies (tenant_id, agent_id, version, limits) values ($1, $2, $3, $4) on conflict do nothing`,
      [seedTenantId, request.agentId, request.policyVersion, { maxSlippageBps: 50, dailyActionCount: 24 }],
    );
    await client.query(
      `insert into estimates (tenant_id, id, agent_id, strategy_revision_id, assumptions, created_at, expires_at)
       values ($1, $2, $3, $4, $5, '2026-10-01T00:00:00.000Z', '2026-10-01T00:05:00.000Z') on conflict do nothing`,
      [seedTenantId, request.estimateId, request.agentId, request.strategyRevisionId, { note: 'Synthetic fixture; not a priced quote.' }],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}
