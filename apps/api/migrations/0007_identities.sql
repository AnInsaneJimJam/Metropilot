-- Verified identities and application sessions (API-1, issue #16, decision D43). A provider identity
-- (provider, subject) maps to exactly one tenant; the first verified login creates both in one transaction.
-- Sessions store only the SHA-256 of the cookie token, so a database read never yields a usable cookie.

create table identities (
  provider text not null check (provider ~ '^[a-z][a-z0-9-]{1,31}$'),
  subject text not null check (length(subject) between 1 and 255),
  tenant_id uuid not null references tenants (id),
  created_at timestamptz not null default now(),
  primary key (provider, subject),
  -- Lets sessions reference the identity together with its tenant, so the two cannot disagree.
  unique (provider, subject, tenant_id)
);
create index identities_tenant on identities (tenant_id);

create table sessions (
  token_hash bytea primary key check (length(token_hash) = 32),
  tenant_id uuid not null references tenants (id),
  provider text not null,
  subject text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (expires_at > created_at),
  check (revoked_at is null or revoked_at >= created_at),
  foreign key (provider, subject, tenant_id) references identities (provider, subject, tenant_id)
);
create index sessions_tenant on sessions (tenant_id);
