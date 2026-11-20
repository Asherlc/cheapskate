import { defineAgentTool, type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import {
  getTargetRpc, listStoriesInput, listStoriesRpc, readFeedbackRpc, selectStoryInput, selectStoryRpc,
  type ReviewTarget,
} from "./shared/contracts";
import { formatFeedback } from "./shared/feedback";
import { listStories, readFeedback, selectStory } from "./server/storybook";

export default function contribute(server: PluginServerContext) {
  const targets = new Map<string, ReviewTarget>();

  function currentTarget(workspaceId: string) {
    const target = targets.get(workspaceId);
    if (!target) throw new Error("Select a Storybook story for review in this workspace first.");
    return target;
  }

  server.handle(listStoriesRpc, (input) => listStories(input));
  server.handle(getTargetRpc, ({ workspaceId }) => targets.get(workspaceId) ?? null);
  server.handle(selectStoryRpc, async ({ workspaceId, agentId, url, storyId }) => {
    const target = await selectStory({ url, storyId }, { workspaceId, agentId });
    targets.set(workspaceId, target);
    return target;
  });
  server.handle(readFeedbackRpc, ({ workspaceId, agentId, url, storyId }) => {
    const target = currentTarget(workspaceId);
    if (target.agentId !== agentId || target.url !== url || target.storyId !== storyId) {
      throw new Error("The selected story or conversation changed. Refresh the review and try again.");
    }
    return readFeedback(target);
  });

  const listTool = defineAgentTool({
    name: "storybook_list_stories",
    description: "List stories at a Storybook HTTP(S) URL. Optionally filter by title, name, or story ID.",
    input: listStoriesInput,
    async execute(input, { signal }) {
      const result = await listStories(input, signal);
      const text = result.stories.map(({ id, title, name, storyUrl }) => `${id} · ${title} / ${name} · ${storyUrl}`).join("\n");
      return { text: text || "No matching stories.", structuredContent: result };
    },
  });

  const removeHook = server.addHook("agent.open.before", async ({ request }) => {
    const ownerId = request.labels["cheapskate.owner"];
    if (request.purpose === "history" || (request.background && !ownerId)) return;
    const agentId = ownerId ?? request.agentId;
    const selectTool = defineAgentTool({
      name: "storybook_select_story",
      description: "Select a Storybook story by ID for review in this Paseo workspace.",
      input: selectStoryInput,
      async execute(input, { agent, signal }) {
        const workspaceId = agent.workspaceId;
        if (!workspaceId) throw new Error("Open an agent in a workspace before selecting a Storybook story.");
        const target = await selectStory(input, { workspaceId, agentId }, signal);
        targets.set(workspaceId, target);
        return {
          text: `Selected ${target.title} / ${target.name}. Open ${target.storyUrl} using Paseo’s existing browser tools.`,
          structuredContent: target,
        };
      },
    });
    const feedbackTool = defineAgentTool({
      name: "storybook_read_feedback",
      description: "Read open Canvas Comments feedback on the selected Storybook story in this workspace.",
      input: z.object({}),
      async execute(_input, { agent, signal }) {
        if (!agent.workspaceId) throw new Error("Open an agent in a workspace before reading Storybook feedback.");
        const feedback = await readFeedback(currentTarget(agent.workspaceId), signal);
        return {
          text: feedback.comments.length ? formatFeedback(feedback) : `No open Canvas Comments on ${feedback.target.storyUrl}.`,
          structuredContent: feedback,
        };
      },
    });
    return { ...request, tools: [...request.tools, listTool, selectTool, feedbackTool] };
  });
  return () => {
    removeHook();
    targets.clear();
  };
}
