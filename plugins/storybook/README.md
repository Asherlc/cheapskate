# Storybook for Paseo

Choose a story from an agent or the Storybook panel in a conversation. Annotate the canvas in Storybook using Canvas Comments, then add the open notes, selectors, DOM context, and replies to the owning conversation draft.

## Install

The plugin requires Paseo 0.16.2 or later on the client and daemon.

```sh
paseo plugin install git:Asherlc/paseo-plugins:plugins/storybook
```

In your Storybook project, install Canvas Comments as a dev dependency. Use Storybook 8 or later with the Vite builder.

```sh
npm install -D storybook-addon-canvas-comments
```

Add `"storybook-addon-canvas-comments"` to the existing `addons` array in `.storybook/main.ts` and restart the Storybook development server. Paseo reads the story index and the addon's default API at `/__canvas-comments/comments` on the same origin. This integration requires the default Vite API. Custom `apiUrl` overrides and hosted Canvas Comments APIs require a different integration. [Canvas Comments setup and controls](https://storybook.js.org/addons/storybook-addon-canvas-comments)

Use a URL reachable by both your Paseo daemon, which reads the index and comments, and your Paseo client or browser, which opens the story. `localhost` refers to the machine making each request. With a remote daemon or mobile client, use a shared network address or forwarded URL reachable from both.

If a proxy serves Storybook at `https://example.com/ui/`, forward `/ui/` and its descendants to Storybook and expose `/__canvas-comments/` at the root of `https://example.com` through the same proxy. The index stays at `/ui/index.json` and story links stay under `/ui/`.

## Review a story

1. Ask your agent to run `storybook_list_stories` with the Storybook URL and an optional search query. Have it call `storybook_select_story` with the URL and the chosen story ID. The tool returns a direct link the agent can open with Paseo's browser tools.
2. To select a story yourself, focus the conversation and choose **Open Storybook review** in the Command Center. Enter the URL, list the stories, and choose one. If the agent selected a story while the panel was open, click **Refresh selection** to show it.
3. Click **Open story** to review it in the embedded browser on desktop or the system browser on other clients. Add comments with Canvas Comments in Storybook.
4. Click **Refresh feedback** and then **Add to draft**. Paseo appends the open feedback to the conversation that owns the selection. You can review and send the draft from that conversation. An agent can also call `storybook_read_feedback` to read the current workspace's open feedback directly.

The plugin keeps one review target per workspace in memory. It resets when the plugin restarts. Canvas Comments stores the annotations through the Storybook dev server. The draft workflow shares the notes with the provider when you send the draft. Calling the feedback tool directly puts its response in the agent's context.

## Development

Run these checks from `plugins/storybook`.

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm pack --dry-run --ignore-scripts
```
