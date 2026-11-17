import { type PluginSurfaceProps, useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { preferences } from "../shared/settings";

type ReadySettings = Extract<ReturnType<typeof useSettings<typeof preferences.schema>>, { status: "ready" }>;

export function RoutingSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  if (settings.status === "ready") {
    return <RoutingForm key={settings.revision} theme={theme} settings={settings} />;
  }
  if (settings.status === "loading") {
    return <Text style={{ color: theme.colors.foregroundMuted }}>Loading routing settings…</Text>;
  }
  return (
    <View style={{ gap: 12, padding: 16 }}>
      <Text style={{ color: theme.colors.foreground }}>{settings.error}</Text>
      <SettingsAction label="Routing settings" actionLabel="Reload" onPress={() => void settings.reload()} />
      {settings.status === "invalid" && (
        <SettingsAction label="Clear saved settings" actionLabel="Reset" onPress={() => void settings.reset()} />
      )}
    </View>
  );
}

function RoutingForm({ settings, theme }: { settings: ReadySettings; theme: PluginSurfaceProps["theme"] }) {
  const [chain, setChain] = useState(settings.values.chain);
  const [overload, setOverload] = useState(settings.values.overload);
  const parsed = preferences.schema.safeParse({ chain, overload });
  const dirty = chain !== settings.values.chain || overload !== settings.values.overload;
  return (
    <View style={{ gap: 12, padding: 16 }}>
      <Text style={{ color: theme.colors.foregroundMuted }}>
        Enter one provider/model ID per line, in the order Cheapskate should try them.
        The next backend receives recent chat context and works in the same workspace.
      </Text>
      <TextInput
        accessibilityLabel="Fallback chain"
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        value={chain}
        onChangeText={setChain}
        placeholder="provider/model"
        placeholderTextColor={theme.colors.foregroundMuted}
        style={{
          minHeight: 120,
          borderWidth: 1,
          borderRadius: 8,
          borderColor: theme.colors.border,
          color: theme.colors.foreground,
          backgroundColor: theme.colors.surface0,
          textAlignVertical: "top",
          padding: 12,
        }}
      />
      <SettingsSwitch label="Switch on provider overload" value={overload} onValueChange={setOverload} />
      <SettingsAction
        label="Routing settings"
        actionLabel={settings.saving ? "Saving…" : "Save"}
        disabled={!dirty || !parsed.success || settings.saving}
        error={settings.saveError ?? (parsed.success ? null : parsed.error.issues[0]?.message)}
        onPress={() => {
          if (parsed.success) void settings.save(parsed.data, settings.revision);
        }}
      />
    </View>
  );
}
