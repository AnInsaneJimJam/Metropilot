// Catalog resolution from catalog_versions (API-2, issue #18; docs/specs/api-and-data.md section 3, decision D55).
// Compilation and launch build the strategy Catalog from enabled, immutable catalog rows instead of the synthetic
// one, and a deployment pins the exact rows it used (deployment-manifest/2 catalogPins). Definitions are platform
// data, not trusted code: each is hash-checked against its row and shape-checked before it reaches the compiler.
// Paper and live registries stay distinct: a resolve for one mode never reads a row that does not declare it.
import type pg from 'pg';
import { contentHash } from '@monad-hack/contracts';
import type { Catalog, RecordType } from '@monad-hack/strategy';
import { ControlError } from './control.ts';

export type CatalogKind = 'network' | 'connector' | 'asset' | 'feed' | 'modelProfile' | 'resourceProfile';
export type CatalogMode = 'paper' | 'live';
export interface CatalogPin { readonly kind: CatalogKind; readonly ref: string; readonly version: string; readonly contentHash: string }
export interface ResolvedCatalog {
  readonly catalog: Catalog;
  readonly pins: readonly CatalogPin[];
  /** Capabilities each resolved connector offers (its definition's `capabilities`), for checking selections. */
  readonly capabilities: Readonly<Record<string, readonly string[]>>;
}

export interface ResolveInput {
  readonly mode: CatalogMode;
  /** The deployment's network; absent for draft compilation, which sees every enabled network of the mode. */
  readonly networkRef?: string;
  /** Exact versions the deployment request selected; other refs resolve to their newest enabled version. */
  readonly connectors?: Readonly<Record<string, string>>;
  readonly modelProfiles?: Readonly<Record<string, string>>;
  readonly resourceProfileRef?: string;
}

type Queryable = pg.Pool | pg.PoolClient;

type Row = {
  kind: CatalogKind;
  ref: string;
  version: string;
  modes: string[];
  content_hash: string;
  definition: unknown;
  disabled_reason: string | null;
};

const KIND_ORDER: readonly CatalogKind[] = ['network', 'asset', 'connector', 'feed', 'modelProfile', 'resourceProfile'];
const KIND_LABEL: Record<CatalogKind, string> = {
  network: 'network', connector: 'connector', asset: 'asset', feed: 'price feed', modelProfile: 'model profile', resourceProfile: 'resource profile',
};
const SEMVER = /^\d+\.\d+\.\d+$/;
const VENUES = new Set(['uniswap-v3', 'kuru', 'curve', 'aave']);
const SCALAR_TYPES = new Set(['Boolean', 'Integer', 'Decimal', 'Timestamp', 'Enum', 'Text']);
const REF = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9][A-Za-z0-9_-]*)*$/;

const compareVersions = (a: string, b: string): number => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
};

// ---- definition shapes -----------------------------------------------------------------------------------------
// Each check returns the Catalog entry for a well-formed definition, or undefined. Rows published before the
// complete format (the thin 1.0.0 seed rows) fail here and are never compiled against.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isRef = (v: unknown): v is string => typeof v === 'string' && v.length <= 128 && REF.test(v);
const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isText = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max;
const isStringList = (v: unknown, max = 32): v is string[] => Array.isArray(v) && v.length <= max && v.every((s) => isText(s, 64));

function recordType(v: unknown): RecordType | undefined {
  if (!isObj(v) || Object.keys(v).length > 32) return undefined;
  for (const [name, field] of Object.entries(v)) {
    if (!/^[a-z][A-Za-z0-9]{0,31}$/.test(name) || !isObj(field)) return undefined;
    const keys = Object.keys(field).sort().join();
    if (field['valueType'] === 'Price' ? keys !== 'baseAssetRef,quoteUnit,valueType' || !isRef(field['baseAssetRef']) || !isText(field['quoteUnit'], 16)
      : field['valueType'] === 'Money' ? keys !== 'assetRef,valueType' || !isRef(field['assetRef'])
        : keys !== 'valueType' || !SCALAR_TYPES.has(String(field['valueType']))) return undefined;
  }
  return v as RecordType;
}

