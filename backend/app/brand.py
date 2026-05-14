"""Single source of truth for the product brand name.

Used by the FastAPI app title, the /api/config payload (which the
frontend reads to render the dashboard header + onboarding modal), and
all user-facing help-text strings in the connection / action specs.

To rebrand: edit ``BRAND_NAME`` here, commit, and redeploy. The change
flips everywhere on the next backend start — no env vars, no per-deploy
config. By keeping this in code rather than ``.env``, casual deployers
can't relabel the product without explicitly forking the codebase.

Manual edits still needed for a true rebrand (these are docs / dev
surface, not runtime):
  - README.md, CONTINUE.md
  - frontend/index.html ``<title>``
  - frontend/package.json ``name``
  - GitHub repo name (via the GitHub UI)
"""

BRAND_NAME: str = "vFusion"
