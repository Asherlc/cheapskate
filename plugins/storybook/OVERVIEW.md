# Storybook

Run Storybook from an agent, select a story for review, and bring Canvas Comments feedback into the conversation working on it. The Storybook panel opens the selected story, shows its open comments, and can append those comments with selectors, DOM context, and replies to the conversation draft.

Requires Paseo 0.16.2 or later. The agent supplies the project's Storybook command, which the plugin runs on the macOS or Linux daemon host. Storybook stays running when the agent goes idle. Stop it from the Storybook panel or the agent. You can also enter the URL of an existing server.

Feedback requires a reachable Storybook 8+ development server with the Vite builder and Canvas Comments enabled. The daemon reads the index and comments, and the client opens the story URL. [Canvas Comments setup](https://storybook.js.org/addons/storybook-addon-canvas-comments)

One story is selected per workspace for as long as the plugin is running. Canvas Comments stores the annotations. When you add notes to a draft, you decide when to send it. Agents can also read the selected story's open comments with the feedback tool.
