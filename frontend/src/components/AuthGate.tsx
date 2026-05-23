import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  apiGet,
  apiPost,
  AUTH_LOST_EVENT,
  AuthStatus,
} from "../lib/api";
import { useBrand } from "../lib/brand";


/**
 * Sits in front of the rest of the app. Resolves to one of three
 * states, in priority order:
 *
 *   1. No password set yet (fresh install) → show the setup wizard.
 *   2. Password set but the current request has no valid session
 *      cookie → show the login form.
 *   3. Authenticated → render children, which are the
 *      ``OnboardingGate`` and the actual app.
 *
 * Any fetch elsewhere in the app that comes back 401 dispatches
 * ``AUTH_LOST_EVENT`` (see ``lib/api.ts``); we listen for that and
 * refetch the auth status so a mid-session expiry kicks the user back
 * to the login form cleanly.
 */
const AUTH_QUERY_KEY = ["auth-status"];


export default function AuthGate({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: AUTH_QUERY_KEY,
    queryFn: () => apiGet<AuthStatus>("/api/auth/status"),
  });

  useEffect(() => {
    const onAuthLost = () =>
      qc.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
    window.addEventListener(AUTH_LOST_EVENT, onAuthLost);
    return () => window.removeEventListener(AUTH_LOST_EVENT, onAuthLost);
  }, [qc]);

  if (!status.data) {
    // First-load: hold a quiet backdrop instead of flashing the app
    // content for half a second.
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm" />
    );
  }

  if (!status.data.password_set) {
    return <SetupWizard status={status.data} />;
  }
  if (!status.data.authenticated) {
    return <LoginForm />;
  }
  return <>{children}</>;
}


function GateShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  const brand = useBrand();
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-md bg-slate-900/95 border border-white/15 rounded-xl shadow-2xl p-6 space-y-5">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-sky-300 font-semibold">
            {title}
          </div>
          <h1 className="text-2xl font-semibold text-white mt-1">{brand}</h1>
          <p className="text-sm text-slate-400 mt-1">{subtitle}</p>
        </div>
        {children}
      </div>
    </div>
  );
}


function passwordStrength(pw: string): {
  label: string;
  className: string;
  ratio: number;
} {
  // Length-only heuristic. We deliberately don't bring in zxcvbn (~200kb)
  // for a side-project install screen; "longer is better" is the right
  // mental model anyway, and the backend's bcrypt cost handles guesses.
  const n = pw.length;
  if (n === 0) return { label: "", className: "bg-slate-700", ratio: 0 };
  if (n < 12) return { label: "too short", className: "bg-rose-500", ratio: Math.min(1, n / 12) };
  if (n < 16) return { label: "ok", className: "bg-amber-400", ratio: 0.55 };
  if (n < 24) return { label: "good", className: "bg-emerald-400", ratio: 0.8 };
  return { label: "strong", className: "bg-emerald-300", ratio: 1 };
}


function SetupWizard({ status }: { status: AuthStatus }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const setup = useMutation({
    mutationFn: () =>
      apiPost<AuthStatus>("/api/auth/setup", { password }),
    onSuccess: () => qc.invalidateQueries({ queryKey: AUTH_QUERY_KEY }),
  });

  const tooShort = password.length < status.min_password_length;
  const tooLong = password.length > status.max_password_length;
  const mismatched = confirm.length > 0 && confirm !== password;
  const armed = !tooShort && !tooLong && !mismatched && confirm.length > 0;
  const strength = passwordStrength(password);

  return (
    <GateShell
      title="First-run setup"
      subtitle="Set a single admin password to gate the dashboard. There's no recovery — write it down somewhere safe."
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (armed) setup.mutate();
        }}
      >
        <Field
          label="Admin password"
          value={password}
          onChange={setPassword}
          autoFocus
          minLength={status.min_password_length}
          maxLength={status.max_password_length}
        />
        {password.length > 0 && (
          <div>
            <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
              <div
                className={`h-full ${strength.className} transition-all`}
                style={{ width: `${Math.round(strength.ratio * 100)}%` }}
              />
            </div>
            <div className="text-[11px] text-slate-500 mt-1 flex justify-between">
              <span>{password.length} characters</span>
              <span className="text-slate-400">{strength.label}</span>
            </div>
          </div>
        )}
        <Field
          label="Confirm password"
          value={confirm}
          onChange={setConfirm}
          minLength={status.min_password_length}
          maxLength={status.max_password_length}
        />
        {mismatched && (
          <div className="text-[11px] text-rose-300">
            The two entries don't match.
          </div>
        )}
        <div className="text-[11px] text-slate-500 bg-slate-800/40 border border-white/5 rounded px-3 py-2 leading-relaxed">
          Minimum {status.min_password_length} characters. Passphrases (a few
          unrelated words) are encouraged over short complex passwords. The
          password is hashed with bcrypt before being stored — even a leaked
          database can't reveal it.
        </div>
        {setup.isError && (
          <div className="text-xs text-rose-300">
            {(setup.error as Error).message}
          </div>
        )}
        <button
          type="submit"
          disabled={!armed || setup.isPending}
          className="w-full text-sm px-3 py-2 rounded bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {setup.isPending ? "Setting password…" : "Set admin password"}
        </button>
      </form>
    </GateShell>
  );
}


function LoginForm() {
  const qc = useQueryClient();
  const [password, setPassword] = useState("");

  const login = useMutation({
    mutationFn: () =>
      apiPost<AuthStatus>("/api/auth/login", { password }),
    onSuccess: () => qc.invalidateQueries({ queryKey: AUTH_QUERY_KEY }),
  });

  return (
    <GateShell title="Sign in" subtitle="Enter the admin password to continue.">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (password.length > 0) login.mutate();
        }}
      >
        <Field
          label="Admin password"
          value={password}
          onChange={setPassword}
          autoFocus
        />
        {login.isError && (
          <div className="text-xs text-rose-300">
            {(login.error as Error).message}
          </div>
        )}
        <button
          type="submit"
          disabled={password.length === 0 || login.isPending}
          className="w-full text-sm px-3 py-2 rounded bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {login.isPending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </GateShell>
  );
}


function Field({
  label,
  value,
  onChange,
  autoFocus,
  minLength,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  autoFocus?: boolean;
  minLength?: number;
  maxLength?: number;
}) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold mb-1.5">
        {label}
      </div>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        minLength={minLength}
        maxLength={maxLength}
        autoComplete={label === "Admin password" ? "current-password" : "new-password"}
        className="w-full font-mono text-sm bg-slate-950 border border-white/15 rounded px-3 py-2 focus:outline-none focus:border-sky-500"
      />
    </label>
  );
}
