# AI Guided Reader Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify the Claude audit against the AI Guided Reader code and fix every confirmed functional, licensing, security, privacy, and release-compliance defect without changing unrelated repository areas.

**Architecture:** Keep the Zotero plugin as the local client and the Cloudflare licensing Worker as the sole entitlement authority. Harden trust boundaries at shared URL/fetch helpers, persist only bounded recovery capabilities, keep generated claims tied to verified source anchors, and make release compliance derive from every production runtime package.

**Tech Stack:** TypeScript 5, React 19, Zotero 9 bootstrap plugin APIs, Cloudflare Workers/D1, Node test runner, Vitest, npm, GitHub Actions.

---

## Task 1: Establish evidence and regression tests

- [ ] Reproduce each audit claim from current source and classify it as confirmed, false positive, or runtime-only.
- [ ] Add focused failing tests for confirmed licensing refresh/recovery, grounded claim, Anki safety, URL validation, network timeout, CLI portability, and release-audit behavior.
- [ ] Run each focused test before implementation and record the expected failure.

## Task 2: Repair entitlement recovery and anti-abuse controls

- [ ] Give signed entitlements a real offline refresh window that precedes final expiry.
- [ ] Let the Worker consult authoritative entitlement state when refreshing an expired/stale local token.
- [ ] Persist a bounded pending-order recovery capability and expose retry/recovery behavior after restart.
- [ ] Handle signing-key rotation and catalog outages without destroying still-verifiable local state.
- [ ] Strengthen trial/order rate limiting and relay identity handling without treating client-side checks as authorization.
- [ ] Verify payment amount, plan, device binding, replay protection, and checkout month behavior remain server-controlled.

## Task 3: Harden generated content and exports

- [ ] Remove the domain-specific fabricated inhibitor-selection sentence.
- [ ] Preserve valid generic inhibitor conclusions while requiring decisive table-row evidence for numbered claims.
- [ ] Export Anki content as inert text or correctly escaped HTML with no executable markup.
- [ ] Remove dead reader-highlight code and fix lifecycle/dependency issues found by static analysis.

## Task 4: Harden network and local CLI boundaries

- [ ] Add bounded request timeouts to LLM, MinerU, semantic, model-discovery, and key-validation calls.
- [ ] Validate configurable service base URLs: HTTPS in production, loopback HTTP only for local development.
- [ ] Validate MinerU signed transfer URLs, redirect behavior, content type, and response size before processing.
- [ ] Make local Codex/Claude executable discovery portable across Windows, macOS, and Linux.
- [ ] Avoid ambiguous empty CLI tool arguments and verify command construction through tests.

## Task 5: Align privacy, localization, and subscription UI

- [ ] Make privacy disclosures match persisted hashed rate-limit records and include the transmitted client version.
- [ ] Add a visible catalog retry/fallback path and keep plan controls usable at narrow sidebar widths.
- [ ] Resolve misleading English-locale coverage by localizing user-visible subscription and reader status strings or documenting the supported locale truthfully.
- [ ] Align NOTICE, README, terms, and marketplace-facing payment language with the live Afdian subscription flow.

## Task 6: Correct supply-chain and release compliance

- [ ] Upgrade KaTeX to the patched release and refresh the lockfile.
- [ ] Include the production licensing Worker and Afdian relay in license audits, SBOM generation, third-party notices, and CI release checks.
- [ ] Mark the legacy licensing service as non-production and exclude it from release artifacts without deleting unrelated historical code.
- [ ] Run dependency audits and scan the staged diff for secrets and generated build artifacts.

## Task 7: Verify, review, and commit

- [ ] Run plugin tests, TypeScript, formatting/lint, Worker tests/typecheck, relay tests, production build, commercial checks, license audit, SBOM, checksums, and XPI inspection.
- [ ] Have Claude perform one final read-only review of the completed AI Guided Reader diff using the strongest available model and maximum reasoning.
- [ ] Independently validate every actionable Claude review item and fix confirmed blockers.
- [ ] Commit each logical change locally with focused Conventional Commit messages and leave the branch ready for the user's next release action.
