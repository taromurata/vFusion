/**
 * Brand-name hook. Reads ``brand_name`` from the cached /api/config
 * response; falls back to ``vFusion`` while the first response is in
 * flight (matches the backend default in ``app/brand.py``, so the swap
 * is invisible).
 *
 * To rebrand: edit ``BRAND_NAME`` in ``backend/app/brand.py``. The
 * frontend picks up the new value on the next /api/config poll. The
 * fallback below only matters for the brief window before the very
 * first config fetch completes.
 */

import { useQuery } from "@tanstack/react-query";

import { apiGet, PublicConfig } from "./api";


const FALLBACK_BRAND = "vFusion";


export function useBrand(): string {
  const cfg = useQuery({
    queryKey: ["public-config"],
    queryFn: () => apiGet<PublicConfig>("/api/config"),
    staleTime: 60_000,
  });
  return cfg.data?.brand_name || FALLBACK_BRAND;
}
