import { useComposer, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Select, Toggle } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { prepareDraft } from "../shared/controls";
import { preferences, providerId } from "../shared/settings";
import type { z } from "zod";

export function DraftControls() {
  const composer = useComposer();
  const selected = composer.context !== "agent" && composer.agent.provider === providerId;
  return selected ? <BackendControls /> : null;
}

function BackendControls() {
  const composer = useComposer();
  const prepare = useRpc(prepareDraft);
  const settings = useSettings(preferences);
  const revision = settings.status === "ready" ? settings.revision : undefined;
  const [catalog, setCatalog] = useState<z.output<typeof prepareDraft.output>>();

  useEffect(() => {
    if (revision === undefined) return;
    let active = true;
    setCatalog(undefined);
    void prepare({}).then(
      (result) => { if (active) setCatalog(result); },
      () => { if (active) setCatalog(undefined); },
    );
    return () => { active = false; };
  }, [prepare, revision]);

  return <>
    {catalog?.controls.map((control) => {
      const value = composer.agent.options[control.key] ?? catalog.options[control.key] ?? control.defaultValue;
      const apply = ({ value }: { value: boolean | string }) => composer.setOptions({ [control.key]: value });
      if (control.type === "toggle") {
        return <Toggle key={control.key} title={control.label} icon={control.icon ?? "Settings"} value={value === true} onValueChange={apply} />;
      }
      return <Select
        key={control.key}
        title={control.label}
        icon={control.icon ?? "Settings"}
        value={typeof value === "string" ? value : ""}
        options={control.choices}
        onValueChange={apply}
      />;
    })}
  </>;
}
