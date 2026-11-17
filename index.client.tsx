import type { PluginClientContext } from "@getpaseo/plugin/client";
import { RoutingSettings } from "./client/routing-settings";

export default function contribute(client: PluginClientContext) {
  return client.addSettingsScreen({
    id: "routing",
    title: "Cheapskate",
    icon: "Route",
    Component: RoutingSettings,
  });
}
