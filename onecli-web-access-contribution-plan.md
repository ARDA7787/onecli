# OneCLI Web Access Policy Layer

**Gateway-enforced, per-agent control over public-web traffic (`Target::Web`), compiled into the existing PolicyRuleV2 engine.**

Engineering plan, PRD, and contribution strategy — prepared against `onecli/onecli` at commit `044ac73` (v2.2.3, 2026-08-25), with the repository cloned and inspected directly. Every repository claim below is labeled **[Verified]** (read from source), **[Inference]** (reasoned from source but not directly stated), or **[Recommendation]** (a design choice this document proposes).

---

## Executive Summary

OneCLI v2 runs one sandboxed agent per employee, with all egress forced through a Rust gateway that injects credentials and enforces a unified first-match policy engine (`PolicyRuleV2`). The engine can already allow, block, require human approval, and rate-limit traffic per agent — but it has **no semantic concept of "the public web."** Blocking rules today either name specific hosts (`Target::Network`) or gate credentialed/app traffic; an agent's ability to _browse arbitrary websites_ cannot be expressed as a single intent, and the deny-default posture deliberately never applies to uncredentialed hosts.

This contribution adds:

1. **A `web` policy target** — a new `Target::Web` variant that matches exactly the traffic class "public internet that is neither an LLM provider nor a managed/credentialed service," implemented in the Rust engine, its TypeScript twin, and the shared parity corpus.
2. **Per-agent Web Access profiles** (`no_web`, `search_only`, `research`, `restricted`, `open`) — a small intent API that _compiles_ to generated `PolicyRuleV2` rows (`source = "web_access"`), reusing the existing publish/generation/cache machinery. No parallel policy engine, no new tables.
3. **A management UI** on the agent page, mirroring the existing policy-editor patterns.
4. **Private-network isolation** — classifying loopback/RFC1918/link-local/metadata destinations separately from the public web and blocking them by default, closing a real SSRF gap (no such filtering exists in the gateway today — [Verified], see §Security).

The single most important finding from code research: **explicit rule blocks are unconditional** in the v2 engine (`evaluate.rs:183-184` — "Default-Block verdicts are gated by the `enforce_deny` carve …; **explicit rule blocks are unconditional**") [Verified]. This means the entire feature can be built as _generated explicit rules_ without touching the deny-default carve that issue #372's older design had to modify. That removes the riskiest backward-compatibility question from the critical path and makes the contribution dramatically more mergeable than the pre-v2 proposal.

