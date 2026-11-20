import type { PluginClientContext } from "@getpaseo/plugin/client";
import { StorybookPanel } from "./client/panel";

export default function contribute(client: PluginClientContext) {
  const id = "storybook";
  const icon = "BookOpen";
  const removePanel = client.addAgentPanel({
    id,
    title: "Storybook",
    icon,
    Component: (props) => (
      <StorybookPanel
        key={`${props.workspaceId}:${props.params.agentId}`}
        {...props}
        client={client}
      />
    ),
  });
  const removeCommand = client.addCommandCenterItem({
    id,
    title: "Open Storybook review",
    icon,
    context: "agent",
    onSelect({ openPanel }) {
      openPanel(id);
    },
  });
  return () => {
    removeCommand();
    removePanel();
  };
}
