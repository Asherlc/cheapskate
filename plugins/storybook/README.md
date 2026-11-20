# Storybook for Paseo

Have an agent start your project's Storybook, then choose a story from the agent or the Storybook panel. Annotate the canvas with Canvas Comments and add the open notes, selectors, DOM context, and replies to the owning conversation draft.

## Install

The plugin requires Paseo 0.16.2 or later on the client and daemon.

```sh
paseo plugin install git:Asherlc/paseo-plugins:plugins/storybook
```

In your Storybook project, install Canvas Comments as a dev dependency. Use Storybook 8 or later with the Vite builder.

```sh
npm install -D storybook-addon-canvas-comments
```

Add `"storybook-addon-canvas-comments"` to the existing `addons` array in `.storybook/main.ts` and restart Storybook if it is already running. Paseo reads the story index and the addon's default API at `/__canvas-comments/comments` on the same origin. This integration requires the default Vite API. Custom `apiUrl` overrides and hosted Canvas Comments APIs require a different integration. [Canvas Comments setup and controls](https://storybook.js.org/addons/storybook-addon-canvas-comments)

## Run Storybook from Paseo

Set `NODE_OPTIONS=--title=Storybook` for the launch so the Ports panel labels it **Storybook**. Append `--title=Storybook` when your command already sets other Node options.

Ask the agent in your workspace to start Storybook. It calls `storybook_start` with the project's executable and arguments. Use one `{port}` placeholder, which the plugin replaces with an available port. For an npm project whose `storybook` script runs `storybook dev`, the tool input looks like this.

```json
{
  "command": "env",
  "args": ["NODE_OPTIONS=--title=Storybook", "npm", "run", "storybook", "--", "--host", "127.0.0.1", "--port", "{port}", "--exact-port", "--ci"]
}
```

The command runs as the Paseo daemon's OS user on macOS or Linux, starting in the agent's checkout. The optional `cwd` selects a subdirectory of that checkout. Install your project's Storybook dependencies before launching. [Storybook CLI options](https://storybook.js.org/docs/api/cli-options)

The plugin keeps one server running per workspace, independently of the agent's turn and background tasks. The Storybook panel and `storybook_status` report the daemon-local URL when the story index responds. Use **Stop Storybook** in the panel or ask the agent to call `storybook_stop`. Archiving the workspace or stopping or reloading the plugin also stops the managed process.

## Connect your browser

For a managed or existing server, use a **Daemon URL** that the daemon can reach to read the index and comments. The story opens at this address by default. A loopback address such as `http://127.0.0.1:6006/` works in a browser running on the daemon machine.

From another machine, keep the daemon URL and supply a **Browser URL** that your browser can reach. Use an existing private forward, such as a Tailnet link for Storybook in **Show open ports**. You can also use SSH local forwarding from the machine running your browser. For example, `ssh -N -L 127.0.0.1:6006:127.0.0.1:64786 daemon-host` forwards the daemon's port `64786` to the browser machine's `http://127.0.0.1:6006/`. Use that as the Browser URL for that session. The plugin uses the browser address to build story links.

If a proxy serves Storybook at `https://example.com/ui/`, forward `/ui/` and its descendants to Storybook and expose `/__canvas-comments/` at the root of `https://example.com` through the same proxy so the addon can save notes from the browser.

## Review a story

1. Ask your agent to run `storybook_list_stories` with the daemon URL and an optional search query. Have it call `storybook_select_story` with `url`, the chosen `storyId`, and `browserUrl` if your browser uses a different address. Click **Open Storybook review** in the conversation. An open panel picks up the selection automatically.
2. To select a story yourself, focus the conversation and choose **Open Storybook review** in the Command Center. Enter the daemon URL and optional browser URL, list the stories, and choose one. To switch to a different browser address for the current story, enter it and select the story again.
3. Click **Open in browser** to use your default browser, or **Open in Paseo** for an embedded desktop tab. Add comments with Canvas Comments in Storybook.
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
