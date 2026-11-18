import { useComposer, useSettings, type PluginComposerItemProps } from "@getpaseo/plugin/client";
import { Icon, Modal, SettingsAction, SettingsRow } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text } from "react-native";
import { activeRoute, activeRouteKey, handledPrimaryKey, primaryRequestKey, type RouteChange } from "../shared/route-status";
import { parseChain, preferences, providerId } from "../shared/settings";

const describeChange: Record<RouteChange["reason"], (from: string) => string> = {
  limit: (from) => `${from} hit a provider limit.`,
  unavailable: (from) => `Paseo could not read the controls for ${from}.`,
  permissions: (from) => `${from} could not preserve the selected permissions.`,
  requested: (from) => `You asked to try the first choice again after using ${from}.`,
  removed: (from) => `${from} was removed from the chain.`,
};

export function ActiveBackend(props: PluginComposerItemProps) {
  const composer = useComposer();
  return composer.context === "agent" && composer.agent.provider === providerId ? <RouteDetails {...props} /> : null;
}

function RouteDetails({ theme, layout }: PluginComposerItemProps) {
  const composer = useComposer();
  const settings = useSettings(preferences);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const { metadata } = composer.agent;
  const route = activeRoute.safeParse(metadata[activeRouteKey]).data;
  const primary = settings.status === "ready" ? parseChain(settings.values.chain)[0] : undefined;
  const request = metadata[primaryRequestKey];
  const queued = typeof request === "number" && request !== metadata[handledPrimaryKey];
  const label = route?.label ?? "Cheapskate route";

  async function tryPrimary() {
    setSaving(true);
    setError(undefined);
    try {
      await composer.setMetadata({ [primaryRequestKey]: typeof request === "number" ? request + 1 : 1 });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to queue the first choice.");
    } finally {
      setSaving(false);
    }
  }

  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => setOpen(true)}
      style={({ pressed }) => ({
        flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 8,
        minHeight: layout.compact ? 44 : 28, maxWidth: layout.compact ? undefined : 240,
        paddingHorizontal: 8, backgroundColor: theme.colors.surface2, opacity: pressed ? 0.75 : 1,
      })}>
      <Icon name="Route" size={14} color={theme.colors.foreground} />
      <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.foreground, fontSize: 12 }}>{label}</Text>
    </Pressable>
    {open && <Modal title="Cheapskate route" open onOpenChange={setOpen}>
      <Modal.Content>
        <SettingsRow label={route?.label ?? "Backend details unavailable"}
          hint={route?.change ? describeChange[route.change.reason](route.change.from)
            : route ? "Cheapskate is using this backend." : "Send a message to see the active backend."} />
        {primary && route && (route.selection !== primary || queued) && <SettingsAction
          label={`First choice · ${primary}`}
          hint={queued ? "Cheapskate will try this backend on the next message." : "Queue the first choice for the next message."}
          actionLabel={queued ? "Queued" : "Try primary again"}
          disabled={saving || queued} error={error} onPress={() => void tryPrimary()} />}
      </Modal.Content>
    </Modal>}
  </>;
}
