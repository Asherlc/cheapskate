import { z } from "zod";
import { canvasComments, type ReviewFeedback, type ReviewTarget, type listStoriesInput, type selectStoryInput } from "../shared/contracts";

const entryFields = z.object({ id: z.string().min(1), title: z.string(), name: z.string() });
const entry = z.discriminatedUnion("type", [
  entryFields.extend({ type: z.literal("story") }),
  z.object({ type: z.literal("docs") }),
]);
const storyIndex = z.union([
  z.object({ entries: z.record(z.string(), entry) }),
  z.object({ stories: z.record(z.string(), entryFields.extend({ type: z.enum(["story", "docs"]).optional() })) }),
]);

export function normalizeStorybookUrl(input: string): string {
  const url = URL.parse(input.trim());
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Enter a complete HTTP or HTTPS Storybook URL without embedded credentials.");
  }
  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(/\/(?:index|iframe)\.html$/, "");
  url.pathname = `${path.replace(/\/+$/, "")}/`;
  return url.href;
}

async function getJson(url: URL, label: string, hint: string, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(8_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const failure = () => {
    if (signal?.aborted) return new Error(`Reading ${label} was canceled.`);
    if (timeout.aborted) return new Error(`Reading ${label} timed out at ${url.href}. ${hint}`);
    return new Error(`Could not reach ${label} at ${url.href}. ${hint}`);
  };
  const response = await fetch(url, { signal: requestSignal }).catch(() => { throw failure(); });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status} at ${url.href}. ${hint}`);
  try {
    return await response.json();
  } catch (error) {
    if (requestSignal.aborted || !(error instanceof SyntaxError)) throw failure();
    throw new Error(`${label} returned invalid JSON at ${url.href}. ${hint}`);
  }
}

export async function listStories(input: z.infer<typeof listStoriesInput>, signal?: AbortSignal) {
  const url = normalizeStorybookUrl(input.url);
  const endpoint = new URL("index.json", url);
  const hint = "Check the Storybook URL and make sure the daemon can reach it.";
  const result = storyIndex.safeParse(await getJson(endpoint, "Storybook index", hint, signal));
  if (!result.success) throw new Error(`Invalid Storybook index at ${endpoint.href}. ${hint}`);
  const entries = "entries" in result.data ? result.data.entries : result.data.stories;
  const query = input.query?.trim().toLowerCase() ?? "";
  const stories = Object.values(entries)
    .filter((entry) => entry.type !== "docs")
    .filter(({ title, name, id }) => `${title} ${name} ${id}`.toLowerCase().includes(query))
    .map(({ id, title, name }) => ({ id, title, name, storyUrl: `${url}?path=/story/${encodeURIComponent(id)}` }));
  return { url, stories };
}

export async function selectStory(
  input: z.infer<typeof selectStoryInput>,
  owner: Pick<ReviewTarget, "agentId" | "workspaceId">,
  signal?: AbortSignal,
): Promise<ReviewTarget> {
  const { url, stories } = await listStories(input, signal);
  const story = stories.find(({ id }) => id === input.storyId);
  if (!story) throw new Error(`Story ${input.storyId} was not found at ${url}. List the available stories and try again.`);
  return { ...owner, url, storyId: story.id, title: story.title, name: story.name, storyUrl: story.storyUrl };
}

export async function readFeedback(target: ReviewTarget, signal?: AbortSignal): Promise<ReviewFeedback> {
  const endpoint = new URL("/__canvas-comments/comments", target.url);
  const hint = "Run a Vite Storybook dev server with storybook-addon-canvas-comments enabled and check that the daemon can reach it.";
  const result = canvasComments.safeParse(await getJson(endpoint, "Canvas Comments API", hint, signal));
  if (!result.success) throw new Error(`Invalid Canvas Comments response at ${endpoint.href}. ${hint}`);
  return { target, comments: result.data.filter(({ status, storyId }) => status === "open" && storyId === target.storyId) };
}
