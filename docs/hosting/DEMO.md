# Demo script (about 5 minutes)

Runs against the hosted platform: studio `https://metropilot.vercel.app`, API `https://monad.yash-agrawal.dev` (laptop +
Cloudflare Tunnel, [TUNNEL.md](TUNNEL.md)). The live agent below was set up before the demo, because a fresh deposit,
allocation and first trade take a few minutes; the demo shows it rather than repeating it.

## Before going on stage

- Laptop awake, on power, online: `curl https://monad.yash-agrawal.dev/healthz` returns `{"status":"ok"}`.
- `infra/tunnel/stack.sh ps`: every service running.
- Signed in to the studio in the browser you present from (MetaMask through Privy).
- A second terminal ready for one-time codes: `infra/tunnel/stack.sh logs -f api | grep stepUp.code`.
- Paper time left today (Operate shows "Paper time today").

## 1. Sign in and the idea (30 s)

Open the studio. "Describe a trading agent, test it against real market prices with virtual money, then let it trade
real funds inside hard limits it cannot exceed."

## 2. Build a strategy (60 s)

- **New strategy → WMON scheduled purchase** template.
- Show the blocks: trigger (every N seconds), action (swap USDC → WMON on Uniswap v3, max slippage 50 bps).
- Switch to **Rules** to show the same strategy as readable rules; open **Compiler details** to show it compiles to a
  checked, versioned strategy.
- **Save** (revision 1).

## 3. Paper run (60 s)

- **Operate → Launch on paper.** Prices come from the mainnet Uniswap v3 pool (TWAP); fills are simulated with virtual USDC.
- Within a minute a run appears: intent → settled, with the simulated fill (USDC spent, WMON received) and updated paper balances.

## 4. Real trade (60 s)

Open the live agent **MON to USDC live test**:
- **Live funds:** the agent's own custodial wallet (Privy; the policy only allows the Uniswap router and the WMON/USDC
  contracts), its deposit and the trading allocation.
- **Caps** approved with a one-time code: 50 bps slippage, 2 trades and USD 1 per day.
- **Runs:** the settled swap, 0.1 MON → USDC, with its monadvision.com link. Open the link: the transaction is on Monad mainnet.

## 5. Safety (45 s)

- The next scheduled run is **blocked**: the daily trade cap is reached, so the policy refuses before anything is signed.
- Every signature goes through the policy at signing time; a step-up code is bound to the exact terms it approves.
- The ledger matches the chain: the wallet's on-chain MON and USDC equal the agent's ledger balances (reconciliation).

## 6. Close (15 s)

Pause the agent. Remaining funds can be withdrawn to a verified address (one-time code).

## Known limits to say if asked

- Live agents run schedule triggers and swaps only (D61): no price triggers, market reads or AI steps live yet.
- One-time codes reach operators through the API log; no email or MFA delivery yet.
- Funding is MON only; trading covers MON, WMON and USDC on Uniswap v3.
- Hosted on one laptop: uptime is the laptop's.
