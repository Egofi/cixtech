"use client";

import { type LoginSuccess, type Me, isChallenge, login, submitMfa } from "@/lib/session";
import { type FormEvent, useState } from "react";

type Stage =
  | { step: "credentials" }
  | { step: "mfa"; challenge: string }
  | { step: "enrol"; challenge: string; secret: string; uri: string }
  | { step: "recovery"; codes: string[]; principal: Me };

/**
 * Sign-in for both consoles.
 *
 * Three stages, because a password alone is not a session for a role that can
 * move value: credentials → second factor → (first time) recovery codes. The
 * enrolment stage is not skippable — the API returns the challenge rather than a
 * cookie, so there is nothing to skip to.
 */
export function SignIn({
  kind,
  title,
  prompt,
  onSignedIn,
}: {
  kind: "operator" | "tenant_user";
  title: string;
  prompt: string;
  onSignedIn: (me: Me) => void;
}) {
  const [stage, setStage] = useState<Stage>({ step: "credentials" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = (err: unknown) =>
    setError(err instanceof Error ? err.message : "Something went wrong");

  function finish(res: LoginSuccess) {
    if (res.recoveryCodes?.length) {
      setStage({ step: "recovery", codes: res.recoveryCodes, principal: res.principal });
    } else {
      onSignedIn(res.principal);
    }
  }

  async function submitCredentials(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await login(email.trim(), password, kind);
      if (!isChallenge(res)) return finish(res);
      if (res.status === "mfa_enrolment_required" && res.totp) {
        setStage({
          step: "enrol",
          challenge: res.challenge,
          secret: res.totp.secret,
          uri: res.totp.uri,
        });
      } else {
        setStage({ step: "mfa", challenge: res.challenge });
      }
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    if (stage.step !== "mfa" && stage.step !== "enrol") return;
    setBusy(true);
    setError(null);
    try {
      finish(await submitMfa(stage.challenge, code.trim(), stage.step === "enrol"));
    } catch (err) {
      fail(err);
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  if (stage.step === "recovery") {
    return (
      <div className="login">
        <div className="mark">C</div>
        <h1>Save your recovery codes</h1>
        <p>
          These are shown <strong>once</strong>. Each works a single time and is the only way back
          in if you lose your authenticator.
        </p>
        <div className="tablewrap" style={{ margin: "12px 0" }}>
          <table>
            <tbody>
              {stage.codes.map((c) => (
                <tr key={c}>
                  <td className="mono">{c}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          className="primary"
          onClick={() => {
            void navigator.clipboard?.writeText(stage.codes.join("\n"));
          }}
        >
          Copy to clipboard
        </button>{" "}
        <button type="button" onClick={() => onSignedIn(stage.principal)}>
          I have saved them — continue
        </button>
      </div>
    );
  }

  if (stage.step === "enrol") {
    return (
      <div className="login">
        <div className="mark">C</div>
        <h1>Set up your authenticator</h1>
        <p>
          Your role can move value, so it needs a second factor. Add this secret to an authenticator
          app, then enter the code it shows.
        </p>
        <p className="mono" style={{ wordBreak: "break-all", fontSize: 13 }}>
          {stage.secret}
        </p>
        <form onSubmit={submitCode}>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "Checking…" : "Confirm"}
          </button>
        </form>
        {error ? <div className="err">{error}</div> : null}
      </div>
    );
  }

  if (stage.step === "mfa") {
    return (
      <div className="login">
        <div className="mark">C</div>
        <h1>Two-factor code</h1>
        <p>Enter the code from your authenticator, or one of your recovery codes.</p>
        <form onSubmit={submitCode}>
          <input
            autoComplete="one-time-code"
            placeholder="6-digit code or recovery code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "Checking…" : "Continue"}
          </button>
        </form>
        {error ? <div className="err">{error}</div> : null}
        <button type="button" onClick={() => setStage({ step: "credentials" })}>
          Start again
        </button>
      </div>
    );
  }

  return (
    <div className="login">
      <div className="mark">C</div>
      <h1>{title}</h1>
      <p>{prompt}</p>
      <form onSubmit={submitCredentials}>
        <input
          type="email"
          autoComplete="username"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          type="password"
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      {error ? <div className="err">{error}</div> : null}
    </div>
  );
}
