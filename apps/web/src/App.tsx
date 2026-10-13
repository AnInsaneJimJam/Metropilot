import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { api, ApiError, HOSTED_PRIVY_APP_ID } from "./api.ts";
import { EditorPage } from "./EditorPage.tsx";

// The Privy SDK is only loaded on a hosted build (VITE_PRIVY_APP_ID set); local development uses its workspace session.
const PrivyLogin = lazy(() => import("./PrivyLogin.tsx"));

export function App() {
  const [signedIn, setSignedIn] = useState<boolean | undefined>(HOSTED_PRIVY_APP_ID ? undefined : true);
  const [signedOut, setSignedOut] = useState(false);
  const check = useCallback(async () => {
    try {
      await api("/agents?limit=1");
      setSignedIn(true);
    } catch (e) {
      // Only an explicit 401 means "sign in"; an unreachable API still opens the editor with its reconnect banner.
      setSignedIn(!(e instanceof ApiError && e.status === 401));
    }
  }, []);
  useEffect(() => {
    if (HOSTED_PRIVY_APP_ID) void check();
  }, [check]);
  if (signedIn === undefined) return <main className="signin-page"><p className="note">Loading…</p></main>;
  if (!signedIn && HOSTED_PRIVY_APP_ID)
    return (
      <Suspense fallback={<main className="signin-page"><p className="note">Loading sign-in…</p></main>}>
        <PrivyLogin appId={HOSTED_PRIVY_APP_ID} signedOut={signedOut} onSignedIn={() => { setSignedOut(false); setSignedIn(true); }} />
      </Suspense>
    );
  const signOut = async () => {
    await fetch("/v1/auth/session", { method: "DELETE" }).catch(() => undefined);
    setSignedOut(true);
    setSignedIn(false);
  };
  return <EditorPage {...(HOSTED_PRIVY_APP_ID ? { onSignOut: () => void signOut() } : {})} />;
}
