import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DraftControls } from "./client/draft-controls";
import { RoutingSettings } from "./client/routing-settings";
import { ActiveBackend } from "./client/active-backend";

export default function contribute(client: PluginClientContext) {
  const removeSettings = client.addSettingsScreen({
    id: "routing",
    title: "Cheapskate",
    icon: "Route",
    Component: RoutingSettings,
  });
  const removeControls = client.addComposerItem({ id: "draft-controls", Component: DraftControls });
  const removeRoute = client.addComposerItem({ id: "active-backend", Component: ActiveBackend });
  return () => {
    removeSettings();
    removeControls();
    removeRoute();
  };
}
