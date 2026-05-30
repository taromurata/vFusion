import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { apiGet, apiPost, PublicConfig } from "../lib/api";
import { copyToClipboard } from "../lib/clipboard";
import Redacted from "./Redacted";

// react-query key for the onboarding poll. Exported so the Skip button
// and the Settings "Relaunch onboarding" control can invalidate it and
// force the gate to re-evaluate immediately.
export const ONBOARDING_QUERY_KEY = ["public-config-onboarding"];

/**
 * Gates the entire app behind a first-run onboarding modal until a real
 * Verkada webhook has been received. The signal is `needs_onboarding`
 * from `/api/config` — true until a Verkada Connection row exists
 * (auto-created on the first webhook with a valid UUID org_id).
 *
 * Mode-specific guidance:
 *   - **quick**: show the trycloudflare URL + steps to paste into
 *     Verkada Command.
 *   - **named**: show the operator's stable URL + steps to paste into
 *     Verkada Command.
 *   - **lan**: tell the user webhooks from the cloud can't reach them
 *     and link to restart with --profile quick / cloudflared.
 *
 * "Stack received first request" indicator: turns on when ANY webhook
 * lands (real or synthetic), so the README smoke-test curl gives the
 * user immediate feedback even though it doesn't dismiss the gate.
 */
export default function OnboardingGate({ children }: { children: React.ReactNode }) {
  const cfg = useQuery({
    queryKey: ONBOARDING_QUERY_KEY,
    queryFn: () => apiGet<PublicConfig>("/api/config"),
    // Poll fast while gated. After we dismiss, the WebhookEndpointBanner
    // takes over with a slower cadence on the inbox page.
    refetchInterval: (q) => (q.state.data?.needs_onboarding ? 2000 : 30_000),
  });

  // First-load: hold an empty backdrop instead of flashing the dashboard
  // for half a second and then yanking it behind the modal. The Vanta
  // background continues animating beneath this so it doesn't read as
  // a hard stall.
  if (!cfg.data) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm" />
    );
  }

  if (!cfg.data.needs_onboarding) return <>{children}</>;

  return <OnboardingModal cfg={cfg.data} />;
}


/**
 * localStorage key for the signing secret the user generated during
 * onboarding. ConnectionFormModal reads this on mount when the
 * "finish setup" banner pops the form open, so the secret they pasted
 * into Verkada Command is already in the form without re-typing.
 *
 * Cleared by ConnectionFormModal after a successful save.
 */
export const PENDING_SIGNING_SECRET_KEY = "vfusion.pending_signing_secret";


function generateSigningSecret(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  let b64 = btoa(String.fromCharCode(...bytes));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}


