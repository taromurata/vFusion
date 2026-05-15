import { Family, SignatureStatus } from "../lib/api";

const FAMILY_STYLE: Record<Family, string> = {
  camera: "bg-sky-900 text-sky-200",
  access: "bg-violet-900 text-violet-200",
  lpr: "bg-emerald-900 text-emerald-200",
  sensor: "bg-amber-900 text-amber-200",
  intercom: "bg-pink-900 text-pink-200",
  credential: "bg-indigo-900 text-indigo-200",
  alarm: "bg-red-900 text-red-200",
  unknown: "bg-rose-900 text-rose-200",
};

export function FamilyBadge({ family }: { family: Family | null }) {
  const f = family ?? "unknown";
  return (
    <span
      className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${FAMILY_STYLE[f]}`}
      title={f === "unknown" ? "Not recognized — review in Unrecognized tab" : f}
    >
      {f}
    </span>
  );
}

const SIG_STYLE: Record<SignatureStatus, string> = {
  verified: "bg-emerald-900 text-emerald-200",
  bad_signature: "bg-rose-900 text-rose-200",
  unverified: "bg-slate-800 text-slate-400",
  missing_header: "bg-slate-800 text-slate-400",
};

const SIG_LABEL: Record<SignatureStatus, string> = {
  verified: "✓ verified",
  bad_signature: "✗ bad sig",
  unverified: "unverified",
  missing_header: "unsigned",
};

export function SignatureBadge({
  status,
}: {
  status: SignatureStatus | null;
}) {
  if (!status) return null;
  if (status === "unverified" || status === "missing_header") return null;
  return (
    <span
      className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${SIG_STYLE[status]}`}
      title={
        status === "verified"
          ? "HMAC verified against the stored signing secret."
          : status === "bad_signature"
            ? "Signature didn't verify — either wrong secret, replay, or spoof."
            : status === "unverified"
              ? "No webhook signing secret stored for this org — can't HMAC-verify. Add one on the Connections page to enable verification."
              : "No verkada-signature header on the request."
      }
    >
      {SIG_LABEL[status]}
    </span>
  );
}
