import { useState } from "react";


/**
 * Renders text under a privacy blur so it's safe to leave on screen
 * during recordings / demos. Click or hover-and-hold to reveal.
 *
 * The redacted state has two layers stacked over the content:
 *
 *   1. A heavy CSS ``backdrop-filter: blur`` so the text underneath
 *      is unreadable. We keep the underlying text rendered (not
 *      hidden) so the layout reserves the right width and copying
 *      via the clipboard helper next to it still works.
 *   2. A "ink particles" overlay built from a noisy radial gradient.
 *      It animates with a slow drift, giving the iMessage-invisible-
 *      ink vibe — the eye reads "something's hidden here" without
 *      having to label it.
 *
 * Hover OR click clears both layers with an opacity transition. We
 * also expose a small `eye` icon as an explicit affordance so
 * keyboard-only users (and screenshot-takers) know to interact.
 */
export default function Redacted({
  children,
  // ``persistent`` flips a click into a sticky reveal — useful when
  // the operator wants to grab a screenshot of the value but doesn't
  // want it visible to whoever they're sharing with otherwise.
  persistent = false,
}: {
  children: React.ReactNode;
  persistent?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const [hovering, setHovering] = useState(false);
  const showing = revealed || hovering;

  return (
    <span
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onClick={() => persistent && setRevealed((r) => !r)}
      title={
        showing
          ? persistent
            ? "Click to hide again"
            : "Move away to hide again"
          : "Hover (or click) to reveal — kept blurred so it's safe on screen recordings"
      }
      className={`relative inline-block align-middle ${persistent ? "cursor-pointer" : "cursor-help"}`}
    >
      {/* The actual content stays in the DOM so widths + click-to-
          copy via a sibling element keep working. */}
      <span
        className={`transition duration-300 ${
          showing ? "filter-none" : "blur-[6px] select-none"
        }`}
      >
        {children}
      </span>
      {/* Ink-particle overlay. Layered radial gradients drift in opposite
          directions for a "diffusing dots" feel. ``pointer-events-none``
          so it doesn't swallow clicks meant for the wrapper. */}
      {!showing && (
        <span
          aria-hidden
          className="absolute inset-0 pointer-events-none rounded ink-particles opacity-95"
        />
      )}
      {/* Tiny eye chip in the corner — explicit affordance for the
          "this is hideable" gesture. Hidden once revealed. */}
      {!showing && (
        <span
          aria-hidden
          className="absolute -top-1 -right-1 text-[10px] text-slate-300/80 select-none pointer-events-none"
        >
          👁
        </span>
      )}
    </span>
  );
}
