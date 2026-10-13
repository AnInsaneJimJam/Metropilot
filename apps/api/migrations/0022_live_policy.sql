-- Live trading caps need fresh consent: a step-up approval bound to the exact limits (docs/integration/funds.md,
-- D60). The approval is consumed when the live policy version is created.
alter table step_up_challenges drop constraint step_up_challenges_purpose_check;
alter table step_up_challenges add constraint step_up_challenges_purpose_check check (purpose in ('withdrawal', 'destination', 'allocation', 'livePolicy'));