const shapes = {
  network(d: Obj) {
    if (!isInt(d['blockMillis'], 1, 600_000) || !isInt(d['finalityBlocks'], 0, 10_000)) return undefined;
    return { blockMillis: d['blockMillis'], finalityBlocks: d['finalityBlocks'] };
  },
  asset(d: Obj, mode: CatalogMode) {
    const identity = d['identity'];
    if (!isObj(identity) || !isRef(identity['networkRef']) || !isInt(d['decimals'], 0, 36)) return undefined;
    // A paper resolve accepts only paper identities; a live resolve never accepts one.
    if ((identity['kind'] === 'paper') !== (mode === 'paper')) return undefined;
    if (d['native'] !== undefined && d['native'] !== true) return undefined;
    return { networkRef: identity['networkRef'], mode, decimals: d['decimals'], ...(d['native'] ? { native: true as const } : {}) };
  },
  feed(d: Obj) {
    if (!isRef(d['networkRef']) || !isRef(d['baseAssetRef']) || !isText(d['quoteUnit'], 16) || !isRef(d['connectorRef'])) return undefined;
    // A native oracle has no averaging window (0); pool TWAP and EMA feeds average over at least a second.
    const source = d['source'];
    if ((source !== 'poolTwap' && source !== 'poolEma' && source !== 'nativeOracle') || d['finality'] !== 'finalized') return undefined;
    if (!isInt(d['windowSeconds'], source === 'nativeOracle' ? 0 : 1, 86_400)) return undefined;
    // Optional: the connector row version this feed serves (two versions of one connector can read different pools).
    if (d['connectorVersion'] !== undefined && !SEMVER.test(String(d['connectorVersion']))) return undefined;
    return {
      networkRef: d['networkRef'],
      connectorVersion: d['connectorVersion'] as string | undefined,
      entry: { baseAssetRef: d['baseAssetRef'], quoteUnit: d['quoteUnit'], source, connectorRef: d['connectorRef'], windowSeconds: d['windowSeconds'], finality: 'finalized' as const },
    };
  },
  connector(d: Obj, mode: CatalogMode) {
    if (!isRef(d['networkRef']) || !isText(d['adapterVersion'], 64) || !VENUES.has(String(d['venue']))) return undefined;
    if (!isStringList(d['actions']) || !isStringList(d['capabilities']) || !isObj(d['reads'])) return undefined;
    const reads: Record<string, { arguments: RecordType; result: RecordType; maxAgeSeconds: number }> = {};
    for (const [operation, read] of Object.entries(d['reads'])) {
      if (!isText(operation, 64) || !isObj(read) || !isInt(read['maxAgeSeconds'], 1, 86_400)) return undefined;
      const args = recordType(read['arguments']);
      const result = recordType(read['result']);
      if (!args || !result) return undefined;
      reads[operation] = { arguments: args, result, maxAgeSeconds: read['maxAgeSeconds'] };
    }
    return {
      entry: { networkRef: d['networkRef'], mode, version: d['adapterVersion'], venue: d['venue'] as Catalog['connectors'][string]['venue'], actions: [...d['actions']] },
      reads,
    };
  },
  modelProfile(d: Obj, mode: CatalogMode) {
    if (!isText(d['provider'], 64) || !isText(d['modelId'], 128) || !isInt(d['maxTimeoutSeconds'], 1, 600) || !isInt(d['maxOutputTokens'], 1, 65_536)) return undefined;
    return { mode, provider: d['provider'], modelId: d['modelId'], maxTimeoutSeconds: d['maxTimeoutSeconds'], maxOutputTokens: d['maxOutputTokens'] };
  },
  resourceProfile(d: Obj) {
    // Sizing arrives with hosted runtimes (G4); until then a profile is a pinned, described reference.
    return isText(d['note'], 500) ? {} : undefined;
  },
};

/** Whether a definition has the complete shape for its kind (the resolver skips or refuses rows that do not). */
export function wellFormed(kind: CatalogKind, definition: unknown, mode: CatalogMode): boolean {
  return isObj(definition) && shapes[kind](definition, mode) !== undefined;
}

// ---- resolver ------------------------------------------------------------------------------------------------

