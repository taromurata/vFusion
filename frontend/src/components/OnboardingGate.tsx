import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { apiGet, PublicConfig } from "../lib/api";

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
    queryKey: ["public-config-onboarding"],
    queryFn: () => apiGet<PublicConfig>("/api/config"),
    // Poll fast while gated. After we dismiss, the WebhookEndpointBanner
    // takes over with a slower cadence on the inbox page.
    refetchInterval: (q) => (q.state.data?.needs_onboarding ? 2000 : 30_000),
  });

  // First-load grace: don't flash the modal before we know the answer.
  // Once we have at least one response, trust it.
  if (!cfg.data) return <>{children}</>;

  if (!cfg.data.needs_onboarding) return <>{children}</>;

  return <OnboardingModal cfg={cfg.data} />;
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

  const copy = () => {
    if (!url) return;
    navigator.clipboard.writeText(url);
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
            Welcome to vSplice
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
  return (
    <div className="space-y-4">
      <div>
        <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold mb-1.5">
          Your public webhook URL{ephemeral ? " (changes on restart)" : ""}
        </div>
        {url ? (
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-sm text-emerald-200 bg-emerald-950/30 border border-emerald-900/50 rounded px-3 py-2 break-all">
              {url}
            </code>
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
            Verkada Command → <strong className="text-slate-100">Settings</strong> → <strong className="text-slate-100">Webhooks</strong> → <strong className="text-slate-100">Create webhook</strong>
          </li>
          <li>Paste the URL above as the endpoint</li>
          <li>Pick the notification types you want (or "all events" to start)</li>
          <li>
            <strong className="text-slate-100">Save</strong> and copy the signing secret Verkada shows
          </li>
          <li>Click <strong className="text-slate-100">Send test webhook</strong></li>
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
    <div className="border-t border-white/10 pt-4 space-y-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="inline-block w-2 h-2 rounded-full bg-sky-400 animate-pulse" />
        <span className="text-slate-200">Waiting for first Verkada webhook…</span>
      </div>
      <div className="text-[11px] text-slate-500">
        {anyWebhookReceived
          ? "✓ Stack received its first request — keep going to send a real Verkada webhook to unlock."
          : mode === "lan"
            ? "Nothing's arrived yet."
            : "Nothing's arrived yet. Once you finish the Verkada Command setup above and send a test webhook, the dashboard will unlock automatically."}
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
