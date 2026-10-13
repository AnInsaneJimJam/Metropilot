-- Paper sandbox quotas and global admission (issue #17, INF-4, decision D58). Usage is measured from intervals in
-- which a paper deployment was active: one row opens on launch or resume and closes on pause or stop, so session
-- and UTC-day minutes are sums over intervals, and a paused agent uses no quota. Limits are platform configuration
-- (product.md sandbox contract, runtime.md admission target), one row, changed by an operator with an update.

create table paper_active_intervals (
  tenant_id uuid not null,
  deployment_id uuid not null,
  generation integer not null check (generation >= 1),
  started_at timestamptz not null,
  ended_at timestamptz,
  primary key (deployment_id, generation),
  foreign key (tenant_id, deployment_id) references deployments (tenant_id, id),
  check (ended_at is null or ended_at >= started_at)
);
-- At most one open interval per deployment.
create unique index paper_active_intervals_open on paper_active_intervals (deployment_id) where ended_at is null;
create index paper_active_intervals_tenant on paper_active_intervals (tenant_id, started_at);

create table platform_limits (
  singleton boolean primary key default true check (singleton),
  paper_concurrent_per_user integer not null check (paper_concurrent_per_user >= 0),
  paper_session_minutes integer not null check (paper_session_minutes >= 0),
  paper_daily_minutes integer not null check (paper_daily_minutes >= 0),
  -- Concurrently active paper deployments across all users; launches and resumes beyond it are refused.
  paper_active_global integer not null check (paper_active_global >= 0),
  updated_at timestamptz not null default now()
);
insert into platform_limits (paper_concurrent_per_user, paper_session_minutes, paper_daily_minutes, paper_active_global) values (1, 60, 120, 10);

-- Deployments already active when this migration runs start counting now.
insert into paper_active_intervals (tenant_id, deployment_id, generation, started_at)
select tenant_id, id, generation, now() from deployments where mode = 'paper' and desired_state = 'active';
