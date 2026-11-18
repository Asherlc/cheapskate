# Cheapskate for Paseo

Select **Cheapskate** as your provider and model, or use `cheapskate/cheapskate` in the CLI. The chat stays on that model while Cheapskate uses your existing Paseo providers in the order you configure.

## Install and configure

Requires Paseo 0.16.1 or newer. Enable plugins in Paseo, then install the tagged release from your daemon host.

```sh
paseo plugin install git:Asherlc/cheapskate --ref v0.1.0
```

Open **Settings → Plugins → Cheapskate** on that host. Add one backend per line in `provider/model` format and save. Use `paseo provider ls` and `paseo provider models <provider>` to find the exact IDs. Keep any slash already in a model ID. For example, if the OpenCode model ID is `vendor/example`, enter `opencode/vendor/example`. The chain starts empty. Its order controls which accounts and models can be used.

## Composer controls

Cheapskate shows the primary backend's thinking levels, permission modes, and provider controls in a draft. A running chat shows the controls of its active backend. Changes apply to the next turn. If changing a setting requires a new backing session, Cheapskate passes it the recent context and continues in the same chat.

On failover, Cheapskate uses the nearest available thinking level and a known equivalent or stricter permission mode. It skips a backend whose policy cannot preserve the selected restrictions. The timeline shows the backend and settings selected for the attempt. After a plugin reload, opening a Cheapskate draft populates the catalog used by CLI commands that specify a mode.

## What happens when a model fails

Cheapskate switches on quota and rate-limit failures. You can opt in to switching on provider overload. Ordinary errors stop the turn and surface in the chat. Each backend is tried once in a turn. A successful backend handles subsequent turns until it fails or is removed from the chain. Settings changes take effect on the next turn.

When Cheapskate starts a new backend mid-conversation, it passes along the latest message (including any attachments) and a bounded excerpt of recent user and assistant text and tool names. Cheapskate masks common access tokens and private-key blocks in historical text. The latest message and its attachments are forwarded normally. The backend starts its own native session in the same workspace and can inspect edits already made there. Credentials, billing, and tool approvals follow the configured backend. Provider-specific slash commands, steering, and rewind are outside the shared model interface.

Cheapskate saves up to 300 recent timeline items and the backing agent ID in `plugin-data/cheapskate` under the daemon's Paseo home. Chat excerpts can contain sensitive information. Configure only backends that may receive that context.

## Development

```sh
npm ci
npm run typecheck
npm test
paseo plugin reload cheapskate
```
