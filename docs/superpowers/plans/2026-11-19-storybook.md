# Storybook Integration Implementation Plan

> **For agentic workers:** Follow this bounded task in the existing isolated worktree. Do not delegate further. The lead owns final review.

**Goal:** Agents select Storybook stories and users bring Canvas Comments annotations into the owning conversation draft.

**Architecture:** Use the existing Canvas Comments Storybook addon and HTTP API. A small Paseo server contribution owns review targets and agent tools; a React Native workspace panel opens direct story URLs and appends feedback to drafts.

**Tech Stack:** TypeScript, React Native, Zod, @getpaseo/plugin 0.16.2, Node's fetch and test runner.

**Spec:** `docs/superpowers/specs/2026-11-19-storybook-design.md`

## Global constraints

- Use `rtk` for every shell command; `rtk proxy` for raw behavior.
- Keep all new runtime modules inside `plugins/storybook/client`, `server`, or `shared`, with only runtime entries at package root.
- Use Canvas Comments for annotations; no custom browser, annotation editor, daemon, MCP bridge or polling agent.
- Target Paseo 0.16.2. Inspect actual installed SDK types when docs differ.
- Agent tools use `defineAgentTool` and `server.addHook("agent.open.before")`.
- Do not alter Devices, Cheapskate, or any consuming project.
- Every Text takes theme colors; React Native primitives only; compact layout; no DOM types/globals.
- Preserve draft text, pin the owner and story, keep feedback on handoff failure; never send a prompt automatically.
- No runtime installation, marketplace submission, shared-branch merge or unrelated writes.

## Review focus

- Keep the Storybook base path in index and story URLs, including when the user pastes a manager or iframe URL. Canvas Comments uses the default `/__canvas-comments/comments` route at the root of the same origin. A subpath proxy must expose both routes.
- Missing/invalid story IDs must fail before replacing a review target.
- Missing addon, HTML responses, network failures and invalid JSON must produce actionable errors.
- Resolved and other-story comments must not leak into a story's draft; retain selector, DOM snapshot and reply context for matching open comments.
- Switching stories/chats or typing during an async read must not misroute feedback or overwrite the latest draft.
- Refreshing the workspace target must leave a listed set of stories tied to its browse URL until the user edits it.

### Task 1: Deliver the independently installable integration

Files: create `plugins/storybook/{package.json,package-lock.json,paseo-plugin.json,tsconfig.json,tsconfig.client.json,index.client.tsx,index.server.ts,README.md,OVERVIEW.md,LICENSE}`, focused `shared/contracts.ts` and `shared/feedback.ts`, `server/storybook.ts` and `server/storybook.test.ts`, and `client/panel.tsx`; update root README and add `.github/workflows/storybook.yml` for checks only. Add files only where the implementation needs them.

Interfaces: `storybook_list_stories({url,query?})` returns story IDs/titles/names/direct URLs from `index.json`; `storybook_select_story({url,storyId})` validates the story and records `{workspaceId,agentId,url,storyId,title,name,storyUrl}` then returns the direct story URL plus instruction to open it with existing Paseo browser tools; `storybook_read_feedback({})` reads current calling workspace target and returns only that story's open Canvas Comments feedback. Server RPCs expose the target, selection from the panel with an explicit current agent, and feedback retrieval. Keep targets in a simple Map keyed by workspace, no persisted custom state abstraction. Capture the owning agent from the session-open request's `labels["cheapskate.owner"]` when appropriate, otherwise `request.agentId`. The execution context's agent has no labels. Background sessions with a Cheapskate owner need the tools; other background sessions and history opens do not.

- [x] Write and run failing tests for base paths/direct URLs, story-only index filtering (exclude docs), invalid/missing story selection, and real local HTTP fixture feedback/error behavior. Cover all five review-focus cases in the appropriate server or handoff tests; do not mock fetch for the HTTP fixture.
- [x] Implement URL normalization using stock URL, index parsing for Storybook's v4/v5 `entries` and legacy `stories` indexes if straightforward, bounded HTTP fetch via stock AbortSignal timeout/cancellation, and Canvas Comments `GET /__canvas-comments/comments` (inspect upstream source for the actual response shape). Use Zod for external/RPC boundaries and preserve upstream extra feedback context. Unknown URL schemes fail. No speculative adapters for other annotation addons.
- [x] Implement the tools and RPCs using the installed SDK. Skip history/internal agent sessions; use the actual tools-append contract. Tool selection should record only after a successful lookup. Read feedback without resolving/deleting comments. Make tools discoverable without forcing a server URL globally; each list/select call receives its URL.
- [x] Implement a workspace panel and Command Center entry. Empty state takes Storybook URL, lists/searches stories and lets a user select one for the focused agent; absent focused agent explains how to select one. Selected state shows story and owning conversation, opens the direct story in the existing embedded browser (external link on unsupported clients), reads matching feedback and offers Add to draft. Use `client.composers({agentId})` freshly at insertion time so edits made during async reads survive; capture the intended target before each async operation. Handle failures with useful visible messages/toasts and retain data for retry. Refresh may be manual; do not add polling unless required for a concrete caller.
- [x] Document Canvas Comments installation/configuration in the consuming Storybook, the agent-tool workflow and native browser opening, Vite limitation, local/remote URL meaning, in-memory target lifetime, data sent to providers only when user sends the draft, and Git installation of the Paseo plugin. A package with only host modules needs no runtime dependencies or build command. Lock dev dependencies normally. Pin compatible SDK version and minimum Paseo version.
- [x] Run noninteractive `npm test`, `npm run typecheck` (server+client), `npm pack --dry-run --ignore-scripts`, audit client for DOM APIs and unstyled text; record results and any limitations. CI mirrors these checks and does not publish or submit marketplace requests.
- [x] Report changed files, tests and architectural uncertainties to the lead. Leave changes uncommitted for review; the lead commits and pushes the final result.

## Final verification

Six tests, both runtime typechecks, the 12-file package dry run, and whitespace checks passed. Installed and reloaded successfully on Paseo 0.16.2. Live RPCs against Storybook 10.6.7 and Canvas Comments 0.3.10 found two stories, retrieved a real UI-created annotation with DOM context, and preserved the existing target on invalid selection. The same checks passed through a `/ui/` proxy with the addon's API exposed at the origin root.

Final independent review found no remaining material issues after correcting the API path, browse URL binding, and pasted manager URLs. The native panel's full draft interaction was not visually verified because Paseo computer automation timed out; target pinning and draft preservation have automated coverage. No custom panel-rendering test infrastructure was introduced.
