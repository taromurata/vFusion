import { useEffect, useState } from "react";

import { TemplateSummaryStep } from "../lib/api";
import {
  actionIcon,
  conditionIcon,
  triggerIcon,
} from "./flow-canvas/icons";


/**
 * Horizontal animated mini-flow drawn on each template card.
 *
 * Pills (icon over short label) are connected by dashed arrows that
 * flow left-to-right via a CSS keyframe. A "spotlight" cycles through
 * the steps every couple seconds so the card has a sense of life
 * without being busy — each step momentarily glows in turn, then the
 * cycle wraps.
 *
 * The icon source-of-truth is the canvas icon map (``actionIcon`` et
 * al), so the strip stays in sync with what the operator will see
 * when they open the editor.
 */
export default function TemplateSummaryStrip({
  steps,
}: {
  steps: TemplateSummaryStep[];
}) {
  // ``active`` cycles through visible step indices. Pause when the
  // strip isn't visible (CSS animations would keep ticking otherwise),
  // but for now we just let it run — single setInterval per card is
  // cheap enough.
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (steps.length === 0) return;
    const id = window.setInterval(() => {
      setActive((i) => (i + 1) % steps.length);
    }, 1200);
    return () => window.clearInterval(id);
  }, [steps.length]);

  if (steps.length === 0) return null;

  return (
    // ``px-3`` reserves horizontal slack so the highlighted-step glow
    // (which renders outside the pill's box) doesn't clip against the
    // overflow-scroll container on the first / last step. Vertical
    // ``py-2`` keeps the spotlight scale-up (105%) from clipping at
    // the top / bottom — bumped down from py-3 to keep template
    // cards compact for at-a-glance reading.
    <div className="flex items-stretch gap-1 overflow-x-auto px-3 py-2">
      {steps.map((s, i) => (
        <div key={i} className="flex items-stretch gap-1 shrink-0">
          <StepPill step={s} highlighted={i === active} />
          {i < steps.length - 1 && <FlowArrow highlighted={i === active} />}
        </div>
      ))}
    </div>
  );
}


function StepPill({
  step,
  highlighted,
}: {
  step: TemplateSummaryStep;
  highlighted: boolean;
}) {
  const icon = iconFor(step);
  const label = displayLabel(step);
  // Color band per kind matches the canvas node styling: trigger sky,
  // condition amber, action neutral with a slight purple for Gemini.
  const tone = toneFor(step);
  return (
    <div
      className={`flex flex-col items-center justify-center w-20 px-1.5 py-1.5 rounded border text-center transition-all duration-300 ${tone} ${
        highlighted
          ? "scale-105 shadow-[0_0_14px_rgba(56,189,248,0.45)] border-sky-400/80"
          : ""
      }`}
      title={label}
    >
      <span className="text-base leading-none mb-0.5" aria-hidden>
        {icon}
      </span>
      <span className="text-[9px] leading-tight text-slate-200 line-clamp-2 break-words">
        {label}
      </span>
    </div>
  );
}


function FlowArrow({ highlighted }: { highlighted: boolean }) {
  // Width matches the pill width so the chain reads as evenly-spaced
  // beats. Dash animation drifts left->right; highlighted segments
  // brighten + speed up to draw the eye through the sequence.
  return (
    <div className="flex items-center w-6">
      <svg
        viewBox="0 0 24 8"
        preserveAspectRatio="none"
        className="w-full h-2 overflow-visible"
        aria-hidden
      >
        <line
          x1="0"
          y1="4"
          x2="20"
          y2="4"
          stroke={highlighted ? "#38bdf8" : "#64748b"}
          strokeWidth={highlighted ? 1.5 : 1}
          strokeDasharray="3 2"
          className={highlighted ? "summary-arrow-fast" : "summary-arrow-slow"}
        />
        <polygon
          points="20,1.5 24,4 20,6.5"
          fill={highlighted ? "#38bdf8" : "#64748b"}
        />
      </svg>
    </div>
  );
}


function iconFor(step: TemplateSummaryStep): string {
  if (step.kind === "trigger") return triggerIcon(step.trigger_type ?? null);
  if (step.kind === "condition") return conditionIcon();
  return actionIcon(step.action_type ?? null);
}


function displayLabel(step: TemplateSummaryStep): string {
  if (step.label) return step.label;
  if (step.kind === "trigger") {
    return step.trigger_type === "schedule" ? "Schedule" : "Webhook";
  }
  if (step.kind === "condition") return "Condition";
  return step.action_type ?? "Action";
}


function toneFor(step: TemplateSummaryStep): string {
  if (step.kind === "trigger") {
    return "bg-sky-950/60 border-sky-900/60";
  }
  if (step.kind === "condition") {
    return "bg-amber-950/40 border-amber-900/60";
  }
  // Gemini analyze actions get a purple tint so they jump out vs.
  // Verkada-side actions (helix, door, scenario). Visual continuity
  // with the Gemini Vision tag on the card header.
  if ((step.action_type ?? "").startsWith("gemini_")) {
    return "bg-violet-950/40 border-violet-900/60";
  }
  return "bg-slate-800/60 border-slate-700/60";
}
