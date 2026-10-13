// Live launch helpers (D61). A live agent runs a saved, paper-tested strategy: its paper refs are mapped to their
// live twins, declared by the newest enabled live catalog rows (`paperTwin`), and the result is stored as a derived,
// immutable revision with its provenance. Live v1 runs schedule triggers and swaps only: the API Broker serves paper
// deployments only and no live price feed exists yet, so read, ai.decide and price triggers are refused up front.
import type { Strategy } from '@monad-hack/contracts';
import { ControlError } from './control.ts';

/** Where live launches trade: the custody network, its chain and the gas asset reserve required before launch. */
export interface LiveLaunchOptions {
  readonly networkRef: string;
  readonly chainId: number;
  readonly gasAssetRef: string;
  /** Trading MON the agent must hold before a live launch (the executor's native reserve plus one trade's gas). */
  readonly minTradingGasAtomic: bigint;
}

type Queryable = { query: <R extends Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> };

/** paper ref → live ref, from the newest enabled live row of each ref that names a paper twin. */
export async function liveTwins(db: Queryable, networkRef: string): Promise<Map<string, string>> {
  const { rows } = await db.query<{ ref: string; twin: string }>(
    `select distinct on (ref) ref, definition ->> 'paperTwin' as twin from catalog_versions
     where 'live' = any(modes) and disabled_reason is null and definition ? 'paperTwin'
       and coalesce(definition -> 'identity' ->> 'networkRef', definition ->> 'networkRef') = $1
     order by ref, string_to_array(version, '.')::int[] desc`, [networkRef]);
  return new Map(rows.map((r) => [r.twin, r.ref]));
}

const REF_KEYS = new Set(['connectorRef', 'tokenInRef', 'tokenOutRef', 'assetRef', 'baseAssetRef', 'feedRef', 'modelProfileRef']);

/** The strategy with every paper ref replaced by its live twin; refuses anything live v1 cannot run. */
export function promoteStrategy(strategy: Strategy, twins: ReadonlyMap<string, string>): Strategy {
  const refuse = (message: string): never => {
    throw new ControlError(422, 'UNSUPPORTED_CAPABILITY', message);
  };
  for (const trigger of strategy.triggers) {
    if (trigger.type !== 'schedule') refuse('Live agents run on schedule triggers for now; price triggers need a live price feed.');
  }
  const unmapped = new Set<string>();
  const map = (value: unknown, key?: string): unknown => {
    if (Array.isArray(value)) return value.map((v) => map(v));
    if (value && typeof value === 'object') {
      const node = value as Record<string, unknown>;
      if (node['type'] === 'read' || node['type'] === 'ai.decide') refuse('Live agents cannot use market reads or AI decisions yet; remove those steps to launch live.');
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, map(v, k)]));
    }
    if (typeof value === 'string' && key && REF_KEYS.has(key) && value.startsWith('paper.')) {
      const twin = twins.get(value);
      if (!twin) unmapped.add(value);
      return twin ?? value;
    }
    return value;
  };
  const promoted = map(strategy) as Strategy;
  if (unmapped.size) refuse(`These paper references have no live equivalent: ${[...unmapped].sort().join(', ')}.`);
  return promoted;
}
