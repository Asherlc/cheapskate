import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import type { z } from "zod";
import { checkChain } from "../shared/chain-check";

export function ChainCheck({ chain, theme }: { chain: string | null; theme: PluginSurfaceProps["theme"] }) {
  const check = useRpc(checkChain);
  const [result, setResult] = useState<z.output<typeof checkChain.output>>();
  const [mode, setMode] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();

  async function run() {
    if (!chain || checking) return;
    setChecking(true);
    setError(undefined);
    setResult(undefined);
    try {
      const next = await check({ chain });
      setMode(next.defaultMode);
      setResult(next);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to check the chain.");
    } finally {
      setChecking(false);
    }
  }

  return <>
    <SettingsAction label="Catalog and permissions" actionLabel={checking ? "Checking…" : "Check chain"}
      hint="Checks the current rows against Paseo’s catalog and provider defaults, without sending a model request."
      error={error} disabled={!chain || checking} onPress={() => void run()} />
    {result && <SettingsCard>
      {result.modes.length > 0 && <SettingsSelect label="First choice permission mode" value={mode}
        options={result.modes.map(({ id, label }) => ({ value: id, label }))} onValueChange={setMode} />}
      {result.rows.map((row, index) => {
        const mapping = row.mappings[mode];
        return <SettingsRow key={index} label={row.label} error={row.error || undefined}
          hint={row.error ? undefined : mapping === null ? "Skipped with this permission mode"
            : mapping ? `Available · ${mapping}` : "Listed · permission match unknown"} />;
      })}
      <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
        <Text style={{ color: theme.colors.foregroundMuted }}>Quota and account access are checked when a backend runs a turn.</Text>
      </View>
    </SettingsCard>}
  </>;
}
