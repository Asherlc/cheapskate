Cheapskate adds a model to Paseo's regular picker. The model runs on an ordered chain of models from your existing Paseo providers. If a backend hits a quota or rate limit, Cheapskate continues in the same chat and workspace using the next entry.

## Setup

Requires Paseo 0.16.1 or later. Open Settings → Plugins → Cheapskate and enter one provider/model ID per line. Each backend uses the accounts and defaults already configured for that provider. You can opt in to switching on provider overload.

## Routing and chat history

The successful backend stays active for follow-up turns. After a switch, the new backend receives your current message and a bounded excerpt of recent conversation and tool activity names. It can inspect files in the same workspace. Choose backends you are comfortable sharing that context with. Permission requests are relayed to the Cheapskate chat.

Paseo launches the backends as background agents. Cheapskate saves recent chat history and the active backend locally on the daemon so that a chat can recover after a runtime reload.
