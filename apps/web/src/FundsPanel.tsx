import { useCallback, useEffect, useState } from "react";
import type { GeneratedContractMap } from "@monad-hack/contracts";
import { api } from "./api.ts";

type Funds = GeneratedContractMap["agentFunds"];
type Withdrawal = GeneratedContractMap["withdrawal"];
type Wallet = { address: string; chainId: number; networkRef: string; provider: string; acceptedAssets: { assetRef: string; token: string; decimals: number }[] };
type Bucket = "hosting" | "api" | "trading";
const BUCKET_LABEL: Record<string, string> = { unallocated: "Unallocated", hosting: "Hosting", api: "AI and data", trading: "Trading" };

/** Exact decimal text ↔ atomic integer string; no floating point anywhere near money. */
function toAtomic(text: string, decimals: number): string {
  const m = /^(\d{1,30})(?:\.(\d*))?$/.exec(text.trim());
  if (!m) throw new Error("Enter an amount like 12.5.");
  const frac = (m[2] ?? "").padEnd(decimals, "0");
  if (frac.length > decimals) throw new Error(`At most ${decimals} decimals.`);
  return (BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac || "0")).toString();
}
function fromAtomic(atomic: string, decimals: number): string {
  const v = BigInt(atomic);
  const unit = 10n ** BigInt(decimals);
  const frac = (v % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${v / unit}${frac ? `.${frac}` : ""}`;
}
const key = () => crypto.randomUUID();

/** Live funds (G5): custodial wallet, finalized balances per budget bucket, allocation and withdrawals. */
export function FundsPanel({ agentId, localFaucet }: { agentId: string; localFaucet: boolean }) {
  const [wallet, setWallet] = useState<Wallet>();
  const [funds, setFunds] = useState<Funds>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [targets, setTargets] = useState<Record<Bucket, string>>({ hosting: "", api: "", trading: "" });
  const [assetRef, setAssetRef] = useState("");
  const [challenge, setChallenge] = useState<{ id: string; resolve: (id: string) => void; reject: (e: Error) => void }>();
  const [code, setCode] = useState("");
  const [destination, setDestination] = useState({ id: "", address: "", label: "My wallet" });
  const [amount, setAmount] = useState("");
  const [withdrawal, setWithdrawal] = useState<Withdrawal>();

  const decimalsOf = (ref: string) => wallet?.acceptedAssets.find((a) => a.assetRef === ref)?.decimals ?? 18;
  const refresh = useCallback(async () => {
    setFunds(await api<Funds>(`/agents/${agentId}/balances`));
  }, [agentId]);
  useEffect(() => {
    void refresh().catch((e: Error) => setError(e.message));
    const timer = setInterval(() => void refresh().catch(() => undefined), 4000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!withdrawal || ["finalized", "failed", "cancelled"].includes(withdrawal.state)) return;
    const timer = setInterval(() => void api<Withdrawal>(`/withdrawals/${withdrawal.id}`).then(setWithdrawal).catch(() => undefined), 3000);
    return () => clearInterval(timer);
  }, [withdrawal]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  /** Start a step-up for exact terms and wait for the user to enter the one-time code. */
  const stepUp = async (terms: Record<string, unknown>): Promise<string> => {
    const started = await api<{ challengeId: string }>("/step-up/challenges", { method: "POST", body: JSON.stringify({ agentId, ...terms }) });
    return new Promise((resolve, reject) => setChallenge({ id: started.challengeId, resolve, reject }));
  };
  const submitCode = () =>
    void (async () => {
      if (!challenge) return;
      try {
        await api(`/step-up/challenges/${challenge.id}/verify`, { method: "POST", body: JSON.stringify({ code }) });
        challenge.resolve(challenge.id);
        setChallenge(undefined);
        setCode("");
      } catch (e) {
        setError((e as Error).message);
      }
    })();

  const openWallet = () => run(async () => {
    const w = await api<Wallet>(`/agents/${agentId}/wallet`, { method: "POST", body: "{}" });
    setWallet(w);
    setAssetRef((current) => current || w.acceptedAssets[0]?.assetRef || "");
  });
  const faucet = (ref: string, display: string) => run(async () => {
    await api(`/agents/${agentId}/local-faucet`, { method: "POST", body: JSON.stringify({ assetRef: ref, amount: toAtomic(display, decimalsOf(ref)) }) });
  });
  const allocateNow = () => run(async () => {
    if (!funds) return;
    const list = (Object.entries(targets) as [Bucket, string][]).filter(([, v]) => v.trim()).map(([bucket, v]) => ({ bucket, amount: toAtomic(v, decimalsOf(assetRef)) }));
    if (!list.length) throw new Error("Enter at least one bucket amount.");
    const terms = { assetRef, expectedBudgetVersion: funds.budgetVersion, targets: list };
    const trading = funds.buckets.find((b) => b.bucket === "trading" && b.assetRef === assetRef)?.balance ?? "0";
    const raises = list.some((t) => t.bucket === "trading" && BigInt(t.amount) > BigInt(trading));
    const stepUpId = raises ? await stepUp({ purpose: "allocation", ...terms }) : undefined;
    await api(`/agents/${agentId}/allocations`, { method: "POST", headers: { "Idempotency-Key": key() }, body: JSON.stringify({ ...terms, ...(stepUpId ? { stepUpId } : {}) }) });
  });
  const verifyDestination = () => run(async () => {
    if (!wallet) throw new Error("Open the wallet first.");
    const terms = { chainId: wallet.chainId, address: destination.address.trim().toLowerCase(), label: destination.label };
    const stepUpId = await stepUp({ purpose: "destination", ...terms });
    const saved = await api<{ id: string }>(`/agents/${agentId}/withdrawal-destinations`, { method: "POST", headers: { "Idempotency-Key": key() }, body: JSON.stringify({ ...terms, stepUpId }) });
    setDestination((d) => ({ ...d, id: saved.id }));
  });
  const withdraw = () => run(async () => {
    const terms = { assetRef, amount: toAtomic(amount, decimalsOf(assetRef)), destinationId: destination.id };
    const stepUpId = await stepUp({ purpose: "withdrawal", ...terms });
    setWithdrawal(await api<Withdrawal>(`/agents/${agentId}/withdrawals`, { method: "POST", headers: { "Idempotency-Key": key() }, body: JSON.stringify({ ...terms, stepUpId }) }));
  });

  return (
    <div className="budget-section funds-panel">
      <div className="section-line">
        <h3>Live funds</h3>
        {funds?.frozen && <span className="pill status-error">Outflows frozen · {funds.freezeReasons.join(", ")}</span>}
      </div>
      {error && <p className="budget-error" role="alert">{error}</p>}
      {!wallet && !funds?.wallet ? (
        <button disabled={busy} onClick={() => void openWallet()}>Open custodial wallet</button>
      ) : (
        <>
          <p className="note">
            Wallet <code>{wallet?.address ?? funds?.wallet?.address}</code> on chain {wallet?.chainId ?? funds?.wallet?.chainId}
            {(wallet?.provider ?? funds?.wallet?.provider) === "local" ? " · local test chain, not a real network" : ""}. Deposits count only after finality.
          </p>
          {!wallet && <button className="link" onClick={() => void openWallet()}>Show deposit details</button>}
          {wallet && localFaucet && (
            <div className="operate-actions">
              {wallet.acceptedAssets.map((a) => (
                <button key={a.assetRef} disabled={busy} onClick={() => void faucet(a.assetRef, a.token === "native" ? "0.1" : "100")}>
                  Add local {a.assetRef}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {funds && funds.buckets.length > 0 && (
        <table className="funds-table">
          <thead><tr><th>Bucket</th><th>Asset</th><th>Balance</th><th>Held</th><th>Available</th></tr></thead>
          <tbody>
            {funds.buckets.map((b) => (
              <tr key={`${b.bucket}:${b.assetRef}`}>
                <td>{BUCKET_LABEL[b.bucket]}</td><td>{b.assetRef}</td>
                <td>{fromAtomic(b.balance, decimalsOf(b.assetRef))}</td><td>{fromAtomic(b.held, decimalsOf(b.assetRef))}</td><td>{fromAtomic(b.available, decimalsOf(b.assetRef))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {funds && funds.pendingDeposits.length > 0 && (
        <p className="note">{funds.pendingDeposits.length} deposit{funds.pendingDeposits.length === 1 ? "" : "s"} pending finality or quarantined (unsupported token).</p>
      )}
      {wallet && (
        <>
          <h4>Allocate (budget version {funds?.budgetVersion})</h4>
          <div className="funds-form">
            <select value={assetRef} onChange={(e) => setAssetRef(e.target.value)} aria-label="Asset">
              {wallet.acceptedAssets.map((a) => <option key={a.assetRef}>{a.assetRef}</option>)}
            </select>
            {(["hosting", "api", "trading"] as const).map((b) => (
              <label key={b}>{BUCKET_LABEL[b]}<input inputMode="decimal" value={targets[b]} placeholder="unchanged" onChange={(e) => setTargets({ ...targets, [b]: e.target.value })} /></label>
            ))}
            <button disabled={busy} onClick={() => void allocateNow()}>Allocate</button>
          </div>
          <p className="note">Totals per bucket; the rest stays unallocated. Raising trading funds asks for a one-time code.</p>
          <h4>Withdraw</h4>
          <div className="funds-form">
            <label>Destination<input value={destination.address} placeholder="0x…" onChange={(e) => setDestination({ ...destination, address: e.target.value, id: "" })} /></label>
            <button disabled={busy || !destination.address} onClick={() => void verifyDestination()}>{destination.id ? "Verified" : "Verify address"}</button>
            <label>Amount<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
            <button disabled={busy || !destination.id || !amount} onClick={() => void withdraw()}>Withdraw</button>
          </div>
          {withdrawal && <p className="note">Withdrawal {withdrawal.state}{withdrawal.transactionHash ? ` · ${withdrawal.transactionHash.slice(0, 12)}…` : ""}{withdrawal.failureReason ? ` · ${withdrawal.failureReason}` : ""}</p>}
        </>
      )}
      {challenge && (
        <div className="funds-form" role="dialog" aria-label="Step-up approval">
          <label>One-time code<input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} autoFocus /></label>
          <button className="primary" onClick={submitCode}>Approve</button>
          <button onClick={() => { challenge.reject(new Error("Approval cancelled.")); setChallenge(undefined); }}>Cancel</button>
          <p className="note">The code was sent out of band (locally: the API server log).</p>
        </div>
      )}
    </div>
  );
}
