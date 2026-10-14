# ADR-0004: License under AGPL-3.0-only

- **Status:** Accepted (2026-10-12)
- **Deciders:** project owner

## Context

Void is an open-source alternative to proprietary commercial agent CLIs. The license
choice was deferred at M0 (docs/mvp-scope.md open items) and
blocked the `v0.1.0-mvp` tag. Candidates: MIT, Apache-2.0, AGPL-3.0-only.

## Decision

License the project **AGPL-3.0-only** (SPDX `AGPL-3.0-only`): full text in
[`LICENSE`](../../LICENSE); `package.json` carries the SPDX identifier.

## Consequences

**Positive.** Strong copyleft with the network-use clause (AGPL §13): anyone who runs a
modified Void as a network service must offer source to those users, and any fork of Void
must remain under AGPL. For a project whose explicit goal is an open alternative to a
proprietary product, this maximally protects the commons: competitors cannot absorb Void's
improvements into closed offerings without contributing back. It is also consistent with
the trust-first posture (ADR-0002) — the whole product is inspectable by construction.

**Negative/accepted costs.** AGPL is radioactive for many corporate legal departments:
adoption inside restrictive enterprises may be blocked, and commercial dual-licensing (a
la GitLab/MongoDB) is effectively foreclosed for contributors who haven't signed a CLA
(no CLA exists; every contributor keeps their copyright under the inbound=outbound
default). Some ecosystems (certain Apache-2.0 projects) treat AGPL as incompatible for
linking. Mitigations: none taken now — the competitive positioning outweighs enterprise
adoption friction at MVP stage; revisit only with an explicit owner decision plus a CLA
strategy.

**Practical notes.** Third-party vendored code is absent by policy (ADR-0001 zero runtime
deps; prompts and docs are original, clean-room rules per AGENTS.md), so no license
mixing exists today. Future dependencies must be AGPL-compatible (MIT/Apache-2.0/BSD
inbound are fine; no new AGPL-incompatible code in `src/`).
