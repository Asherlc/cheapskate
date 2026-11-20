import { openExternalUrl, useAgent, useRpc, type PluginAgentPanelProps, type PluginClientContext } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  getTargetRpc, listStoriesRpc, readFeedbackRpc, selectStoryRpc, serverStatusRpc, stopServerRpc,
  type ReviewFeedback, type ReviewTarget, type ServerStatus,
} from "../shared/contracts";
import { appendFeedbackToDraft } from "./draft";

function panelStyles({ theme: { colors }, layout: { compact } }: PluginAgentPanelProps) {
  return {
    body: { padding: compact ? 12 : 20, gap: compact ? 8 : 12 },
    text: { color: colors.foreground },
    muted: { color: colors.foregroundMuted },
    title: { color: colors.foreground, fontSize: compact ? 16 : 18, fontWeight: "600" as const },
    field: { color: colors.foreground, borderColor: colors.border, borderWidth: 1, borderRadius: 6, padding: 8 },
    card: { gap: 8, borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: compact ? 8 : 12 },
    row: { flexDirection: "row" as const, gap: 8, flexWrap: "wrap" as const },
    button: { backgroundColor: colors.surface2, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8 },
  };
}

type Styles = ReturnType<typeof panelStyles>;
type PanelProps = PluginAgentPanelProps & { client: PluginClientContext };
const serverLabels: Record<ServerStatus["state"], string> = {
  idle: "Ask your agent to start Storybook.",
  starting: "Starting Storybook…",
  ready: "Storybook is running.",
  stopping: "Stopping Storybook…",
  failed: "Storybook failed to run.",
};

function Action({ text, onPress, disabled, styles }: {
  text: string;
  onPress: () => void;
  disabled?: boolean;
  styles: Styles;
}) {
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={[styles.button, disabled && { opacity: 0.55 }]}>
      <Text style={styles.text}>{text}</Text>
    </Pressable>
  );
}

