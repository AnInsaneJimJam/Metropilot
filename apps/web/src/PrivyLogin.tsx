import { useEffect, useRef, useState } from "react";
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import { api } from "./api.ts";

/**
 * Hosted sign-in (D56): Privy authenticates the person, then its access token is exchanged once for the API's own
 * session cookie (POST /v1/auth/session). The API verifies the token; the browser never holds a long-lived credential.
 * Loaded only when VITE_PRIVY_APP_ID is set, so local development keeps its built-in workspace session.
 */
function Exchange({ onSignedIn, signedOut }: { onSignedIn: () => void; signedOut: boolean }) {
  const { ready, authenticated, login, getAccessToken, logout } = usePrivy();
  const [error, setError] = useState("");
  const sent = useRef(false);
  // After an explicit sign-out the Privy session ends too, so the page does not sign straight back in.
  const [waiting, setWaiting] = useState(signedOut);
  useEffect(() => {
    if (!ready || !waiting) return;
    void (authenticated ? logout() : Promise.resolve()).catch(() => undefined).finally(() => setWaiting(false));
  }, [ready, waiting, authenticated, logout]);
  useEffect(() => {
    if (!ready || waiting || !authenticated || sent.current) return;
    sent.current = true;
    void (async () => {
      try {
        const token = await getAccessToken();
        if (!token) throw new Error("Sign-in did not return an access token; try again.");
        await api("/auth/session", { method: "POST", body: JSON.stringify({ token }) });
        onSignedIn();
      } catch (e) {
        sent.current = false;
        setError((e as Error).message);
        await logout().catch(() => undefined);
      }
    })();
  }, [ready, waiting, authenticated, getAccessToken, logout, onSignedIn]);
  return (
    <main className="signin-page" aria-labelledby="signin-title">
      <div className="signin-card">
        <span className="eyebrow">MONAD AGENT STUDIO</span>
        <h1 id="signin-title">Sign in to build and run agents</h1>
        <p className="note">Your strategies, paper sessions and agent wallets belong to your account. Sign in with email or a wallet.</p>
        <button className="primary" disabled={!ready || waiting || authenticated} onClick={() => login()}>
          {!ready ? "Loading…" : authenticated ? "Signing in…" : "Sign in"}
        </button>
        {error && (
          <p className="budget-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}

export default function PrivyLogin({ appId, onSignedIn, signedOut = false }: { appId: string; onSignedIn: () => void; signedOut?: boolean }) {
  return (
    <PrivyProvider appId={appId} config={{ loginMethods: ["email", "wallet"], embeddedWallets: { ethereum: { createOnLogin: "off" } } }}>
      <Exchange onSignedIn={onSignedIn} signedOut={signedOut} />
    </PrivyProvider>
  );
}
