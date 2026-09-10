"use client";

import { type Me, currentSession, logout as doLogout } from "@/lib/session";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { SignIn } from "./sign-in";

export function SessionGate({
  kind,
  title,
  prompt,
  children,
}: {
  kind: "operator" | "tenant_user";
  title: string;
  prompt: string;
  children: (me: Me, signOut: () => void) => ReactNode;
}) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    currentSession().then((session) => {
      if (!live) return;
      setMe(session && session.kind === kind ? session : null);
      setReady(true);
    });
    return () => {
      live = false;
    };
  }, [kind]);

  const signOut = useCallback(() => {
    void doLogout().finally(() => setMe(null));
  }, []);

  if (!ready) return null;
  if (!me) {
    return <SignIn kind={kind} title={title} prompt={prompt} onSignedIn={setMe} />;
  }

  if (me.mustChangePassword) {
    return <ChangePassword onDone={() => currentSession().then(setMe)} />;
  }

  return <>{children(me, signOut)}</>;
}

function ChangePassword({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="login">
      <div className="mark">C</div>
      <h1>Choose a password</h1>
      <p>
        Your account was created with a temporary password. Set your own before continuing — at
        least 12 characters.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const { apiFetch, setCsrfToken } = await import("@/lib/session");
            const res = await apiFetch<{ csrfToken: string }>("/auth/password", {
              method: "POST",
              body: { currentPassword: current, newPassword: next },
            });

            setCsrfToken(res.csrfToken);
            onDone();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not change password");
          } finally {
            setBusy(false);
          }
        }}
      >
        <input
          type="password"
          autoComplete="current-password"
          placeholder="Temporary password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <input
          type="password"
          autoComplete="new-password"
          placeholder="New password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <button className="primary" type="submit" disabled={busy || next.length < 12}>
          {busy ? "Saving…" : "Set password"}
        </button>
      </form>
      {error ? <div className="err">{error}</div> : null}
    </div>
  );
}
