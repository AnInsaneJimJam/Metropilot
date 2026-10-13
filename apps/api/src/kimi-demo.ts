import type pg from 'pg';
import { contentHash } from '@monad-hack/contracts';
import type { Catalog } from '@monad-hack/strategy';
import { KIMI_MODEL } from './kimi-adapter.ts';

export const KIMI_DEMO_REF = 'paper.kimi-vercel';
const profile = Object.freeze({ mode: 'paper' as const, provider: 'kimi', modelId: KIMI_MODEL, maxTimeoutSeconds: 30, maxOutputTokens: 1024 });

/** Explicit local opt-in, with no credential in the user-facing API. Broker evidence still gates I/O. */
export function kimiDemoCatalog(base: Catalog, enabled: boolean): Catalog {
  return enabled ? { ...base, modelProfiles: { ...base.modelProfiles, [KIMI_DEMO_REF]: profile } } : base;
}

/** Add a distinct immutable profile; never convert an existing synthetic profile or running deployment. */
export async function registerKimiDemo(pool: pg.Pool): Promise<void> {
  const hash = await contentHash(profile);
  await pool.query(`insert into catalog_versions(kind,ref,version,modes,content_hash,definition)
    values('modelProfile',$1,'1.0.0',array['paper'],$2,$3) on conflict(ref,version) do nothing`, [KIMI_DEMO_REF, hash, profile]);
  const row = (await pool.query<{ content_hash: string; disabled_reason: string | null }>(
    "select content_hash,disabled_reason from catalog_versions where kind='modelProfile' and ref=$1 and version='1.0.0'", [KIMI_DEMO_REF])).rows[0];
  if (row?.content_hash !== hash || row.disabled_reason !== null) throw new Error('The Kimi demo profile is disabled or differs from its immutable version.');
}
