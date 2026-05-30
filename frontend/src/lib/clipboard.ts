/**
 * Cross-browser clipboard helper.
 *
 * Why this exists: `navigator.clipboard.writeText` is gated by the
 * "secure context" rule — browsers only expose the modern Clipboard
 * API on https:// or http://localhost. Operators running vFusion on
 * a homelab box and browsing to `http://192.168.x.x:15173` from
 * their laptop hit a plain LAN HTTP origin, where `navigator.clipboard`
 * is either undefined or rejects with a SecurityError, and every
 * Copy button silently does nothing.
 *
 * Fallback path uses the legacy `document.execCommand('copy')` trick:
 * spin up an off-screen textarea, select its contents, execCommand,
 * remove. Deprecated but still supported in every browser shipping
 * today, and it works on insecure origins.
 *
 * Returns true on success so callers can flip a "Copied" affordance
 * without having to handle the promise themselves.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // Prefer the modern API when available — it handles focus / permissions
  // properly and works around browsers that disable execCommand.
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function" &&
    window.isSecureContext
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path — some embedded webviews
      // expose the API but block writes.
    }
  }

  // Legacy fallback. Position off-screen so it doesn't visibly flicker.
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.left = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    // iOS Safari requires the textarea to be both contentEditable and
    // not readonly for the selection to take, but doing that elsewhere
    // pops the soft keyboard. The combination below is the smallest
    // that works across desktop + mobile.
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
