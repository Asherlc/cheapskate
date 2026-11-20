import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const id = z.string().min(1);
const storybookUrl = z.string().trim().min(1);
export const listStoriesInput = z.object({ url: storybookUrl, query: z.string().optional() });
export const selectStoryInput = z.object({ url: storybookUrl, storyId: id });

const story = z.object({ id, title: z.string(), name: z.string(), storyUrl: z.string() });
export const storyList = z.object({ url: storybookUrl, stories: z.array(story) });
const workspace = z.object({ workspaceId: id });
const owner = workspace.extend({ agentId: id });
const targetIdentity = owner.extend(selectStoryInput.shape);
export const reviewTarget = targetIdentity.extend(story.omit({ id: true }).shape);

export const canvasComments = z.array(z.object({
  id,
  storyId: id,
  note: z.string(),
  status: z.enum(["open", "resolved"]),
  selector: z.string(),
}).catchall(z.json()));

const reviewFeedback = z.object({ target: reviewTarget, comments: canvasComments });
export type ReviewTarget = z.infer<typeof reviewTarget>;
export type ReviewFeedback = z.infer<typeof reviewFeedback>;

export const listStoriesRpc = defineRpc({ name: "stories.list", input: listStoriesInput, output: storyList });
export const selectStoryRpc = defineRpc({ name: "stories.select", input: targetIdentity, output: reviewTarget });
export const getTargetRpc = defineRpc({ name: "review.target", input: workspace, output: reviewTarget.nullable() });
export const readFeedbackRpc = defineRpc({ name: "review.feedback", input: targetIdentity, output: reviewFeedback });