export class CatalogResolver {
  /**
   * Build the Catalog a compile or launch uses, and the rows it came from. Selected connector and model versions
   * must be enabled and well formed or the call refuses with the reason; every other entry is the newest enabled
   * version of its ref, left out when that version is malformed. Entries for another network, and feeds whose
   * connector or base asset is absent, are left out so the catalog never references something it lacks.
   */
  async resolve(db: Queryable, input: ResolveInput): Promise<ResolvedCatalog> {
    const rows = await this.#rows(db, input.mode);
    const chosen = new Map<string, Row>();
    const key = (kind: string, ref: string) => `${kind}\u0000${ref}`;
    for (const row of rows) {
      if (row.disabled_reason !== null) continue;
      const current = chosen.get(key(row.kind, row.ref));
      if (!current || compareVersions(row.version, current.version) > 0) chosen.set(key(row.kind, row.ref), row);
    }
    // Exact selections replace the newest version; each must exist, be enabled and be well formed.
    const select = (kind: CatalogKind, selections: Readonly<Record<string, string>> | undefined, fieldPath: string): void => {
      for (const [ref, version] of Object.entries(selections ?? {})) {
        const row = rows.find((r) => r.kind === kind && r.ref === ref && r.version === version);
        this.#usable(row, kind, ref, version, input.mode, fieldPath);
        chosen.set(key(kind, ref), row!);
      }
    };
    select('connector', input.connectors, '/connectorSelections');
    select('modelProfile', input.modelProfiles, '/modelProfiles');

    if (input.networkRef !== undefined) {
      const network = chosen.get(key('network', input.networkRef));
      this.#usable(network, 'network', input.networkRef, undefined, input.mode, '/networkRef');
    }
    if (input.resourceProfileRef !== undefined) {
      const profile = chosen.get(key('resourceProfile', input.resourceProfileRef));
      this.#usable(profile, 'resourceProfile', input.resourceProfileRef, undefined, input.mode, '/resourceProfileRef');
    }

    const catalog = { networks: {}, assets: {}, feeds: {}, connectors: {}, reads: {}, modelProfiles: {} } as {
      networks: Record<string, unknown>; assets: Record<string, unknown>; feeds: Record<string, unknown>;
      connectors: Record<string, unknown>; reads: Record<string, unknown>; modelProfiles: Record<string, unknown>;
    };
    const used: Row[] = [];
    const capabilities: Record<string, readonly string[]> = {};
    const onNetwork = (networkRef: unknown) => input.networkRef === undefined || networkRef === input.networkRef;
    const ordered = [...chosen.values()].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.ref < b.ref ? -1 : 1));
    const pending: { row: Row; feed: { networkRef: unknown; connectorVersion: string | undefined; entry: { baseAssetRef: string; connectorRef: string } } }[] = [];
    for (const row of ordered) {
      if (!isObj(row.definition)) continue;
      const d = row.definition;
      switch (row.kind) {
        case 'network': {
          const entry = shapes.network(d);
          if (entry && (input.networkRef === undefined || row.ref === input.networkRef)) {
            catalog.networks[row.ref] = entry;
            used.push(row);
          }
          break;
        }
        case 'asset': {
          const entry = shapes.asset(d, input.mode);
          if (entry && onNetwork(entry.networkRef)) {
            catalog.assets[row.ref] = entry;
            used.push(row);
          }
          break;
        }
        case 'connector': {
          const shaped = shapes.connector(d, input.mode);
          if (shaped && onNetwork(shaped.entry.networkRef)) {
            catalog.connectors[row.ref] = shaped.entry;
            catalog.reads[row.ref] = shaped.reads;
            capabilities[row.ref] = d['capabilities'] as string[];
            used.push(row);
          } else if (input.connectors?.[row.ref]) {
            throw new ControlError(422, 'UNSUPPORTED_CAPABILITY', `${row.ref}@${row.version} is not on ${input.networkRef}.`, { fieldPath: '/connectorSelections' });
          }
          break;
        }
        case 'feed': {
          const feed = shapes.feed(d);
          if (feed && onNetwork(feed.networkRef)) pending.push({ row, feed });
          break;
        }
        case 'modelProfile': {
          const entry = shapes.modelProfile(d, input.mode);
          if (entry) {
            catalog.modelProfiles[row.ref] = entry;
            used.push(row);
          }
          break;
        }
        case 'resourceProfile':
          if (shapes.resourceProfile(d) && row.ref === input.resourceProfileRef) used.push(row);
          break;
      }
    }
    for (const { row, feed } of pending) {
      if (!catalog.connectors[feed.entry.connectorRef] || !catalog.assets[feed.entry.baseAssetRef]) continue;
      // A launch that selects another version of the feed's connector does not get this feed: the broker needs the
      // one feed the pinned connector reads. Drafts select nothing, so every enabled feed stays available to them.
      const selected = input.connectors?.[feed.entry.connectorRef];
      if (selected !== undefined && feed.connectorVersion !== undefined && feed.connectorVersion !== selected) continue;
      catalog.feeds[row.ref] = feed.entry;
      used.push(row);
    }
    used.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.ref < b.ref ? -1 : 1));
    return {
      catalog: catalog as unknown as Catalog,
      pins: used.map((r) => ({ kind: r.kind, ref: r.ref, version: r.version, contentHash: r.content_hash })),
      capabilities,
    };
  }

  /**
   * Refuse when a deployment's pinned rows can no longer be used (disabled, gone or changed). Pins without a hash
   * come from deployment-manifest/1, which recorded only connector and model versions.
   */
  async checkPins(db: Queryable, mode: CatalogMode, pins: readonly { kind: CatalogKind; ref: string; version: string; contentHash?: string }[]): Promise<void> {
    if (pins.length === 0) return;
    const { rows } = await db.query<Pick<Row, 'kind' | 'ref' | 'version' | 'modes' | 'content_hash' | 'disabled_reason'>>(
      'select kind, ref, version, modes, content_hash, disabled_reason from catalog_versions where (ref, version) in (select * from unnest($1::text[], $2::text[]))',
      [pins.map((p) => p.ref), pins.map((p) => p.version)],
    );
    for (const pin of pins) {
      const row = rows.find((r) => r.ref === pin.ref && r.version === pin.version);
      const label = `${KIND_LABEL[pin.kind]} ${pin.ref}@${pin.version}`;
      if (!row || row.kind !== pin.kind || !row.modes.includes(mode)) throw new ControlError(422, 'UNSUPPORTED_CAPABILITY', `The pinned ${label} is no longer in the ${mode} catalog; launch a new deployment.`);
      if (pin.contentHash && row.content_hash !== pin.contentHash) throw new ControlError(500, 'INTERNAL_ERROR', `The pinned ${label} no longer matches its recorded hash.`);
      if (row.disabled_reason !== null) throw new ControlError(422, 'UNSUPPORTED_CAPABILITY', `The pinned ${label} was disabled: ${row.disabled_reason}`);
    }
  }

  /** Newest usable version per connector and model profile, for building a deployment request. */
  async latestVersions(db: Queryable, mode: CatalogMode): Promise<{ connectors: Record<string, string>; modelProfiles: Record<string, string> }> {
    const { catalog, pins } = await this.resolve(db, { mode });
    const out = { connectors: {} as Record<string, string>, modelProfiles: {} as Record<string, string> };
    for (const pin of pins) {
      if (pin.kind === 'connector' && catalog.connectors[pin.ref]) out.connectors[pin.ref] = pin.version;
      if (pin.kind === 'modelProfile' && catalog.modelProfiles[pin.ref]) out.modelProfiles[pin.ref] = pin.version;
    }
    return out;
  }

  /** Every row of the mode, each checked against its stored content hash. */
  async #rows(db: Queryable, mode: CatalogMode): Promise<Row[]> {
    const { rows } = await db.query<Row>(
      'select kind, ref, version, modes, content_hash, definition, disabled_reason from catalog_versions where $1 = any(modes)', [mode],
    );
    for (const row of rows) {
      if ((await contentHash(row.definition)) !== row.content_hash) {
        throw new ControlError(500, 'INTERNAL_ERROR', `Catalog entry ${row.ref}@${row.version} failed its integrity check.`);
      }
    }
    return rows;
  }

  /** A selected or required row: present, enabled and well formed, or a readable refusal. */
  #usable(row: Row | undefined, kind: CatalogKind, ref: string, version: string | undefined, mode: CatalogMode, fieldPath: string): asserts row is Row {
    const label = `${ref}${version ? `@${version}` : ''}`;
    if (!row) throw new ControlError(422, 'UNSUPPORTED_CAPABILITY', `${label} is not an enabled ${mode} ${KIND_LABEL[kind]}.`, { fieldPath });
    if (row.disabled_reason !== null) throw new ControlError(422, 'UNSUPPORTED_CAPABILITY', `${label} is disabled: ${row.disabled_reason}`, { fieldPath });
    if (!wellFormed(kind, row.definition, mode)) {
      throw new ControlError(422, 'UNSUPPORTED_CAPABILITY', `${label} predates the complete catalog format; select a newer version.`, { fieldPath });
    }
  }
}
