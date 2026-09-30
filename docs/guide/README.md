# User documentation source

This is the planned public documentation content for the future docs website. The product is not implemented yet; steps below describe the intended workflow, not buttons currently available in a running application.

## What the platform does

Configure an agent with a strategy and a set of supported protocol capabilities. The platform runs it, supplies model access, enforces the permissions you approved, and shows its activity. You do not need to create a VPS or put API keys into a strategy.

Rookie mode starts with templates. Advanced mode lets you assemble the supported blocks yourself and change model/prompt settings. Both use the same execution rules. A connector-only package will later support people running their own infrastructure.

## Start in the free sandbox

Paper trading uses virtual funds and simulated fills. Those balances cannot be withdrawn. The sandbox has a published time/model allowance; when it ends, the agent pauses. Hosting isolation protects workloads from each other in both paper and live modes. A pre-trade simulation is a separate preview and cannot guarantee what a later real transaction will do.

Try the [threshold strategy tutorial](strategy-tutorial.md) to understand how events, conditions, and actions fit together before using real funds.

## Understand the wallet and budgets

Live mode uses a custodial wallet: the platform has authority to submit the transactions you permit. Allocate funds to hosting, AI/API usage, and trading. Native MON gas is shown within trading costs. You approve budget changes; an agent cannot move your trading balance into its API budget by itself.

An estimated runtime describes operating funds under stated usage assumptions. It does not predict profits or trading losses. Funding is credited after chain finality; pending deposits and pending trades remain visible separately. Only available funds can be withdrawn, so an unresolved trade may keep part of the balance reserved.

## Understand connectors and AI

A connector enables a listed set of reads/events/actions for a particular network. It does not support every operation the named protocol offers. Unsupported actions and unverified networks remain disabled.

An AI block receives the selected inputs and returns a structured result used by the next blocks. It cannot raise spending limits or choose an unapproved recipient. Unsupported provider settings, missing data, invalid output and budget exhaustion stop the relevant run and produce an explanation.

## Monitor and stop

The planned agent page shows current state, recent events, decision summaries, spending, pending transactions and pause controls. Pause blocks new actions; it cannot undo a transaction already signed or broadcast. Stopping the hosted runtime leaves transaction reconciliation and withdrawal access active where safe.

## Public-site content checklist

- [ ] Replace planned-flow wording with verified steps and screenshots when G7 exists.
- [ ] Publish current sandbox limits and model/cost assumptions from the live catalog.
- [ ] Add connector capability pages only after conformance checks pass.
- [ ] Add custody, funding, withdrawal, pause and recovery explanations before live access.
- [ ] Add self-hosted connector instructions after G11, without platform credentials.

The website build must exclude `AGENTS.md`, internal specifications, operational runbooks and research notes unless intentionally published through a separate review.
