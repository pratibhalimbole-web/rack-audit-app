# Rack Audit — Inspector App: Summary & User Flow

## What it is
A mobile/tablet web app (`rack-audit-app.html`) used by a warehouse **auditor/inspector** to run inventory reconciliation audits for RAMS IRDS: logging in, picking a location within an assigned audit, counting/scanning pallets at that location, and submitting a completed audit summary. It now authenticates and reads/writes against a real Supabase backend (project wired in `rack-audit-app.html`), not just mock data.

## Screens
1. **Login** — email/password.
2. **Dashboard** — "Ongoing Audit" card (resume shortcut) + preview of assigned tasks.
3. **My Audit Tasks** — full list of assigned audits, filterable/searchable by status.
4. **Audit Details** — one audit's scope, dates, status; entry point into counting.
5. **Count Sheet** — the core screen: pick/scan a location, then count pallets/SKUs there.
6. **Quick Scan** — global entry point (tab bar) to scan any location QR and jump straight to the right audit's Count Sheet.
7. **Audit Progress** — per-location completion rollup for an audit in progress.
8. **Audit Summary** — final totals + flagged (non-"Good" condition) items + Submit.

---

## Primary User Flow

```
Login
  → Dashboard
      → (tap a task) Audit Details
          → Count Sheet
              → Pick location (manual cascade: Layout → Rack → Bay → Storage Location)
                 OR Scan location QR
              → Count Sheet reveals counting UI for that location
                  → Add pallet → enter Quantity + Condition → Save Record
                  → (repeat for every pallet at that location)
              → Mark Location Complete & Continue
                  → auto-advances to next pending location
                  → OR, if that was the last one → Audit Progress → Audit Summary
          → Audit Summary
              → Review totals, condition breakdown, Flagged Items
              → Submit Audit → audit becomes read-only (Submitted)
```

**Quick Scan shortcut** (bottom tab bar, available anywhere): scan a storage-location QR → app finds which of the inspector's own assigned, non-completed audits has that location in scope (prefers one already In Progress) → jumps directly into that audit's Count Sheet at that location.

---

## Success Paths

| Step | Success condition | Result |
|---|---|---|
| Login | Valid email/password against Supabase auth | Routed to Dashboard |
| Pick location | Field has exactly one valid option | Auto-filled (locked "Only option" pill) |
| Pick location | Field has multiple options | Inspector selects via bottom-sheet picker |
| Scan location QR | Code decodes to a Layout+Rack+Bay+Storage Location inside the audit's assigned scope | All four fields fill at once; toast confirms; re-scan replaces prior result |
| Save Record | Quantity + Condition entered for a pallet | Pallet saved under that location; location stays open for more pallets |
| Mark Location Complete | All pallets at that location saved | Location → Completed; auto-advances to next pending location |
| Finish last location | Every location in the audit's scope is Completed | Routed to Audit Progress → Audit Summary |
| Submit Audit | Inspector reviews summary and confirms | Audit status → Submitted; screen becomes read-only |
| Quick Scan | Code is a valid location tag inside a scoped, non-completed audit | Direct jump into that audit's Count Sheet, location pre-filled |

## Fail / Edge Paths

| Step | Failure condition | Handling |
|---|---|---|
| Login | Wrong credentials | Inline error banner on Login; stays on screen |
| Audit Details | Audit already fully counted or Submitted | Screen is state-aware: shows a completed-state card + "View Audit Summary" instead of a live Start/Resume button (no dead-end into a read-only picker) |
| Dashboard "Ongoing Audit" | Audit is fully counted but not yet submitted | Card shows "View Audit Summary" instead of "Resume Audit" (avoids dropping the inspector into a completed, read-only location) |
| Scan location QR | Code is outside the current audit's assigned scope | Rejected with a specific reason; does **not** clobber any prior valid selection |
| Scan location QR | Prior valid selection exists and inspector re-scans | Previous result replaced; toast confirms the replacement |
| Change location mid-count | A pallet/SKU count is entered but not yet saved | In-app confirm modal warns before discarding the unsaved entry (not the browser's native `confirm()`) |
| Save Record | Quantity/Condition missing | Save is blocked until both are provided |
| Quick Scan | Code is the wrong type (pallet/SKU tag, not a location tag) | Clear rejection message; if a location is already in progress, offers a "Continue at X" shortcut instead |
| Quick Scan | Code doesn't match any of the inspector's assigned, non-completed audits | Rejected — no audit to route into |
| Mark Location Complete | Attempted before scope's mandatory location fields are all chosen | Blocked — a level only auto-fills when genuinely fixed (single option); real choices are never silently defaulted |

---

## Not yet implemented
- Offline/sync handling and real camera-based barcode scanning (scanning is simulated).
- No automated end-to-end test suite (verification has been manual/scripted DOM checks).

*Based on `rack-audit-app.html` and project session notes (`SESSION-SUMMARY.md`, `SESSION-SUMMARY-2026-07-09.md`) as of 2026-07-20.*
