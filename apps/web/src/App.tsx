import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { api, ApiError, HOSTED_PRIVY_APP_ID } from "./api.ts";
import { setEditorModels } from "./catalog.ts";
import { EditorPage } from "./EditorPage.tsx";

// The Privy SDK is only loaded on a hosted build (VITE_PRIVY_APP_ID set); local development uses its workspace session.
const PrivyLogin = lazy(() => import("./PrivyLogin.tsx"));

/** Server-enabled model profiles must reach Blockly before the editor mounts; needs a session on hosted builds. */
async function loadModels(): Promise<void> {
  try {
    const response = await api<{ catalog?: { modelProfiles?: unknown } }>("/catalog", { signal: AbortSignal.timeout(3000) });
    setEditorModels(response.catalog?.modelProfiles);
  } catch {
    // The editor shows the connection state; bundled profiles stay usable.
  }
}

export function App() {
  const [signedIn, setSignedIn] = useState<boolean | undefined>(HOSTED_PRIVY_APP_ID ? undefined : true);
  const [signedOut, setSignedOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const check = useCallback(async () => {
    try {
      await api("/agents?limit=1");
      await loadModels();
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
        <PrivyLogin appId={HOSTED_PRIVY_APP_ID} signedOut={signedOut} onSignedIn={() => void loadModels().then(() => { setSignedOut(false); setSignedIn(true); })} />
      </Suspense>
    );
  // Sign-out is complete only when the API confirms it revoked the session; otherwise say so and stay signed in.
  const signOut = async () => {
    setSignOutError("");
    const res = await fetch("/v1/auth/session", { method: "DELETE" }).catch(() => undefined);
    if (!res || (res.status !== 204 && res.status !== 401)) {
      setSignOutError("Sign-out did not reach the server; your session is still active. Try again.");
      return;
    }
    setSignedOut(true);
    setSignedIn(false);
  };
  return (
    <>
      {signOutError && <p className="budget-error signout-error" role="alert">{signOutError}</p>}
      <EditorPage
        {...(HOSTED_PRIVY_APP_ID ? { onSignOut: () => void signOut(), onSessionExpired: () => setSignedIn(false) } : {})}
      />
    </>
  );
}