function Review({ target, styles, panel }: { target: ReviewTarget; styles: Styles; panel: PanelProps }) {
  const { client, host, navigation } = panel;
  const readFeedback = useRpc(readFeedbackRpc);
  const ownerTitle = useAgent(target.agentId, (agent) => agent.title);
  const [feedback, setFeedback] = useState<ReviewFeedback>();
  const [message, setMessage] = useState<string>();
  const refresh = useMutation({
    mutationFn: () => readFeedback({ workspaceId: target.workspaceId, agentId: target.agentId, url: target.url, storyId: target.storyId }),
    onSuccess: setFeedback,
  });

  async function openStory(inPaseo: boolean) {
    setMessage(undefined);
    try {
      if (inPaseo && navigation?.openBrowser) {
        navigation.openBrowser({ url: target.storyUrl, workspaceId: target.workspaceId, serverId: host.id });
      } else {
        await openExternalUrl(target.storyUrl);
      }
    } catch {
      setMessage(`Could not open the story. Open ${target.storyUrl} in your browser.`);
    }
  }

  function addToDraft() {
    if (!feedback?.comments.length) return;
    try {
      appendFeedbackToDraft(feedback, (selector) => client.composers(selector));
      setMessage(`Added feedback to the draft for ${ownerTitle ?? target.agentId}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not add feedback to the draft. Try again.");
    }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.title}>{target.title} / {target.name}</Text>
      <Text style={styles.muted}>Review conversation {ownerTitle ?? target.agentId}</Text>
      <Text selectable style={styles.muted}>{target.storyUrl}</Text>
      <View style={styles.row}>
        <Action text="Open in browser" onPress={() => { void openStory(false); }} styles={styles} />
        {navigation?.openBrowser && <Action text="Open in Paseo" onPress={() => { void openStory(true); }} styles={styles} />}
        <Action text={refresh.isPending ? "Reading feedback…" : "Refresh feedback"} disabled={refresh.isPending} onPress={() => {
          setMessage(undefined);
          refresh.mutate();
        }} styles={styles} />
        <Action text="Add to draft" disabled={refresh.isPending || !feedback?.comments.length} onPress={addToDraft} styles={styles} />
        {navigation && <Action text="Open conversation" onPress={() => navigation.openAgent({ agentId: target.agentId, serverId: host.id })} styles={styles} />}
      </View>
      {refresh.error && <Text accessibilityRole="alert" style={styles.text}>{refresh.error.message}</Text>}
      {feedback?.comments.length === 0 && <Text style={styles.muted}>No open Canvas Comments for this story.</Text>}
      {feedback?.comments.map(({ id, note, selector }) => (
        <View key={id} style={styles.card}>
          <Text selectable style={styles.text}>{note}</Text>
          <Text selectable style={styles.muted}>{selector}</Text>
        </View>
      ))}
      {message && <Text accessibilityLiveRegion="polite" style={styles.text}>{message}</Text>}
    </View>
  );
}

export function StorybookPanel(panel: PanelProps) {
  const { workspaceId, host, params: { agentId }, theme } = panel;
  const styles = panelStyles(panel);
  const agentTitle = useAgent(agentId, (agent) => agent.title);
  const getTarget = useRpc(getTargetRpc);
  const listStories = useRpc(listStoriesRpc);
  const selectStory = useRpc(selectStoryRpc);
  const serverStatus = useRpc(serverStatusRpc);
  const stopServer = useRpc(stopServerRpc);
  const queryClient = useQueryClient();
  const targetKey = ["storybook", host.id, workspaceId];
  const serverKey = [...targetKey, "server"];
  const server = useQuery({
    queryKey: serverKey,
    queryFn: () => serverStatus({ workspaceId }),
    refetchInterval: 2500,
    retry: false,
  });
  const stop = useMutation({
    mutationFn: () => stopServer({ workspaceId }),
    onMutate: () => queryClient.cancelQueries({ queryKey: serverKey }),
    onSuccess: (status) => { queryClient.setQueryData(serverKey, status); },
  });
  const review = useQuery({
    queryKey: targetKey,
    queryFn: () => getTarget({ workspaceId }),
    retry: false,
    refetchOnMount: "always",
    refetchInterval: 2500,
  });
  const [enteredUrl, setEnteredUrl] = useState<string>();
  const [browserUrl, setBrowserUrl] = useState("");
  const [query, setQuery] = useState("");
  const managedUrl = server.data?.state === "ready" ? server.data.url : undefined;
  const url = enteredUrl ?? managedUrl ?? review.data?.url ?? "";
  const list = useMutation({ mutationFn: (url: string) => listStories({ url }) });
  const select = useMutation({
    mutationFn: selectStory,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: targetKey, exact: true }),
  });
  const search = query.trim().toLowerCase();
  const listing = list.variables === url ? list.data : undefined;
  const stories = listing?.stories.filter(({ title, name, id }) => `${title} ${name} ${id}`.toLowerCase().includes(search));
  const busy = list.isPending || select.isPending;
  const target = review.data;
  const state = server.data?.state;

  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body} style={{ backgroundColor: theme.colors.surface0 }}>
      <View style={styles.card}>
        <View style={styles.row}>
          <Text accessibilityLiveRegion="polite" style={styles.muted}>
            {stop.isPending ? serverLabels.stopping : state ? serverLabels[state] : "Checking Storybook server…"}
          </Text>
          {(state === "starting" || state === "ready" || state === "failed") && (
            <Action text="Stop Storybook" onPress={() => stop.mutate()} disabled={stop.isPending} styles={styles} />
          )}
        </View>
        {managedUrl && <Text selectable style={styles.muted}>Daemon URL {managedUrl}</Text>}
        {(stop.error || server.error || server.data?.error) && (
          <Text accessibilityRole="alert" selectable style={styles.text}>
            {stop.error?.message ?? server.error?.message ?? server.data?.error}
          </Text>
        )}
      </View>
      {review.error && <Text accessibilityRole="alert" style={styles.text}>{review.error.message}</Text>}
      {target && <Review key={JSON.stringify(target)} target={target} styles={styles} panel={panel} />}
      <Text style={styles.title}>Browse stories</Text>
      <Text style={styles.muted}>Selecting for {agentTitle ?? agentId}</Text>
      <Text style={styles.text}>Daemon URL</Text>
      <TextInput
        accessibilityLabel="Daemon URL"
        value={url}
        onChangeText={(value) => { setEnteredUrl(value); setBrowserUrl(""); list.reset(); select.reset(); }}
        editable={!busy}
        placeholder="http://localhost:6006"
        placeholderTextColor={theme.colors.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        style={styles.field}
      />
      <Text style={styles.text}>Browser URL (optional)</Text>
      <TextInput
        accessibilityLabel="Browser URL"
        value={browserUrl}
        onChangeText={(value) => { setBrowserUrl(value); select.reset(); }}
        editable={!busy}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        style={styles.field}
      />
      <Text style={styles.muted}>If you connect to a remote daemon, enter a private forwarded Storybook URL, such as a Tailnet link from Ports.</Text>
      <View style={styles.row}>
        <Action text={list.isPending ? "Listing stories…" : "List stories"} onPress={() => {
          if (url !== managedUrl) setEnteredUrl(url);
          list.mutate(url);
        }} disabled={busy || !url.trim()} styles={styles} />
      </View>
      {list.variables === url && list.error && <Text accessibilityRole="alert" style={styles.text}>{list.error.message}</Text>}
      {select.error && <Text accessibilityRole="alert" style={styles.text}>{select.error.message}</Text>}
      {listing && (
        <>
          <TextInput accessibilityLabel="Search stories" value={query} onChangeText={setQuery} placeholder="Search stories" placeholderTextColor={theme.colors.foregroundMuted} style={styles.field} />
          {stories?.length === 0 && <Text style={styles.muted}>No matching stories.</Text>}
          {stories?.map((story) => (
            <Action
              key={story.id}
              text={`${story.title} / ${story.name}`}
              disabled={busy}
              onPress={() => {
                select.mutate({ workspaceId, agentId, url: listing.url, storyId: story.id, browserUrl: browserUrl.trim() || undefined });
              }}
              styles={styles}
            />
          ))}
        </>
      )}
    </ScrollView>
  );
}
