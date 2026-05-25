/**
 * Per-action / per-trigger icons used on the canvas.
 *
 * Kept as a small static map here rather than asking the backend to
 * declare an icon on each ActionSpec — emoji ship instantly, are
 * consistent across platforms, and we don't need server validation for
 * a cosmetic field. Add new entries when new actions are introduced;
 * the unknown-action fallback (✨) is intentionally generic so a new
 * action without an entry still renders cleanly.
 */

export function actionIcon(actionType: string | null | undefined): string {
  if (!actionType) return "•";
  // Gemini-family analyses share the sparkle — easy mental shortcut
  // for "AI happens here".
  if (actionType.startsWith("gemini_")) return "✨";
  // Verkada actions: split by what they actually do, since the user
  // cares about the verb more than the vendor.
  if (actionType === "verkada_unlock_door") return "🔓";
  // Helix → double-helix → DNA. The on-canvas read matches the
  // product name, which makes the card instantly recognizable.
  if (actionType === "verkada_helix_event") return "🧬";
  if (actionType === "verkada_grab_clip") return "🎞️";
  if (actionType === "verkada_grab_still") return "📷";
  if (actionType === "verkada_activate_scenario") return "🚨";
  if (actionType === "verkada_release_scenario") return "✅";
  if (actionType === "verkada_api_call") return "🛰️";
  if (actionType.startsWith("verkada_")) return "📹";
  // Generic catch-all so future actions still render something.
  return "⚙️";
}

export function triggerIcon(triggerType: string | null | undefined): string {
  if (triggerType === "schedule") return "⏰";
  // Webhooks are HTTP payloads — render the universal code shorthand
  // instead of an emoji. The canvas component renders the icon slot
  // as text-xl so "</>" appears at the same visual weight as an emoji.
  return "</>";
}

export function conditionIcon(): string {
  return "🔀";
}
