import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Pressable, Text } from "react-native";
import { StorybookPanel } from "./client/panel";
import { reviewEntry } from "./shared/contracts";

export default function contribute(client: PluginClientContext) {
  const id = "storybook";
  const icon = "BookOpen";
  const title = "Open Storybook review";
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
    title,
    icon,
    context: "agent",
    onSelect({ openPanel }) {
      openPanel(id);
    },
  });
  const removeReviewEntry = client.addTimelineRenderer({
    ...reviewEntry,
    Component: ({ agentId, item: { data: { workspaceId } }, theme: { colors } }) => (
      <Pressable
        accessibilityRole="button"
        onPress={() => client.openPanel(id, { workspaceId, agentId })}
        style={{ alignSelf: "flex-start", backgroundColor: colors.surface2, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8 }}
      >
        <Text style={{ color: colors.foreground }}>{title}</Text>
      </Pressable>
    ),
  });
  return () => {
    removeReviewEntry();
    removeCommand();
    removePanel();
  };
}
