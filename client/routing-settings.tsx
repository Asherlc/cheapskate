import { type PluginSurfaceProps, usePaseo, useSettings } from "@getpaseo/plugin/client";
import {
  FlatList, Modal, SettingsAction, SettingsCard, SettingsRow,
  SettingsSection, SettingsSelect, SettingsSwitch, TextInput,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { parseChain, preferences, providerId } from "../shared/settings";
import { formatChain, moveRow, readRows, searchModels, type CatalogModel, type ChainRow } from "./chain-picker";
import { ChainCheck } from "./chain-check";

type ReadySettings = Extract<ReturnType<typeof useSettings<typeof preferences.schema>>, { status: "ready" }>;
type Theme = PluginSurfaceProps["theme"];
type Catalog = Awaited<ReturnType<ReturnType<typeof usePaseo>["providers"]["snapshot"]>>["entries"];

export function RoutingSettings({ host, theme }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  if (settings.status === "ready") {
    return <RoutingForm key={`${host.id}:${settings.revision}`} theme={theme} settings={settings} />;
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

function useProviderCatalog() {
  const paseo = usePaseo();
  const [entries, setEntries] = useState<Catalog>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    let receivedUpdate = false;
    setError(undefined);
    const unsubscribe = paseo.providers.subscribe((snapshot) => {
      if (!active || snapshot.cwd !== undefined) return;
      receivedUpdate = true;
      setEntries(snapshot.entries);
      setError(undefined);
    });
    void paseo.providers.snapshot().then(
      (snapshot) => { if (active && !receivedUpdate) setEntries(snapshot.entries); },
      (failure: unknown) => {
        if (active && !receivedUpdate) setError(failure instanceof Error ? failure.message : "Provider catalog unavailable.");
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [paseo, attempt]);

  return { entries, error, retry: () => setAttempt((current) => current + 1) };
}

function RoutingForm({ settings, theme }: { settings: ReadySettings; theme: Theme }) {
  const [rows, setRows] = useState(() => readRows(settings.values.chain));
  const nextId = useRef(rows.length);
  const [overload, setOverload] = useState(settings.values.overload);
  const [picking, setPicking] = useState<number>();
  const { entries, error, retry } = useProviderCatalog();
  const ready = (entries ?? []).filter(({ provider, status, enabled }) =>
    provider !== providerId && status === "ready" && enabled);
  const providerOptions = ready
    .map(({ provider, label }) => ({ value: provider, label: label ?? provider }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const discovering = entries === undefined || entries.some(({ status }) => status === "loading");
  const chain = formatChain(rows);
  const parsed = chain === null ? null : preferences.schema.safeParse({ chain, overload });
  const dirty = chain !== parseChain(settings.values.chain).join("\n") || overload !== settings.values.overload;
  const saveError = settings.saveError ?? (chain === null
    ? "Choose a provider and model for every entry."
    : !parsed?.success ? parsed?.error.issues[0]?.message : undefined);
  const selected = rows.find(({ id }) => id === picking);
  const selectedProvider = ready.find(({ provider }) => provider === selected?.provider);

  function patchRow(id: number, change: Partial<Pick<ChainRow, "provider" | "model">>) {
    setRows((current) => current.map((row) => row.id === id ? { ...row, ...change } : row));
  }

  return (
    <View style={{ gap: 16, padding: 16 }}>
      <SettingsSection title="Fallback chain">
        <Text style={{ color: theme.colors.foregroundMuted }}>
          Cheapskate tries models from top to bottom. On fallback, the next backend receives recent chat context.
        </Text>
        {error ? (
          <SettingsAction label="Provider catalog" error={error} actionLabel="Retry" onPress={retry} />
        ) : providerOptions.length === 0 ? (
          <Text style={{ color: theme.colors.foregroundMuted }}>
            {discovering ? "Loading providers…" : "No providers are available on this host."}
          </Text>
        ) : null}
        {rows.map((row, index) => {
          const provider = ready.find((entry) => entry.provider === row.provider);
          const providerStatus = entries?.find((entry) => entry.provider === row.provider);
          const knownLabel = providerStatus?.label ?? row.provider;
          const options = [{ value: "", label: "Choose provider" }, ...providerOptions];
          if (row.provider && !provider) {
            const loading = !entries || providerStatus?.status === "loading";
            options.push({ value: row.provider, label: loading ? knownLabel : `${knownLabel} (unavailable)` });
          }
          const models = provider?.models ?? [];
          const model = models.find(({ id, aliases }) => id === row.model || aliases?.includes(row.model));
          const hasModels = models.some(({ isSelectable }) => isSelectable !== false);
          const unavailable = row.model && provider && (!model || model.isSelectable === false);
          return (
            <SettingsCard key={row.id}>
              <SettingsRow label={index === 0 ? "First choice" : `Fallback ${index}`}>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
                  <RowButton title="Move up" theme={theme} disabled={settings.saving || index === 0}
                    onPress={() => setRows((current) => moveRow(current, row.id, -1))} />
                  <RowButton title="Move down" theme={theme} disabled={settings.saving || index === rows.length - 1}
                    onPress={() => setRows((current) => moveRow(current, row.id, 1))} />
                  <RowButton title="Remove" theme={theme} disabled={settings.saving}
                    onPress={() => setRows((current) => current.filter(({ id }) => id !== row.id))} />
                </View>
              </SettingsRow>
              <SettingsSelect label="Provider" value={row.provider} options={options}
                disabled={settings.saving || providerOptions.length === 0}
                onValueChange={(value) => {
                  if (value !== row.provider) patchRow(row.id, { provider: value, model: "" });
                }} />
              <SettingsAction label="Model" actionLabel={model?.label ?? (row.model || "Choose model")}
                hint={unavailable ? "This saved model is unavailable." : provider && !hasModels ? "No selectable models." : undefined}
                disabled={settings.saving || !hasModels}
                onPress={() => setPicking(row.id)} />
            </SettingsCard>
          );
        })}
        <SettingsAction label="Add a provider and model to the chain" actionLabel="Add backend"
          disabled={settings.saving || providerOptions.length === 0}
          onPress={() => {
            const id = nextId.current++;
            setRows((current) => [...current, { id, provider: "", model: "" }]);
          }} />
        <ChainCheck key={chain} chain={parsed?.success ? parsed.data.chain : null} theme={theme} />
      </SettingsSection>
      <SettingsSwitch label="Switch on provider overload" value={overload} onValueChange={setOverload} disabled={settings.saving} />
      <SettingsAction
        label="Routing settings"
        actionLabel={settings.saving ? "Saving…" : "Save"}
        disabled={!dirty || !parsed?.success || settings.saving}
        error={saveError}
        onPress={() => {
          if (parsed?.success) void settings.save(parsed.data, settings.revision);
        }}
      />
      {selected && selectedProvider && (
        <ModelPicker
          provider={selectedProvider.label ?? selectedProvider.provider}
          models={selectedProvider.models ?? []}
          theme={theme}
          close={() => setPicking(undefined)}
          select={(model) => {
            patchRow(selected.id, { model });
            setPicking(undefined);
          }}
        />
      )}
    </View>
  );
}

function RowButton({ title, theme, disabled, onPress }: {
  title: string; theme: Theme; disabled: boolean; onPress(): void;
}) {
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress}
      style={{ paddingHorizontal: 8, paddingVertical: 10, opacity: disabled ? 0.4 : 1 }}>
      <Text style={{ color: theme.colors.foreground }}>{title}</Text>
    </Pressable>
  );
}

function ModelPicker({ provider, models, theme, close, select }: {
  provider: string; models: readonly CatalogModel[]; theme: Theme; close(): void; select(model: string): void;
}) {
  const [query, setQuery] = useState("");
  return (
    <Modal title={`${provider} models`} open onOpenChange={(open) => { if (!open) close(); }}>
      <Modal.Content scrollable={false}>
        <TextInput accessibilityLabel="Filter models" placeholder="Filter models" value={query}
          autoCapitalize="none" autoCorrect={false} onChangeText={setQuery}
          placeholderTextColor={theme.colors.foregroundMuted}
          style={{ color: theme.colors.foreground, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 8, padding: 12 }} />
        <FlatList
          data={searchModels(models, query)}
          keyExtractor={(model) => model.id}
          keyboardShouldPersistTaps="handled"
          style={{ minHeight: 120, maxHeight: 320 }}
          ListEmptyComponent={<Text style={{ color: theme.colors.foregroundMuted }}>No matching models.</Text>}
          renderItem={({ item }) => (
            <Pressable accessibilityRole="button" onPress={() => select(item.id)}
              style={{ paddingVertical: 10, borderBottomWidth: 1, borderColor: theme.colors.border }}>
              <Text style={{ color: theme.colors.foreground }}>{item.label}</Text>
              {item.id !== item.label && <Text style={{ color: theme.colors.foregroundMuted }}>{item.id}</Text>}
            </Pressable>
          )}
        />
      </Modal.Content>
    </Modal>
  );
}
