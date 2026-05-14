import { useSearchParams } from "react-router-dom";

import Byoa from "./Byoa";
import Helixr from "./Helixr";


/**
 * Workbench has two sections, picked via ``?tab=`` so URLs stay shareable
 * and "Run it back" links from past runs keep working:
 *
 *   - **BYOA** (Brew Your Own Analytics): one-shot Gemini test runner.
 *     Pick a camera, write a prompt, see what the model returns —
 *     without committing to a flow first.
 *
 *   - **Helixr**: manage Helix video-tagging event types for a Verkada
 *     org. Same data the flow editor's helix_event_ref dropdown reads,
 *     but writable — create new types and edit existing ones in place.
 */

type Tab = "byoa" | "helixr";

const TABS: { key: Tab; label: string; blurb: string }[] = [
  {
    key: "byoa",
    label: "BYOA",
    blurb:
      "Brew Your Own Analytics — one-shot Gemini run. Pick a camera, write a prompt, see what comes back without baking it into a flow first.",
  },
  {
    key: "helixr",
    label: "Helixr",
    blurb:
      "Manage Helix video-tagging event types. Create the templates flows post events against, or edit existing ones.",
  },
];


export default function Workbench() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("tab");
  const tab: Tab = requested === "helixr" ? "helixr" : "byoa";
  const setTab = (next: Tab) => {
    const p = new URLSearchParams(searchParams);
    p.set("tab", next);
    setSearchParams(p, { replace: true });
  };
  const meta = TABS.find((t) => t.key === tab) ?? TABS[0];

  return (
    <div className="space-y-6">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-2xl font-semibold text-white">Workbench</h1>
        <p className="text-slate-300 text-sm mt-1">{meta.blurb}</p>
        {tab === "helixr" && (
          <p className="text-xs text-slate-500 mt-1.5 italic">
            Helixr — name coined by{" "}
            <span className="text-slate-300 not-italic font-medium">
              Andrew Stone
            </span>
            .
          </p>
        )}

        <div className="mt-4 flex items-center gap-1 border-b border-white/10">
          {TABS.map((t) => {
            const active = t.key === tab;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`relative px-4 py-2 text-sm font-medium transition-colors ${
                  active
                    ? "text-white"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {t.label}
                {active && (
                  <span className="absolute left-0 right-0 -bottom-px h-0.5 bg-sky-500" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        {tab === "byoa" && <Byoa />}
        {tab === "helixr" && (
          <div className="max-w-3xl mx-auto">
            <Helixr />
          </div>
        )}
      </div>
    </div>
  );
}
