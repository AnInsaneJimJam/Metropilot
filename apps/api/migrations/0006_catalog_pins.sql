-- Catalog resolution (API-2, issue #18, decision D42). New deployments carry deployment-manifest/2, which pins
-- every catalog_versions row (kind, ref, version, content hash) their catalog artifact was built from. Manifests
-- written before this migration stay deployment-manifest/1. Catalog rows themselves stay immutable; complete
-- definitions are published as new versions by the seed, never by rewriting old ones.

alter table deployments drop constraint deployments_manifest_check;
alter table deployments add constraint deployments_manifest_check check (
  manifest is null
  -- coalesce: a missing schemaVersion or catalogPins makes a comparison null, and a null check passes.
  or coalesce(manifest ->> 'schemaVersion' = 'deployment-manifest/1', false)
  or coalesce(manifest ->> 'schemaVersion' = 'deployment-manifest/2'
      and jsonb_typeof(manifest -> 'catalogPins') = 'array'
      and jsonb_array_length(manifest -> 'catalogPins') >= 1, false)
);
