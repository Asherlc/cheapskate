import type { PluginTheme } from "@getpaseo/plugin";
import { useAgent, useAgents, useComposers, useRpc, type AgentRef } from "@getpaseo/plugin/client";
import { Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useRef, useState } from "react";
import { Image, type GestureResponderEvent, type LayoutChangeEvent, Text, useWindowDimensions, View } from "react-native";
import { annotationText, MAX_MARKS, MAX_NOTE_CHARS, type Mark } from "../shared/annotation";
import { annotateRpc, frameRpc, type Device } from "../shared/contracts";
import { useAction } from "./data";
import { Button } from "./ui";

type Workspace = { workspaceId: string; workspaceName: string; directory: string };
type Shot = { jpeg: string; width: number; height: number };
type Point = { x: number; y: number };
type Tool = "point" | "box";

/**
 * Grabs one frame of a booted simulator, lets the user place numbered points and boxes on it,
 * then saves the marked copy and appends its path plus the comments to a chat's draft. Nothing is
 * sent: the user reviews the draft and presses Send themselves.
 */
export function Annotate({ theme, hostId, device, workspace }: {
  theme: PluginTheme;
  hostId: string;
  device: Device;
  workspace: Workspace;
}) {
  const frame = useRpc(frameRpc);
  const save = useRpc(annotateRpc);
  const { busy, perform } = useAction(hostId);
  const toast = useToast();
  const agents = useAgents({
    hosts: [hostId],
    where: (agent) =>
      agent.workspaceId === workspace.workspaceId && !agent.background && agent.status !== "closed",
  });
  const [shot, setShot] = useState<Shot | null>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [tool, setTool] = useState<Tool>("point");
  const [chosen, setChosen] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [adding, setAdding] = useState(false);
  const c = theme.colors;

  const needsChoice = agents.length > 1;
  // With one eligible agent it is the default; with several the user must pick one explicitly.
  const selectedId = needsChoice
    ? agents.some((agent) => agent.id === chosen)
      ? chosen
      : null
    : (agents[0]?.id ?? null);
  // Reactive, per host: no global client binding, and a fresh resolution on every render.
  const composers = useComposers({ agentId: selectedId ?? "" });

  function reset() {
    setShot(null);
    setMarks([]);
    setTool("point");
    setChosen(null);
  }

  async function capture() {
    setCapturing(true);
    try {
      const result = await frame({ deviceId: device.id, maxWidth: 1200, since: -1 });
      if (result.status !== "frame") {
        toast.error(result.status === "unavailable" ? result.reason : "No picture yet");
        return;
      }
      setShot({ jpeg: result.jpeg, width: result.width, height: result.height });
      setMarks([]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setCapturing(false);
    }
  }

  const edit = (index: number, text: string) =>
    setMarks((current) => current.map((mark, i) => (i === index ? { ...mark, text } : mark)));
  const remove = (index: number) => setMarks((current) => current.filter((_, i) => i !== index));
  const add = (mark: Mark) => setMarks((current) => (current.length >= MAX_MARKS ? current : [...current, mark]));

  async function addToDraft() {
    if (!shot || !selectedId || !marks.length || adding || capturing || busy) return;
    setAdding(true);
    try {
      const saved = await perform(
        () =>
          save({
            ...workspace,
            deviceId: device.id,
            jpeg: shot.jpeg,
            width: shot.width,
            height: shot.height,
            marks,
          }),
        true,
      );
      if (!saved) return; // saving failed: keep the notes so the user can retry
      const composer = composers[0];
      if (!composer) {
        toast.error("That chat isn't available any more");
        return; // keep the notes: a handoff failure must not throw away the work
      }
      const note = annotationText(saved.path, marks);
      try {
        // Append with a blank line, preserving whatever is already in the draft (and the selection).
        composer.setPrompt(composer.prompt ? `${composer.prompt}\n\n${note}` : note);
      } catch (error) {
        toast.error(
          `Couldn't add the comments to the draft: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return; // keep the notes so a handoff failure doesn't throw away the work
      }
      toast.show("Added to the draft. Review and send when you're ready.", { variant: "success" });
      reset();
      void composer.focus().catch(() => {});
    } finally {
      setAdding(false);
    }
  }

  const canAdd = Boolean(shot && selectedId && marks.length && !adding && !capturing && !busy);
  return (
    <>
      <Button
        theme={theme}
        icon="Pencil"
        label={capturing ? "Capturing…" : "Annotate"}
        disabled={capturing || busy}
        onPress={() => void capture()}
      />
      <Modal
        title="Annotate screenshot"
        open={shot !== null}
        onOpenChange={(open) => {
          if (!open && !busy && !adding) reset();
        }}
      >
        <Modal.Content>
          {shot ? (
            <>
              <Text style={{ color: c.foregroundMuted }}>
                Tap for a numbered point, or drag for a numbered box. Then add a comment to each one.
              </Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Button
                  theme={theme}
                  primary={tool === "point"}
                  label="Point"
                  onPress={() => setTool("point")}
                />
                <Button theme={theme} primary={tool === "box"} label="Box" onPress={() => setTool("box")} />
              </View>
              <Editor
                theme={theme}
                shot={shot}
                tool={tool}
                marks={marks}
                full={marks.length >= MAX_MARKS}
                onAdd={add}
              />
              {marks.length ? (
                <View style={{ gap: 8 }}>
                  <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                    {marks.length} of {MAX_MARKS} marks
                  </Text>
                  {marks.map((mark, index) => (
                    <View key={index} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <View
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: 11,
                          backgroundColor: c.accent,
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Text style={{ color: c.accentForeground, fontSize: 12, fontWeight: "700" }}>
                          {index + 1}
                        </Text>
                      </View>
                      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                        {mark.kind === "point" ? "point" : "box"}
                      </Text>
                      <TextInput
                        value={mark.text}
                        onChangeText={(value) => edit(index, value.slice(0, MAX_NOTE_CHARS))}
                        maxLength={MAX_NOTE_CHARS}
                        placeholder="Comment"
                        placeholderTextColor={c.foregroundMuted}
                        style={{
                          flex: 1,
                          color: c.foreground,
                          backgroundColor: c.surface2,
                          borderColor: c.border,
                          borderWidth: 1,
                          borderRadius: 8,
                          paddingVertical: 6,
                          paddingHorizontal: 8,
                        }}
                      />
                      <Button theme={theme} label="Remove" onPress={() => remove(index)} />
                    </View>
                  ))}
                </View>
              ) : (
                <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>No marks yet.</Text>
              )}
              {needsChoice ? (
                <View style={{ gap: 6 }}>
                  <Text style={{ color: c.foreground, fontSize: 13 }}>Add to which chat's draft?</Text>
                  {agents.map((agent) => (
                    <AgentChoice
                      key={agent.id}
                      ref={agent}
                      theme={theme}
                      active={chosen === agent.id}
                      onPress={() => setChosen(agent.id)}
                    />
                  ))}
                </View>
              ) : null}
              {!agents.length ? (
                <Text style={{ color: c.statusWarning, fontSize: 12 }}>
                  Start an agent in this workspace first, so there's a draft to add it to.
                </Text>
              ) : null}
              <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
                <Button theme={theme} label="Cancel" disabled={busy || adding} onPress={reset} />
                <Button
                  theme={theme}
                  primary
                  label={adding ? "Adding…" : "Add to draft"}
                  disabled={!canAdd}
                  onPress={() => void addToDraft()}
                />
              </View>
            </>
          ) : null}
        </Modal.Content>
      </Modal>
    </>
  );
}

/** `useAgent` can only run for one ref at a time, so each row reads its own title. */
function AgentChoice({ ref, theme, active, onPress }: {
  ref: AgentRef;
  theme: PluginTheme;
  active: boolean;
  onPress(): void;
}) {
  const title = useAgent(ref, (agent) => agent.title ?? agent.id);
  return (
    <Button theme={theme} label={title ?? ref.id} primary={active} onPress={onPress} />
  );
}

/** The picture at its displayed size, with marks laid over it in the same normalized coordinates. */
function Editor({ theme, shot, tool, marks, full, onAdd }: {
  theme: PluginTheme;
  shot: Shot;
  tool: Tool;
  marks: Mark[];
  full: boolean;
  onAdd(mark: Mark): void;
}) {
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null);
  const start = useRef<Point | null>(null);
  const { height } = useWindowDimensions();
  const editorHeight = Math.min(440, Math.max(240, Math.round(height / 2)));
  const c = theme.colors;
  const scale = box.width && box.height ? Math.min(box.width / shot.width, box.height / shot.height) : 0;
  const size = { width: Math.floor(shot.width * scale), height: Math.floor(shot.height * scale) };

  const at = (x: number, y: number): Point => ({
    x: Math.min(1, Math.max(0, x / (size.width || 1))),
    y: Math.min(1, Math.max(0, y / (size.height || 1))),
  });
  const pointOf = (event: GestureResponderEvent) => at(event.nativeEvent.locationX, event.nativeEvent.locationY);

  function release(event: GestureResponderEvent) {
    const from = start.current;
    start.current = null;
    setDrag(null);
    if (!from || full) return;
    const to = pointOf(event);
    const w = Math.abs(to.x - from.x);
    const h = Math.abs(to.y - from.y);
    if (tool === "box") {
      // A tap or a tiny drag in Box mode is not a point; switch to Point for those.
      if (w > 0.01 && h > 0.01)
        onAdd({ kind: "box", x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w, h, text: "" });
    } else {
      onAdd({ kind: "point", x: from.x, y: from.y, text: "" });
    }
  }

  const badge = (n: number) => (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: -10,
        left: -10,
        width: 20,
        height: 20,
        borderRadius: 10,
        backgroundColor: "#ff453a",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: "#fff", fontSize: 12, fontWeight: "700" }}>{n}</Text>
    </View>
  );

  return (
    <View
      style={{ height: editorHeight, alignItems: "center", justifyContent: "center" }}
      onLayout={(event: LayoutChangeEvent) =>
        setBox({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })
      }
    >
      {size.width ? (
        <View
          accessible
          accessibilityRole="image"
          accessibilityLabel="Screenshot. Tap to add a numbered point, or drag to add a numbered box."
          style={{ position: "relative", width: size.width, height: size.height }}
          onStartShouldSetResponder={() => !full}
          onMoveShouldSetResponder={() => !full}
          onResponderTerminationRequest={() => false}
          onResponderGrant={(event) => {
            const point = pointOf(event);
            start.current = point;
            setDrag({ from: point, to: point });
          }}
          onResponderMove={(event) => {
            if (start.current && tool === "box") setDrag({ from: start.current, to: pointOf(event) });
          }}
          onResponderRelease={release}
          onResponderTerminate={() => {
            start.current = null;
            setDrag(null);
          }}
        >
          <View pointerEvents="none" style={{ width: size.width, height: size.height }}>
            <Image
              source={{ uri: `data:image/jpeg;base64,${shot.jpeg}` }}
              style={{ width: size.width, height: size.height, borderRadius: 10 }}
              fadeDuration={0}
            />
          </View>
          {marks.map((mark, index) =>
            mark.kind === "point" ? (
              <View
                key={index}
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: mark.x * size.width - 11,
                  top: mark.y * size.height - 11,
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  borderWidth: 2,
                  borderColor: "#ff453a",
                  backgroundColor: "rgba(255,69,58,0.25)",
                }}
              >
                {badge(index + 1)}
              </View>
            ) : (
              <View
                key={index}
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: mark.x * size.width,
                  top: mark.y * size.height,
                  width: mark.w * size.width,
                  height: mark.h * size.height,
                  borderWidth: 2,
                  borderColor: "#ff453a",
                  borderRadius: 4,
                  backgroundColor: "rgba(255,69,58,0.12)",
                }}
              >
                {badge(index + 1)}
              </View>
            ),
          )}
          {drag && tool === "box" ? (
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                left: Math.min(drag.from.x, drag.to.x) * size.width,
                top: Math.min(drag.from.y, drag.to.y) * size.height,
                width: Math.abs(drag.to.x - drag.from.x) * size.width,
                height: Math.abs(drag.to.y - drag.from.y) * size.height,
                borderWidth: 2,
                borderColor: c.accent,
                borderRadius: 4,
              }}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
