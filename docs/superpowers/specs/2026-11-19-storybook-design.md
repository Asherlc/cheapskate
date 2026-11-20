# Storybook feedback in Paseo

Let an agent choose a story, let the user annotate that story, and put the feedback in the conversation draft for the user to send.

The user asked for a Storybook plugin, agreed to proceed with screenshot-style feedback, then pointed out that annotation addons likely already exist. Reuse `storybook-addon-canvas-comments` for the actual annotation interface: its pins, comments, DOM snapshots, and review completion already cover the feedback requirement. Do not build another annotation editor or screenshot service.

Approaches considered: a custom screenshot editor would duplicate existing work; Paseo's built-in browser annotations work on desktop but do not supply Storybook's own review interface; Canvas Comments supplies that interface and agent-readable feedback. The lead selects the existing addon following the user's preference for minimum custom code.

Create a separate `plugins/storybook` Paseo integration. Agent tools list stories, select a story for review, and read its open feedback. Selection records the owning agent and workspace. A workspace panel opens the selected story in Paseo's existing browser and appends feedback to that owner's existing draft. Agents open the returned direct URL with Paseo's existing browser tools; no duplicate browser runtime. Story URLs always identify a particular story.

Use the current repo's TypeScript, React Native, Zod RPC, standalone package/lockfile and CI conventions. Target Paseo 0.16.2. Canvas Comments requires Storybook 8+ and Vite in the consuming project; document its installation without modifying unrelated projects. Read its existing HTTP API, retain DOM context and replies, filter resolved and other-story comments, and clearly explain missing-addon/server errors. No automatic message sending, comment deletion, reply posting, dependency downloads at runtime, marketplace submission, or new persistent service. Review targets may remain in memory and reset on plugin restart; the external addon owns durable feedback. Pin the target across asynchronous reads and draft insertion, and preserve both existing draft text and notes on error.

The Storybook manager and index can live at a subpath. The feedback API uses Canvas Comments' default same-origin root route, `/__canvas-comments/comments`. A subpath proxy exposes the Storybook subpath and the root addon routes. The integration supports the default Vite API.

Success: verified live plugin load, meaningful tests of story lookup and feedback with a local HTTP fixture, typechecks of both runtimes, package dry run, review of the actual diff, and committed/pushed work.