function OnboardingModal({ cfg }: { cfg: PublicConfig }) {
  const mode = cfg.tunnel_mode;
  const url = cfg.public_webhook_base ? `${cfg.public_webhook_base}/hooks/verkada` : null;
  const [copied, setCopied] = useState(false);

  // When the gate finally dismisses (a real webhook lands), briefly show
  // a celebratory state so the modal doesn't just vanish — feels more
  // alive than an abrupt swap.
  // (Implemented via a key-change in the parent — here we just render
  // the gated state.)

  const copy = async () => {
    if (!url) return;
    await copyToClipboard(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-2xl bg-slate-900/95 border border-white/15 rounded-xl shadow-2xl p-6 space-y-5">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-sky-300 font-semibold">
            First-run setup
          </div>
          <h1 className="text-2xl font-semibold text-white mt-1">
            Welcome to {cfg.brand_name}
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            We'll unlock the dashboard once your first real Verkada webhook arrives.
          </p>
        </div>

        {mode === "lan" ? (
          <LanModeBody anyWebhookReceived={cfg.any_webhook_received} />
        ) : (
          <TunnelModeBody
            url={url}
            ephemeral={cfg.ephemeral}
            onCopy={copy}
            copied={copied}
          />
        )}

        <WaitingFooter anyWebhookReceived={cfg.any_webhook_received} mode={mode} />
        <SkipControl />
      </div>
    </div>
  );
}


/**
 * "Skip for now" escape hatch on the onboarding modal. Persists the skip
 * server-side (POST /api/config/skip-onboarding → app_settings), then
 * invalidates the onboarding poll so the gate re-evaluates and unmounts
 * the modal. Two-step (link → confirm) so it isn't a single stray click,
 * since skipping opens the dashboard before any webhook is verified.
 */
function SkipControl() {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const skip = async () => {
    setSkipping(true);
    setError(null);
    try {
      await apiPost("/api/config/skip-onboarding", {});
      // needs_onboarding flips to false on the refetch — the gate then
      // renders the dashboard and this modal unmounts.
      await queryClient.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to skip setup");
      setSkipping(false);
    }
  };

  if (!confirming) {
    return (
      <div className="text-center">
        <button
          onClick={() => setConfirming(true)}
          className="text-xs text-slate-500 hover:text-slate-300 underline underline-offset-2"
        >
          Skip for now — explore the dashboard without a webhook
        </button>
      </div>
    );
  }

  return (
    <div className="rounded border border-amber-900/50 bg-amber-950/30 px-3 py-2.5 space-y-2">
      <div className="text-[11px] text-amber-200/90">
        Skipping opens the dashboard before any Verkada webhook has been verified.
        Flows have no real events to trigger on until you wire one up — set that up
        on the Connections page. This gate won't show again.
      </div>
      {error && <div className="text-[11px] text-red-300">{error}</div>}
      <div className="flex items-center gap-2">
        <button
          onClick={skip}
          disabled={skipping}
          className="text-xs px-3 py-1.5 rounded bg-amber-700 hover:bg-amber-600 text-white disabled:opacity-50"
        >
          {skipping ? "Skipping…" : "Skip anyway"}
        </button>
        <button
          onClick={() => setConfirming(false)}
          disabled={skipping}
          className="text-xs px-3 py-1.5 rounded border border-white/15 bg-white/5 hover:bg-white/10 text-slate-200"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}


function TunnelModeBody({
  url,
  ephemeral,
  onCopy,
  copied,
}: {
  url: string | null;
  ephemeral: boolean;
  onCopy: () => void;
  copied: boolean;
}) {
  // Persisted across renders so leaving the modal open and rotating
  // generations doesn't dump multiple values to localStorage. The
  // form on the Connections page reads from the same key when the
  // user lands there post-webhook.
  const [secret, setSecret] = useState<string>(() =>
    window.localStorage.getItem(PENDING_SIGNING_SECRET_KEY) ?? "",
  );
  const [secretCopied, setSecretCopied] = useState(false);

  const handleGenerate = () => {
    const next = generateSigningSecret();
    setSecret(next);
    window.localStorage.setItem(PENDING_SIGNING_SECRET_KEY, next);
  };
  const handleCopySecret = async () => {
    if (!secret) return;
    await copyToClipboard(secret);
    setSecretCopied(true);
    window.setTimeout(() => setSecretCopied(false), 1500);
  };

  return (
    <div className="space-y-5">
      <div>
        <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold mb-1.5">
          Webhook signing secret <span className="text-slate-500 normal-case font-normal">(recommended)</span>
        </div>
        <div className="text-[11px] text-slate-500 mb-2">
          Verkada Command's <strong className="text-slate-300">Shared secret</strong> field is set by you, not assigned. Generate one here, paste it into Verkada, and we'll remember it for the Connection form once your first webhook arrives.
        </div>
        {secret ? (
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-xs text-amber-200 bg-amber-950/30 border border-amber-900/50 rounded px-3 py-2 break-all">
              {secret}
            </code>
            <button
              onClick={handleCopySecret}
              className="shrink-0 text-xs px-3 py-2 rounded border border-white/15 bg-white/5 hover:bg-white/10 text-slate-200"
            >
              {secretCopied ? "Copied" : "Copy"}
            </button>
            <button
              onClick={handleGenerate}
              className="shrink-0 text-xs px-3 py-2 rounded border border-white/15 bg-white/5 hover:bg-white/10 text-slate-200"
              title="Regenerate"
            >
              ↻
            </button>
          </div>
        ) : (
          <button
            onClick={handleGenerate}
            className="text-sm px-3 py-2 rounded bg-sky-700 hover:bg-sky-600 text-white"
          >
            Generate signing secret
          </button>
        )}
      </div>

      <div>
        <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold mb-1.5">
          Your public webhook URL{ephemeral ? " (changes on restart)" : ""}
        </div>
        {url ? (
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <Redacted persistent>
                <code className="font-mono text-sm text-emerald-200 bg-emerald-950/30 border border-emerald-900/50 rounded px-3 py-2 break-all inline-block w-full">
                  {url}
                </code>
              </Redacted>
            </div>
            <button
              onClick={onCopy}
              className="shrink-0 text-xs px-3 py-2 rounded border border-white/15 bg-white/5 hover:bg-white/10 text-slate-200"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        ) : (
          <div className="text-sm text-slate-500 italic px-3 py-2 rounded border border-dashed border-white/10 bg-white/5">
            Waiting for cloudflared to come online…
          </div>
        )}
      </div>

      <div>
        <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold mb-2">
          Wire it into Verkada Command
        </div>
        <ol className="space-y-1.5 text-sm text-slate-300 list-decimal list-inside marker:text-slate-500">
          <li>
            Verkada Command → <strong className="text-slate-100">Admin</strong> → <strong className="text-slate-100">API &amp; Integrations</strong> → <strong className="text-slate-100">Webhooks</strong> → <strong className="text-slate-100">Add</strong>
          </li>
          <li>Paste the URL above as <strong className="text-slate-100">Endpoint URL</strong></li>
          <li>Paste the signing secret above as <strong className="text-slate-100">Shared secret</strong></li>
          <li>Pick the notification types you want (or "all events" to start)</li>
          <li>
            Click <strong className="text-slate-100">Save</strong>, then <strong className="text-slate-100">Send test webhook</strong>
          </li>
        </ol>
      </div>

      {ephemeral && (
        <div className="text-[11px] text-amber-300/90 bg-amber-950/30 border border-amber-900/50 rounded px-3 py-2">
          ⚠ This URL is ephemeral. Every time the stack restarts, the URL changes
          and you'll need to re-paste it into Verkada Command. For production,
          set up a named tunnel (see the README).
        </div>
      )}
    </div>
  );
}


function LanModeBody({ anyWebhookReceived }: { anyWebhookReceived: boolean }) {
  void anyWebhookReceived;
  return (
    <div className="space-y-4">
      <div className="text-sm text-slate-300 bg-slate-800/50 border border-white/10 rounded px-4 py-3">
        Running in <span className="font-semibold text-slate-100">LAN-only</span> mode.
        Webhooks from Verkada's cloud can't reach your machine, so the dashboard
        stays gated until you switch to a public tunnel.
      </div>

      <div>
        <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold mb-2">
          To accept webhooks from Verkada's cloud
        </div>
        <p className="text-sm text-slate-300 mb-2">
          Stop the stack and bring it up with a tunnel profile:
        </p>
        <pre className="font-mono text-xs bg-slate-950/70 border border-white/10 rounded px-3 py-2 text-slate-200 overflow-x-auto">
{`# free temporary URL (no Cloudflare account):
docker compose --profile quick up -d

# OR stable URL on your own domain (production):
docker compose --profile cloudflared up -d`}
        </pre>
      </div>

      <div className="text-[11px] text-slate-500">
        Already happy with LAN-only? You can also send a real Verkada webhook to{" "}
        <code className="font-mono">http://localhost:18080/hooks/verkada</code> from
        anywhere that can reach this machine (e.g. a Tailscale-connected device, or
        via a manual reverse-proxy you've set up).
      </div>
    </div>
  );
}


function WaitingFooter({
  anyWebhookReceived,
  mode,
}: {
  anyWebhookReceived: boolean;
  mode: "quick" | "named" | "lan";
}) {
  return (
    <div className="border-t border-white/10 pt-4 space-y-3">
      {anyWebhookReceived && (
        <div className="flex items-start gap-2 text-sm bg-emerald-950/30 border border-emerald-900/50 rounded px-3 py-2">
          <span className="text-emerald-300 text-lg leading-none mt-0.5">✓</span>
          <div>
            <div className="text-emerald-200 font-semibold">
              Stack is healthy — at least one webhook has reached the server.
            </div>
            <div className="text-emerald-300/80 text-[11px] mt-0.5">
              Smoke-test traffic counts here (it tells you ingest is working). It's
              not the same as a real Verkada webhook — that's what unlocks the dashboard.
            </div>
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 text-sm">
        <span className="inline-block w-2 h-2 rounded-full bg-sky-400 animate-pulse" />
        <span className="text-slate-200">Waiting for first real Verkada webhook…</span>
      </div>
      <div className="text-[11px] text-slate-500">
        {mode === "lan"
          ? "A real Verkada webhook means one with a valid UUID org_id from Verkada's cloud — which can't reach LAN-only mode. Restart with a tunnel profile (above)."
          : "A real Verkada webhook means one from Verkada Command with a valid UUID org_id. Once it lands here, the dashboard unlocks automatically."}
      </div>
    </div>
  );
}


/**
 * Optional UX flourish: when the gate first dismisses, briefly mount a
 * full-screen success splash before letting the dashboard render. We
 * skip this for now — the modal vanishing into the inbox is clean
 * enough. Kept as a placeholder hook in case we want to add it later.
 */
export function useOnboardingTransition(needsOnboarding: boolean) {
  const [showSplash, setShowSplash] = useState(false);
  const [wasGated, setWasGated] = useState(needsOnboarding);
  useEffect(() => {
    if (wasGated && !needsOnboarding) {
      setShowSplash(true);
      const t = setTimeout(() => setShowSplash(false), 1500);
      return () => clearTimeout(t);
    }
    setWasGated(needsOnboarding);
  }, [needsOnboarding, wasGated]);
  return showSplash;
}