**Verdict: Recommended with changes** — proceed, but Phase 0 (a design comment engaging issue #372 and two maintainer questions) is mandatory before writing code. See §Should This Be Built?.

---

## Context Reconstruction

What the preceding conversation established:

**The problem.** OneCLI can express network rules but has no clean distinction between five very different capabilities: agent→LLM, agent→managed connection (Gmail/GitHub), agent→search API, agent→arbitrary public website, agent→internal network. Admins cannot say "this agent may read the web but not write to it" or "this agent gets no web at all" without hand-building host rules — and "block everything" phrased naively would break LLM and managed-app traffic.

**The proposed contribution** (from the prior ChatGPT discussion, subsequently validated against source):

- Extend `PolicyRuleV2` with a `web` target rather than building a second policy engine.
- Introduce a traffic-classification concept (LLM / Managed / PublicWeb, later PrivateNetwork).
- Ship high-level per-agent profiles (No Web, Search Only, Research, Restricted, Open) that compile to rules.
- Reuse existing approval (`require_approval`) and rate-limit (`rate_limit`/`rate_limit_window`) semantics.
- Expose `GET/PUT /v1/agents/:agentId/web-access`; store intent as generated rules with `source = "web_access"` and deterministic logical IDs (idempotent reconciliation).
- Keep the DB-free request path (rules resolved at CONNECT, evaluated in-memory).
- Preserve the no-redirect-following invariant and add a regression test.
- Ship in 4 layered PRs: policy primitive → profiles API → UI → private-network hardening.

**Decisions already made in conversation:**

- Engage issue #372 (per-agent deny-by-default egress control, open since 2026-06-19, author `deweysasser` of nanoclaw, unanswered by maintainers, +1 demand comment on 2026-07-20) rather than route around it. [Verified — issue read in full]
- Framing is "designed and implemented the web-access layer on the PolicyRuleV2 architecture," not "invented per-agent network control" — #372's prior art is substantial (its author built a working pre-v2 implementation).
- Sequencing: maintainer alignment first, then a small PR 1.

**Corrections this document makes to the earlier conversation:**

- _Prior claim:_ method-aware web rules (GET vs POST) only work "where MITM applies," implying opaque tunnels escape. _Corrected:_ **every authenticated agent session is MITM'd** (`gateway.rs:868-870`: "Every session is MITM'd — even one with no injection rules") [Verified], so method/path enforcement covers all agent HTTPS. The remaining tunnel caveat applies only to hypothetical non-MITM paths, not the normal agent flow.
- _Prior claim:_ the feature "relaxes the deny-default carve" and that is the sensitive design conversation. _Corrected:_ it does not need to. Explicit generated rules block unconditionally; the carve (`types.rs:64-66`, `enforce_deny = has_injections && !is_llm_host`) governs only Default-Rule verdicts and is left untouched. [Verified]
- _Prior claim (from the ChatGPT doc):_ "no schema migration initially." _Refined:_ correct — `PolicyRuleTarget` already has nullable `hostPattern`, `pathPattern`, `method` columns and a free-text `kind` column, so `kind = "web"` needs **zero new columns**; only TS validation unions and the `source` comment/type widen. [Verified — `packages/db/prisma/schema.prisma`]

**Open questions carried forward:** OSS vs `ee/` placement of the per-agent surface; priority placement of generated rules relative to admin-authored custom rules; whether uncredentialed traffic to _known app hosts_ counts as "web." All appear in §Maintainer Questions.

---

## Research Findings

Method: `git clone --depth 1` of `onecli/onecli` at `044ac73` (2026-08-25, v2.2.3); direct reads of the gateway (Rust), API package (TypeScript), Prisma schema, web app, contributing docs; issue/PR pages fetched from GitHub.

### Verified facts (with locations)

| #   | Fact                                                                                                                                                                                                                                                          | Source                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | Unified first-match policy engine shipped v1.42.0, 2026-07-23 (#436), replacing the old model                                                                                                                                                                 | `CHANGELOG.md`                                                                                        |
| 2   | Engine targets: `Network {host_pattern, path_pattern, method}`, `App {provider, tools}`, `Connection {id, provider, tools}`, `Secret`                                                                                                                         | `apps/gateway/src/policy_engine/types.rs:161-200`                                                     |
| 3   | `PolicyRequest` carries `host, path, method, agent_id, user_ids, group_ids, has_injections, is_llm_host, winning_connection_id`                                                                                                                               | `types.rs:39-59`                                                                                      |
| 4   | Deny-default carve: `enforce_deny() = has_injections && !is_llm_host`; **explicit rule blocks are unconditional**; Default-Rule Block is a hard floor at its level                                                                                            | `types.rs:61-67`, `evaluate.rs:180-218`                                                               |
| 5   | Actions: `allow`/`block`; `require_approval` and `rate_limit(minute/hour/day)` are modifiers on allow; strictness Block > ManualApproval > RateLimit > Allow, mirrored in `strictness.ts`                                                                     | `types.rs:22-33, 209-238`                                                                             |
| 6   | Rust/TS parity via one golden corpus: Rust `include_str!`s `packages/api/src/services/policy-translation/corpus/policy-cases.json`                                                                                                                            | `policy_engine/corpus_test.rs:15-21`                                                                  |
| 7   | Per-agent rule identities exist and are **not** enterprise-gated (only user/group identities are)                                                                                                                                                             | `types.rs:139-147`; `policy-service.ts:299-302`                                                       |
| 8   | Workspace-scope rules may target a specific agent or "any"; org rules target users/groups                                                                                                                                                                     | `policy-service.ts:362-364`                                                                           |
| 9   | `PolicyRuleV2` has `source` (`"custom" \| "app_permission" \| "blocklist" \| "default" \| "equipment"`), `logicalId` (generation-stable, copied onto publish snapshots), draft/published `status` + `generation`; gateway reads only max published generation | `schema.prisma` (PolicyRuleV2); `policy_engine/loaders.rs:13-32`; `policy-service.ts:15-45,1232-1320` |
| 10  | `PolicyRuleTarget` columns `kind` (free string), `hostPattern`, `pathPattern`, `method` already exist (nullable)                                                                                                                                              | `schema.prisma` (PolicyRuleTarget)                                                                    |
| 11  | Request path is DB-free: rules resolved and cached at CONNECT, evaluated in-memory per request                                                                                                                                                                | `forward.rs:430-465` comments; `connect.rs` resolve/cache                                             |
| 12  | **Every authenticated session is MITM'd**, even with no injection rules — enforcement does not depend on having credentials                                                                                                                                   | `gateway.rs:868-870`; `connect.rs:348-355`                                                            |
| 13  | WebSocket upgrades run a parallel enforcement path mirroring `forward_request` (upgrades are GET)                                                                                                                                                             | `gateway/websocket.rs:94-128`                                                                         |
| 14  | Upstream client sets `redirect::Policy::none()` — 3xx returns to the client, never followed silently                                                                                                                                                          | `gateway.rs:114`                                                                                      |
| 15  | Sandboxes sit on Docker `internal` networks (no route out); the gateway is dual-homed onto them                                                                                                                                                               | `apps/runner/src/config.ts:23-25`                                                                     |
| 16  | **No private-IP / SSRF filtering exists in the gateway** (no loopback/RFC1918/metadata checks anywhere in `apps/gateway/src`)                                                                                                                                 | repo-wide grep                                                                                        |
| 17  | API is Hono, basePath `/v1`, routes in `packages/api/src/routes/` (`agents.ts`, `grants.ts`, …); web dashboard consumes `/v1`                                                                                                                                 | `packages/api/src/app.ts:22-64,135`                                                                   |
| 18  | Policy editor UI exists (`apps/web/src/lib/policy-editor/`, org admin policy page); some editor pieces live under `apps/web/src/ee/`                                                                                                                          | file listing                                                                                          |
| 19  | New-org seeding: cloud seeds an org Default Rule `allow` (opt into deny by flipping to Block); onprem seeds the default workspace's Default Rule pinned allow                                                                                                 | `packages/api/src/providers/hooks/new-org-policy-seeder.ts`                                           |
| 20  | Issue #372 "per-agent network allow lists (deny-by-default egress control)": open, pre-v2 working implementation described by its author, no maintainer response, second user requesting it                                                                   | github.com/onecli/onecli/issues/372                                                                   |
| 21  | Search-provider demand exists: #479 "Add Tavily to OneCLI" (open), #506 "App request: Serply" (open), and an **open PR "feat: add Serply search provider"**                                                                                                   | issue/PR pages                                                                                        |
| 22  | Contribution process: search existing issues; **open an issue before a feature PR**; CLA signed on first PR; `ee/` under a separate enterprise license                                                                                                        | `CONTRIBUTING.md:34,41-43,57-60`, `CLA.md`                                                            |
| 23  | No open PR or issue implements a web-access layer post-v2; the only adjacent open PRs are connectors and gateway fixes                                                                                                                                        | PR list, issue search                                                                                 |

### Key inferences

- **[Inference]** `PublicWeb` is derivable from existing per-request facts as `!is_llm_host && !has_injections`: LLM hosts are flagged, and every managed service (app connection or secret) implies injection. `winning_connection_id` is not needed for classification (a winning connection implies injection).
- **[Inference]** Because generated rules are just rows, the profiles feature inherits publish/rollback/audit and the CONNECT-time cache for free — the "intent → materialized rules" pattern is exactly how `app_permission`, `blocklist`, and `equipment` sources already work (`policy-service.ts:1232-1320`).
- **[Inference]** #372's implementation approach (per-agent `policyMode`, modified `enforce_deny`, CONNECT-time host gate) is obsolete under v2 — its _goals_ are all now expressible as agent-identity explicit rules, which is strictly cleaner. The gap it diagnosed, however, still exists verbatim: `enforce_deny` still couples deny to credentials.

---

## Current 1CLI Architecture (relevant slice)

```
Agent sandbox (Docker `internal` network — no route out)
   │  HTTPS_PROXY → gateway (dual-homed)
   ▼
apps/gateway (Rust)
   CONNECT → authenticate agent → connect.rs: resolve
     • injection rules + app connections for host
     • published policy_rules_v2 (max generation) → cached
     • available apps (ee pre-check)
   → MITM every session (gateway.rs)
   per request (DB-free):
     forward.rs / websocket.rs
       → ee::principals::app_availability_block
       → policy_engine::evaluate(PolicyRequest, rules)
            first-match over explicit rules (org, then workspace band)
            Default Rules gated by enforce_deny carve
            decision: Allow / Block / ManualApproval / RateLimit
       → inject credentials, forward (redirect::Policy::none())
   ▲
packages/api (Hono /v1)
   routes/agents.ts, grants.ts … → services/policy-service.ts
     draft ↔ published generations, per-scope publish serialization,
     source-tagged materialization (app_permission/blocklist/equipment)
   policy-translation (TS twin) + policy-simulate + golden corpus
apps/web (Next.js)
   lib/policy-editor, org policy console, per-agent pages
packages/db  Prisma: PolicyRuleV2, PolicyRuleIdentity, PolicyRuleTarget
```

---

## Problem Statement

Today an admin who wants "my research agent may read the public web but not act on it, and my finance agent gets no web at all" has no way to say it:

1. **No vocabulary.** "The web" isn't a target. `Target::Network { host_pattern: "*" }` matches _everything_ — including Anthropic and every connected app — so "block web" naively means "break the agent." Correctly excluding LLM + managed hosts requires the admin to enumerate them and keep the list current forever. [Verified — target semantics in `types.rs`/`evaluate.rs`]
2. **Deny-default can't reach the web.** The one posture switch that exists (Default Rule → Block) is explicitly carved to credentialed non-LLM traffic; an agent under a Block default **still reaches any uncredentialed public host** (`evaluate.rs:183-184`, `forward.rs:432-434` "raw/unknown hosts … structurally never blocked"). This is the exact gap #372 reported from production (nanoclaw), with a second user asking for it. [Verified]
3. **No per-agent web intent surface.** Grants scope _credentials_ per agent; nothing scopes _browsing_. Expressing "read-only web" (GET/HEAD allowed, writes need approval) as hand-authored rules is possible in principle but requires the admin to understand first-match ordering, method semantics, and the carve — ~5+ rules per agent with no guardrails.
4. **Web implies internal network.** Nothing distinguishes `sec.gov` from `169.254.169.254` or `10.x.x.x`. Any agent with web reach can be prompt-injected into an SSRF probe of the gateway's network. No private-IP filtering exists anywhere in the gateway. [Verified — fact 16]

---

## Why This Contribution Matters

OneCLI's stated thesis is "keep authority outside the model and enforce it at the gateway" (README, YC page). Web browsing is the largest capability an agent has that the gateway currently cannot reason about as a category. This contribution: closes a user-reported gap with demonstrated demand (#372 + comment, #479, #506); composes with, rather than competes against, the month-old PolicyRuleV2 investment (it is the engine's fourth generated-rule `source`, its fifth target kind); and turns a latent SSRF exposure into an enforced boundary. For the ecosystem, orchestrators like nanoclaw (the #372 author) get a provisioning-time API for exactly the lockdown they asked for.

---

## Should This Be Built?

**Conclusion: Recommended with changes.** (Changes relative to the original conversation: no carve modification; generated-explicit-rules design; mandatory Phase 0 engagement with #372; private-network hardening elevated from "nice second PR" to a scoped, explicit phase with its own maintainer question.)

Evidence for building it:

- The problem is real and user-reported, twice, with a working prior prototype (#372) that the v2 migration orphaned. Not building it leaves the project's flagship posture switch (deny-by-default) unable to touch the open internet.
- No duplication: nothing in the repo or open PRs covers it (fact 23). The nearest mechanisms (Network targets, app availability, blocklist source) each solve a different problem.
- Architectural fit is unusually good: a fifth `Target` variant + a sixth `source` value + the existing materialization pattern. Smallest-coherent-change is genuinely small (PR 1 touches ~6 files plus tests).
- Maintenance cost is bounded: the corpus-driven parity discipline means the behavior is pinned by shared golden tests, and generated rules ride existing publish/rollback/audit machinery.

Why not plain **Recommended**: two decisions materially shape the implementation and belong to maintainers — (a) whether the per-agent surface is OSS or `ee/` (adjacent surfaces split both ways today: agent-identity rules are OSS, group identities and app availability are ee), and (b) where generated rules sit relative to admin-authored custom rules in first-match order. Both are cheap to ask and expensive to guess. `CONTRIBUTING.md` requires an issue-first discussion for features anyway (fact 22).

Why not **Not recommended**: every objection I could construct is answered by the research — "use Network rules" fails on the enumeration problem; "wait for maintainers" ignores that they've had #372 for two months while two users wait; "too big" is answered by the layered plan whose first PR is independently useful.

---

## Goals

- G1: Admins can express allow/block/approve/rate-limit for _public-web traffic as a class_, per agent, without breaking LLM or managed-app traffic.
- G2: Five curated profiles cover the common postures with one selection; the escape hatch (custom rules) remains fully available.
- G3: Zero change to the semantics of any existing rule, target, default, or the deny-default carve.
- G4: Request-path performance model unchanged: no DB access per request; classification computed from fields already on `PolicyRequest`.
- G5: Enforcement parity across HTTP forward, MITM'd HTTPS, and WebSocket upgrade paths, proven by tests.
- G6: Private-network destinations are distinguishable from the public web and blocked by default for agent traffic (Phase-gated; see Q4).
- G7: Rust and TypeScript engines agree, proven by shared-corpus cases for every new behavior.

## Non-Goals

- Building a web-search feature, browser, or content proxy — search arrives via ordinary app connectors (Tavily #479 / Serply PR), which classify as _Managed_, not Web.
- Content inspection/filtering (categories, DLP, response scanning).
- Changing default posture for existing deployments — all new behavior is opt-in per agent.
- Per-URL response caching, logging pipelines, or analytics beyond the existing telemetry decisions.
- Replacing or generalizing the profiles into a rules DSL — profiles compile to rules; the DSL _is_ PolicyRuleV2.
- DNS-layer enforcement (the gateway enforces at HTTP/CONNECT; DNS egress from sandboxes is already constrained by the `internal` network).

---

## Target Users & Developer Workflows

- **Org/workspace admins** (dashboard): open an agent → Web Access → pick a profile, optionally edit domains/limits → publish. Review "recent decisions" to tune.
- **Orchestrator developers** (nanoclaw-class, the #372 persona): at provisioning time, `PUT /v1/agents/:id/web-access {"mode":"no_web"}` per agent; later widen selectively. Idempotent — safe to re-apply on every reconcile.
- **Agent operators/employees**: unchanged workflow; blocked web requests return the gateway's structured policy refusal; approval-mode requests pause for the existing human-approval flow.
- **Maintainers**: one more `source` in the materializer, one more target kind in the corpus — reviewable in the same mental model as `equipment`.

## User Stories

- As a **workspace admin**, I set my finance agent to _No Web_ so that no prompt injection can exfiltrate data to an attacker's site, while its accounting connection and LLM keep working.
- As an **admin**, I set a research agent to _Research_ so it can GET/HEAD any public page (rate-limited) but any POST/PUT/PATCH/DELETE to the web pauses for my approval.
- As an **orchestrator developer**, I provision 200 agents locked to _No Web_ by default and open specific ones to _Restricted_ with an explicit domain list, via the management API, idempotently.
- As an **admin**, when an agent hits an unknown domain under _Restricted_, I receive the existing approval prompt naming agent/host/method and approve or deny from chat. (Failure story:) When I deny, the agent receives the structured 403 policy response, not an opaque proxy error.
- As a **security engineer**, I rely on the gateway refusing `169.254.169.254`, `10.0.0.0/8`, and loopback for agent traffic regardless of profile, unless explicitly allowed.

---

## Product Requirements

### Functional

- **FR-001** A published rule with target kind `web` matches a request iff the request classifies as PublicWeb: `!is_llm_host && !has_injections`. It never matches LLM-host or credential-injected requests.
- **FR-002** `web` targets support optional `host_pattern` (same wildcard semantics as `Network`, via `connect::host_matches`), optional `path_pattern`, optional `method`; all-empty means "all public-web traffic."
- **FR-003** `web` rules participate in first-match evaluation, identities (including `Agent`), scopes, `require_approval`, and `rate_limit` exactly as other explicit rules; block is unconditional (no carve interaction).
- **FR-004** `GET /v1/agents/:agentId/web-access` returns the agent's mode, parameters, and the effective compiled summary; `PUT` accepts `{mode, allowDomains?, unknownDomains?, allowedMethods?, rateLimit?}` and reconciles generated rules idempotently (deterministic `logicalId`s, `source="web_access"`), then publishes via the existing per-scope publish path.
- **FR-005** Modes compile as (workspace scope, identity = the agent, priority band per Q2):
  - `no_web` → `block web/*`
  - `search_only` → `block web/*` (search reaches agents as Managed app traffic; the API validates that at least one search-provider connection is granted, else warns)
  - `research` → `allow web method=GET`, `allow web method=HEAD` (+ optional rate limit), `allow+approval web/*` **or** `block web/*` for writes per `unknownDomains`-analog setting, terminal `block web/*`
  - `restricted` → `allow web host∈allowDomains`, then `allow+approval web/*` or `block web/*` per `unknownDomains`
  - `open` → `allow web/*` (or rule-set absent = inherit; exact choice per Q2)
- **FR-006** Deleting/clearing the mode removes all `source="web_access"` rules for that agent and republishes.
- **FR-007** Generated rules are read-only in the generic rule editor (matching how bridged sources are treated — `policy-service.ts:45-47`) and visibly labeled `[web-access]`.
- **FR-008** WebSocket upgrades to PublicWeb destinations are evaluated under the same rules (upgrade = GET; a `research` write-block does not block upgrades, but `no_web` does).
- **FR-009** A 3xx from an allowed host is returned to the client un-followed (existing behavior); a subsequent request to the redirect target is evaluated independently — pinned by a regression test.
- **FR-010** (Phase 4, gated on Q4) Requests resolving to loopback, RFC1918, link-local (incl. `169.254.169.254`), CGNAT, ULA/IPv6-link-local ranges classify as PrivateNetwork, never PublicWeb, and are blocked for agent traffic unless explicitly allowed; classification uses the resolved IP at connect/forward time, not the hostname string.
- **FR-011** Blocked/approval decisions surface through the existing structured policy responses and telemetry decisions (no new response contract).

### Non-Functional

- **NFR-001 Performance:** classification adds only boolean logic over fields already resolved at CONNECT; zero additional DB or network calls on the request path (preserves fact 11).
- **NFR-002 Compatibility:** with no `web` rules present, every corpus case and gateway behavior is byte-identical. Older gateways reading a newer DB must fail safe on the unknown target kind (assembler skips-with-log or refuses to load the generation — decide with maintainers; skip-with-log matches the fail-closed catalog precedent [Inference]).
- **NFR-003 Parity:** every FR has at least one shared-corpus case executed by both engines.
- **NFR-004 Determinism/idempotency:** repeated identical `PUT`s produce no new generations beyond the first (diff-before-publish).
- **NFR-005 Observability:** decisions reuse `RequestDecision` telemetry; generated-rule names are stable and greppable (`[web-access] <agent>: …`).
- **NFR-006 Security:** no secret material in web-access API payloads or generated rule names; approval prompts show host/method/path only (existing contract).

### Acceptance Criteria (pass/fail)

1. Corpus: new `web`-target cases pass in both `corpus_test.rs` and `policy-translation.test.ts`; all pre-existing cases unchanged.
2. E2E (gateway-e2e): the §Test-Matrix scenarios all hold, including LLM/managed traffic surviving `no_web`.
3. `PUT` → `GET` round-trips; double-`PUT` creates exactly one new generation; clearing removes all generated rows.
4. Redirect regression test passes.
5. `pnpm check` + Rust build/tests + existing suites green; CLA signed; PRs reference the design issue.

---

## Proposed UX / CLI Interface

### API (Hono, `packages/api/src/routes/` — follows `agents.ts`/`grants.ts` conventions)

```http
GET /v1/agents/:agentId/web-access
PUT /v1/agents/:agentId/web-access
DELETE /v1/agents/:agentId/web-access
```

```json
PUT body
{
  "mode": "restricted",
  "allowDomains": ["*.sec.gov", "*.reuters.com", "github.com"],
  "unknownDomains": "ask",            // "ask" | "block"
  "allowedMethods": ["GET", "HEAD"],  // research/restricted refinement
  "rateLimit": { "requests": 500, "window": "hour" }
}
```

```json
200 response (GET/PUT)
{
  "mode": "restricted",
  "allowDomains": ["*.sec.gov", "*.reuters.com", "github.com"],
  "unknownDomains": "ask",
  "rateLimit": { "requests": 500, "window": "hour" },
  "effectivePolicy": { "read": "allow-listed", "write": "ask", "unknownDomain": "ask" },
  "generatedRules": 4,
  "publishedGeneration": 17
}
```

Naming rationale: `web-access` mirrors the kebab-case sub-resource style (`agent-crons`, `agent-memories`); field names mirror existing rule vocabulary (`rateLimitWindow` values `minute|hour|day`).

### Dashboard (agent page → "Web Access" tab)

Mode radio (No web / Search only / Research / Restricted / Open) → conditional sections: domain chip editor (Restricted), unknown-domain behavior (Block / Ask for approval), method toggles + rate limit (Research). A read-only "compiled rules" preview reusing `policy-rules-table` rendering, and the agent's recent web decisions from existing telemetry. Errors surface the API's structured validation messages (bad wildcard, empty domain list under Restricted, missing search connection under Search only).

### CLI (`onecli-cli`, separate repo — follow-up, out of scope for these PRs)

`onecli agents web-access get|set --id X --mode research …` noted in the design issue so the CLI repo can track it; not part of this contribution's four PRs.

---

## Technical Design

### PR 1 — the `web` policy primitive

**Rust** (`apps/gateway/src/policy_engine/`):

```rust
// types.rs — new variant
Target::Web {
    host_pattern: Option<String>,   // None = any public-web host
    path_pattern: Option<String>,
    method: Option<String>,
}
```

```rust
// evaluate.rs — target_matches arm
Target::Web { host_pattern, path_pattern, method } => {
    request.is_public_web()                                  // !is_llm_host && !has_injections
        && host_pattern.as_deref().map_or(true, |p| crate::connect::host_matches(&request.host, p))
        && matches_request(&pseudo_rule(path_pattern.as_deref(), method.clone(), &rule.conditions),
                           &request.method, &request.path, body)
}
```

`PolicyRequest::is_public_web()` is a one-line method beside `enforce_deny()` so the classification is defined once and documented once. `assemble.rs` learns to build the variant from a `kind="web"` row (reusing the `hostPattern/pathPattern/method` columns); unknown-kind handling per NFR-002.

**TypeScript twin:** `packages/api/src/services/policy-translation/` — extend the target union (`{kind:"web"; hostPattern: string|null; pathPattern: string|null; method: string|null}`), the evaluator's `case "web"`, `policy-target`/`validations/policy.ts` schemas, and the simulator's rule loader. Add corpus cases (see §Testing).

**Schema:** widen the `kind` comment in `schema.prisma`; **no migration** (verified — columns exist, `kind` is `String`).

Control/data flow, storage, lifecycle, caching: unchanged — a `web` row is loaded, cached, and evaluated exactly like a `network` row.

### PR 2 — profiles API + compiler

`packages/api/src/services/web-access-service.ts`:

```
readWebAccess(agentId)  → decode generated rules back to {mode, params} (rules are the source of truth; no new table)
writeWebAccess(agentId, input)
   validate → compileWebAccessPolicy(input, agent) → desired MaterializedRule[]
   (source:"web_access", logicalId: `web-access:${agentId}:${slot}`)
   diff against current source="web_access" rows for this agent
   apply via policy-service mutation + per-scope publish serialization
```

This is deliberately the `app_permission`/`equipment` materialization pattern (`policy-service.ts:1232-1320`) with a sixth `source` value; the `source` union type widens in one place. Decoding-from-rules avoids a parallel store and cannot drift from what's enforced; if maintainers prefer a small `AgentWebAccess` intent row for round-trip fidelity, the compiler is unchanged — flagged as a minor design alternative, not a fork in the road.

Route file `packages/api/src/routes/web-access.ts`, registered in `app.ts` beside `agentGrantsRoutes`; auth middleware and error envelope copied from `agents.ts` conventions.

### PR 3 — dashboard UI

`apps/web/src/app/(dashboard)/…/agents/[agentId]/web-access/` page + components; reuse `lib/policy-editor/policy-rules-table` for the compiled preview and existing form primitives (`packages/ui`). Client API helpers follow `ee/app-availability/api.ts` shape (`apiGet`/`apiPut`). Placement (OSS `lib/` vs `ee/`) per Q1.

### PR 4 — private-network isolation (gated on Q4)

Add `TrafficClass::PrivateNetwork` determined from the **resolved socket address** in the gateway's connect/forward path (the gateway already performs resolution — cf. #424's AAAA handling): loopback, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` (metadata IP included), `100.64/10`, `::1`, `fc00::/7`, `fe80::/10`. Default: block for authenticated agent traffic with a structured refusal; explicit `network` allow rules for named private hosts override (existing semantics). Resolving on the IP (not hostname) closes DNS-rebinding of the classification; MITM re-resolution per request keeps it honest. This is a behavior change for any deployment currently proxying agents to internal services — hence maintainer-gated and possibly config-flagged for one release.

### Error Model

| Failure                                                           | Surface                                                                                   |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Invalid mode / wildcard / empty `allowDomains` under `restricted` | 400 with field-level message (Hono validation, mirrors `validations/policy.ts` style)     |
| Unknown agent / wrong workspace                                   | existing 404/403 envelope from agent routes                                               |
| `search_only` with no granted search connection                   | 200 + `warnings[]` (policy still applied; agent will simply have no search until granted) |
| Publish conflict (concurrent generation)                          | existing per-scope publish serialization; retry-safe 409                                  |
| Gateway meets unknown target kind (version skew)                  | per NFR-002: skip-with-log (fail-closed for that rule) — decided in Phase 0               |
| Blocked request at gateway                                        | existing structured block/approval/rate responses + telemetry decisions; no new contract  |

### Edge Cases

- Uncredentialed traffic to a _known app host_ (e.g., browsing `github.com` with no GitHub grant): classifies PublicWeb (`has_injections=false`) → governed by web rules. [Recommendation: correct — browsing GitHub *is* web browsing; grants make it Managed. Confirm as Q3.]
- Secret-served and vault-served hosts: `has_injections=true` → Managed, untouched by `no_web`. Vault fallback runs only when `!intercept` (`gateway.rs:850-866`); since web rules require no injection resolution, ordering is unaffected.
- Host with an injected credential but a web rule naming it: web rule can't match (Managed) — the admin's tool for that host is `network`/`connection` targets; document this.
- Ports: match on the port-stripped `policy_host` like other targets (`forward.rs:435-437`).
- CONNECT-only knowledge: since every agent session is MITM'd (fact 12), method/path are always available post-handshake; the CONNECT itself is tunneled and per-request evaluation happens inside — `no_web` blocks at first request. [Inference from mitm flow; verify in Phase 1 whether an early CONNECT-time refusal for `no_web` is worth adding as an optimization, as #372 prototyped.]
- WebSocket to web under `research`: upgrade is GET → allowed. If maintainers want WS blockable independently, that's a later `web` refinement (non-goal now; note in design issue).
- Redirects: FR-009 test pins the two-step evaluation.
- Wildcard semantics: reuse `connect::host_matches` verbatim so `*.sec.gov` means what it means everywhere else.

---

## Repository Impact Map

| Area/File                                                                         | Existing Responsibility          | Proposed Change                                                | Why                 |
| --------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------- | ------------------- |
| `apps/gateway/src/policy_engine/types.rs`                                         | Rule/target/request types, carve | add `Target::Web`, `is_public_web()`                           | PR 1 core           |
| `apps/gateway/src/policy_engine/evaluate.rs`                                      | first-match evaluation           | `Web` match arm                                                | PR 1                |
| `apps/gateway/src/policy_engine/assemble.rs`                                      | rows → rules                     | decode `kind="web"`; unknown-kind policy                       | PR 1                |
| `apps/gateway/src/policy_engine/corpus_test.rs`                                   | shared-corpus runner             | new cases exercised                                            | PR 1                |
| `packages/api/src/services/policy-translation/**`                                 | TS twin + corpus                 | target union, evaluator case, corpus cases                     | PR 1                |
| `packages/api/src/services/policy-simulate/**`                                    | simulator                        | load/simulate `web` targets                                    | PR 1                |
| `packages/api/src/validations/policy.ts`                                          | API schemas                      | accept kind `web`                                              | PR 1                |
| `packages/db/prisma/schema.prisma`                                                | models                           | comment-only widen of `kind`/`source`                          | PR 1 (no migration) |
| `packages/api/src/services/web-access-service.ts` **(proposed)**                  | —                                | compiler + reconciler                                          | PR 2                |
| `packages/api/src/routes/web-access.ts` **(proposed)**, `app.ts`                  | route registry                   | new sub-resource                                               | PR 2                |
| `packages/api/src/services/policy-service.ts`                                     | rule CRUD/publish/materialize    | widen `source` union; read-only treatment of `web_access` rows | PR 2                |
| `apps/web/src/app/(dashboard)/…/web-access/**` **(proposed)** + `lib/` components | agent pages, policy editor       | Web Access tab                                                 | PR 3                |
| `apps/gateway/src/connect.rs` / `forward.rs` / `gateway.rs`                       | resolve/forward                  | PrivateNetwork classification on resolved IPs                  | PR 4                |
| `apps/gateway-e2e/**`, `apps/hosted-e2e/**`                                       | e2e                              | matrix scenarios                                               | PRs 1–4             |
| `docs/`                                                                           | operator docs                    | new `web-access.md` (see §Documentation)                       | PR 3                |

---

## Alternatives Considered

**A. Generated explicit `Target::Web` rules (chosen).** Smallest change; zero carve interaction; inherits publish/rollback/parity/caching; per-agent via existing identities. Cost: one more target kind forever; profile intent reconstructed from rules (or a tiny intent row).

**B. #372's original design: per-agent `policyMode` + modified `enforce_deny` + CONNECT-time host gate.** Now architecturally regressive: it adds a second posture mechanism beside Default Rules, changes carve semantics for everyone (needs a migration pinning existing orgs), and bypasses the first-match engine for its gate. Its one advantage (refusing at CONNECT before any bytes) is capturable later as an optimization inside design A. Rejected, with credit — its diagnosis drives this proposal.

**C. Pure `Network` wildcard rules + curated "known managed hosts" exclusion list.** No engine change, but the exclusion list is unbounded and rots (every new connector, every LLM host) — precisely the enumeration problem; also can't distinguish "GitHub with grant" from "GitHub without." Rejected.

**D. Enforce in the sandbox/runner (network namespaces, nftables).** Wrong layer: duplicates policy in a second enforcement plane, loses method/path/approval semantics, and contradicts the project's gateway-central thesis. Rejected.

**E. New `AgentWebPolicy` tables + separate runtime check in the gateway.** The "parallel policy engine" the conversation warned against: second evaluation order, second cache, second audit trail. Rejected; at most a thin _intent_ row under design A if maintainers want it.

---

## Security Considerations

- **SSRF / private-network reach** — the headline risk this feature must not worsen and Phase 4 fixes: today nothing stops an allowed-web agent from requesting `http://169.254.169.254/…` (fact 16). Classification must key on resolved IPs (DNS-rebinding), including on every re-resolution.
- **Redirect laundering** — structurally prevented (`redirect::Policy::none()`); FR-009 regression test makes it a maintained invariant.
- **Policy bypass via version skew** — unknown target kinds must fail closed (NFR-002), matching the engine's existing fail-closed instincts (catalog-less providers match nothing).
- **Approval-prompt integrity** — prompts must show gateway-observed host/method/path, never agent-supplied strings; reuse the existing approval payload untouched.
- **Injection of rule content** — domain patterns are data (validated wildcards), never interpolated into queries (Prisma) or regexes without escaping; `host_matches` reuse avoids a second parser.
- **Secrets** — no credential material flows through the web-access API or generated rule names (NFR-006).
- Not applicable here (briefly): shell execution, temp files, filesystem traversal, deserialization of untrusted formats — the feature adds none of these surfaces.

## Performance and Reliability

Request-path delta is two boolean tests and a host-glob per candidate `web` rule — same cost class as `network` rules; no new I/O, allocation-light (NFR-001). CONNECT-time cost: a handful more cached rows per agent. Rate limiting reuses the `logicalId`-keyed counters (survives republish — verified schema comment). Idempotent `PUT` (diff-before-publish) keeps generation churn at zero for reconciling orchestrators. Failure modes inherit the engine's: a rule that fails to assemble is skipped fail-closed with a log, never a panic on the hot path.

## Backwards Compatibility

No existing command, output, config, API, or stored-state change. Absent `web` rules, evaluation is bit-identical (corpus proves it). Additive API route; additive UI tab. The one deliberate behavior change is Phase 4's private-network default-block — explicitly maintainer-gated, and if accepted, shipped behind a release-noted flag with the migration story "explicitly allow the internal hosts you use." Version skew handled per NFR-002. Existing deployments that never touch the feature observe nothing.

---

## Implementation Plan

**Phase 0 — Maintainer alignment (blocking).** Post the design as a comment on #372 (or a new issue linking it): the `Target::Web` classification, generated-rules compilation, and the four PRs; credit #372's diagnosis; ask Q1–Q5. Exit: a maintainer 👍 on the approach and answers to Q1–Q2 (Q3–Q5 can trail). CLA reviewed.

**Phase 1 — Foundation (PR 1: `feat(policy): public-web target for PolicyRuleV2`).** Rust variant + match arm + assembler; TS union + evaluator + validations + simulator; 8–12 shared corpus cases; unknown-kind handling. Exit: both engines green on the corpus; no behavior change without `web` rows.

**Phase 2 — Core behavior (PR 2: `feat(api): per-agent web-access profiles`).** Compiler, reconciler, routes, `source` widening, read-only treatment, service tests (compile goldens per mode, idempotency, clear/delete), route tests. Exit: FR-004…007, AC-3.

**Phase 3 — User integration (PR 3: `feat(web): agent Web Access controls`).** Tab, forms, compiled-rules preview, decisions list. Exit: dashboard round-trip against a live stack.

**Phase 4 — Hardening (PR 4: `feat(gateway): isolate private-network egress`, gated on Q4).** Resolved-IP classification, default block, structured refusal, e2e for loopback/RFC1918/metadata/rebinding. Exit: FR-010.

**Phase 5 — Tests** are embedded per-PR above (the project's corpus discipline makes trailing test phases wrong here); this phase is the cross-PR e2e matrix in `gateway-e2e`/`hosted-e2e`.

**Phase 6 — Documentation** per §Documentation Plan, landing with PRs 2–3.

**Phase 7 — Release readiness.** `pnpm check`, full Rust + TS suites, changelog entries (release-please style per existing CHANGELOG), skew test old-gateway/new-DB, final design-issue summary.

---

## Testing Strategy

Behavioral, corpus-first; mocks avoided where the simulator and e2e stacks give deterministic real paths.

| Test                  | Level            | Scenario                                                                  | Expected                                   | Why                   |
| --------------------- | ---------------- | ------------------------------------------------------------------------- | ------------------------------------------ | --------------------- |
| web-block-basic       | corpus (Rust+TS) | agent rule `block web/*`; request to `random.com`, no injections, non-LLM | Block                                      | FR-001 core           |
| web-llm-immune        | corpus           | same rules; `is_llm_host=true`                                            | Allow (default law)                        | G1/G3                 |
| web-managed-immune    | corpus           | same; `has_injections=true` (Gmail)                                       | Allow                                      | G1                    |
| web-method-split      | corpus           | `allow web GET`, `block web/*`; GET vs POST `random.com`                  | Allow / Block                              | FR-002/005 research   |
| web-approval          | corpus           | `allow+approval web/*`; POST unknown host                                 | ManualApproval                             | FR-005 restricted-ask |
| web-ratelimit         | corpus           | `allow web GET rate=2/min`; 3rd GET                                       | RateLimit                                  | FR-003                |
| web-host-narrow       | corpus           | `allow web host=*.sec.gov`, `block web/*`                                 | sec.gov Allow; other Block                 | FR-002                |
| web-vs-network-order  | corpus           | earlier `network allow random.com` + later `block web/*`                  | Allow (first-match)                        | ordering sanity       |
| default-law-untouched | corpus           | all pre-existing cases                                                    | unchanged                                  | NFR-002/G3            |
| agent-scoping         | corpus           | web rules identity=agent-A; request agent-B                               | no match                                   | per-agent             |
| compile-goldens       | unit (TS)        | each mode → exact rule set, stable logicalIds                             | golden match                               | FR-005                |
| put-idempotent        | integration (pg) | double PUT                                                                | one new generation                         | NFR-004               |
| clear-removes         | integration      | DELETE                                                                    | zero `web_access` rows, republished        | FR-006                |
| e2e-no-web            | e2e              | agent no_web: curl LLM, Gmail, random.com                                 | 200, 200, structured 403                   | AC-2                  |
| e2e-research-post     | e2e              | research: GET ok, POST → approval pause; approve/deny both paths          | per decision                               | approvals wiring      |
| e2e-websocket         | e2e              | no_web: WS upgrade to public host                                         | refused                                    | FR-008                |
| e2e-redirect          | e2e              | allowed.com 302→forbidden.com; client follows                             | 302 delivered; second request blocked      | FR-009                |
| e2e-private-net (PR4) | e2e              | GET 127.0.0.1 / 10.x / 169.254.169.254; rebinding host                    | blocked                                    | FR-010                |
| e2e-skew              | e2e              | old gateway binary, DB containing `web` rows                              | rule skipped fail-closed, logged; no crash | NFR-002               |
| route-validation      | unit             | bad mode, bad wildcard, empty restricted list                             | 400s with field errors                     | error model           |

Regression anchors: the entire existing corpus, gateway e2e suite, and `policy-service` tests must pass unmodified. Platform tests: server-side feature; Linux CI suffices (no client-platform surface).

---

## Documentation Plan

- `docs/web-access.md` **(proposed)**: concepts (traffic classes), modes table, API reference with the JSON above, compiled-rules explanation, private-network defaults (post-PR4), troubleshooting ("my agent can't reach X" → decisions list → grants vs web).
- `docs/self-hosting.md`: one paragraph + link (private-network flag if PR 4 lands flagged).
- Dashboard empty-state copy in the Web Access tab (doubles as discoverability).
- CHANGELOG entries via the existing release-please conventional commits (`feat(policy): …` etc. — matches current history).
- Design issue kept updated as the canonical rationale record; CLI-repo follow-up issue filed after PR 2.

---

## Open-Source Contribution Strategy

**Issue-first (required by CONTRIBUTING.md), on #372's thread** — it is the living demand signal; a fresh issue that links and supersedes it is acceptable if maintainers prefer, but silence toward its author would be both rude and strategically wasteful (they operate nanoclaw and are the natural first production user and co-reviewer).

**Smallest useful PR:** PR 1 exactly as scoped — even alone it lets a sophisticated admin hand-author "block the public web for agent X" today, which is impossible now.

**Split:** PR 1 foundation → PR 2 profiles API → PR 3 UI → PR 4 hardening. Genuine review advantage: PR 1 is pure-engine and corpus-provable; PR 2 is pure-TS service; PR 3 is UI; PR 4 is a security behavior change deserving isolated scrutiny. No PR depends on an unmerged sibling except linearly.

**Maintainer questions (Phase 0):**

- **Q1** Is the per-agent Web Access surface (API+UI) OSS or `ee/`? (Engine target must be OSS either way — corpus parity lives in OSS.)
- **Q2** Where do generated `web_access` rules sit in first-match order relative to admin-authored custom rules — after custom (custom wins) or in a fenced band? And should `open` compile to an explicit allow or to absence?
- **Q3** Confirm: uncredentialed traffic to known-app hosts classifies as web (design §Edge Cases).
- **Q4** Appetite and rollout shape for private-network default-block (flagged release? cloud-first?).
- **Q5** Version-skew posture for unknown target kinds: skip-with-log or refuse-generation?

**Draft PR description skeleton (PR 1):** Problem (link issue; the enumeration gap + carve quote) · Solution (`Target::Web`, classification `!is_llm_host && !has_injections`) · Motivation (#372 demand, profiles to follow) · Implementation (files above; no migration; no behavior without `web` rows) · Testing (corpus cases listed; skew handling) · Compatibility (byte-identical absent web rules) · Limitations (profiles/UI/private-net in follow-ups, linked).

---

## Risks

- **Maintainer bandwidth/roadmap** — #372 unanswered for two months; a YC-backed team may have internal plans. Mitigation: Phase 0 is cheap; PR 1 is small enough to review in one sitting; Discord ping if the issue stalls.
- **Repo velocity** — weekly releases; the policy code is one month old and actively touched. Mitigation: small PRs, fast rebases, corpus as the stability contract.
- **`ee/` placement surprise** (Q1) could move PR 2–3 code under the enterprise license — acceptable, but changes file paths; ask first.
- **Search-only depends on connectors** — Tavily not yet merged; profile ships with the granted-connection warning rather than blocking on connector work.
- **Private-net default-block** is the only true behavior change; if maintainers decline, PRs 1–3 stand alone and PR 4 becomes an opt-in rule pack.

## Open Questions / Research Gaps

| Unknown                                                                                      | Why it matters                    | How to verify                                                                                    | Blocks start?                     |
| -------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------- |
| Q1–Q5 above                                                                                  | shape PR 2–4                      | Phase 0 issue                                                                                    | Q1–Q2 block PR 2; none block PR 1 |
| Whether CONNECT-time early refusal (pre-first-request) is wanted for `no_web`                | latency/UX nicety #372 prototyped | ask in Phase 0; read `mitm.rs` handshake path deeper                                             | No                                |
| Exact resolver hook for PR 4 IP classification (where AAAA/A results are available pre-dial) | correctness of SSRF fix           | trace `forward.rs`/`connect.rs` dial path (started; #424 confirms resolution happens in-gateway) | Blocks PR 4 only                  |
| Cloud-vs-onprem edition seams for the new route (edition slots pattern)                      | PR 2 wiring                       | read `edition-state.ts` consumers                                                                | No — copy `agent-crons` wiring    |
| Maintainers' internal roadmap for web browsing/search                                        | duplicate-work risk               | Phase 0 / Discord                                                                                | No                                |

## Definition of Done

All acceptance criteria met; four PRs merged (or 1–3 merged and 4 explicitly deferred by maintainers); docs live; design issue closed with a summary; #372 closed as superseded with credit; no regression in any pre-existing corpus case or e2e suite; feature reconstructable from docs by an admin who has never read this document.

## Development Checklist

**Before coding:** ☐ Phase-0 comment posted on #372 ☐ Q1–Q2 answered ☐ CLA understood ☐ fork synced to upstream `main` (it is currently ~90 files behind) ☐ local stack runs (`pnpm dev`, Rust gateway builds)
**Implementation:** ☐ `Target::Web` + `is_public_web()` ☐ assembler + skew handling per Q5 ☐ TS union/evaluator/validations/simulator ☐ corpus cases (both runners) ☐ compiler + reconciler + routes ☐ `source` union widened ☐ UI tab
**Tests:** ☐ full matrix rows implemented at stated levels ☐ existing corpus untouched and green ☐ e2e no-web/research/websocket/redirect
**Docs:** ☐ `docs/web-access.md` ☐ self-hosting note ☐ conventional-commit messages
**Local verification:** ☐ `pnpm check` ☐ `cargo test` (gateway) ☐ gateway-e2e ☐ double-PUT generation count = +1
**Before PR:** ☐ diff contains no unrelated changes ☐ PR description per skeleton ☐ linked issue ☐ screenshots for PR 3
**Review/merge:** ☐ respond within a day (velocity) ☐ rebase promptly ☐ after PR 2, file the CLI-repo follow-up issue

## Recommended Next Action

**Post the Phase-0 design comment on issue #372 today.** It should: (1) credit the original diagnosis and note the v2 migration invalidated its implementation but not its problem; (2) present the `Target::Web` + generated-rules design in ~30 lines, leading with the "explicit blocks are unconditional" insight that removes the carve change; (3) ask Q1 and Q2 explicitly; (4) offer PR 1 within a week of a nod. In parallel — since it is additive, corpus-proven, and useful standalone — begin PR 1 on the synced fork so a prototype diff can accompany the discussion if maintainers engage quickly. Do not start PR 2 until Q1–Q2 are answered.

## Sources / References

- Repository: `github.com/onecli/onecli` @ `044ac73` (v2.2.3, 2026-08-25) — all file:line citations above from a direct clone.
- Issue #372 (per-agent network allow lists, deweysasser, 2026-06-19; demand comment 2026-07-20) · Issue #479 (Tavily) · Issue #506 (Serply) · open PR "feat: add Serply search provider".
- `CHANGELOG.md` v1.42.0 (#436, unified first-match engine, 2026-07-23) · `CONTRIBUTING.md` (issue-first, CLA) · `LICENSE` / `LICENSE-ENTERPRISE` (ee/ boundary).
- Key code anchors: `policy_engine/{types,evaluate,assemble,corpus_test}.rs`; `gateway.rs:114,801-870`; `connect.rs:340-385`; `forward.rs:430-465`; `gateway/websocket.rs:94-128`; `runner/src/config.ts:23-25`; `packages/api/src/services/policy-service.ts:15-47,299-302,362-364,1232-1320`; `policy-translation/corpus/policy-cases.json`; `providers/hooks/new-org-policy-seeder.ts`; `packages/db/prisma/schema.prisma` (PolicyRuleV2, PolicyRuleTarget); `packages/api/src/app.ts:22-64,135`.
