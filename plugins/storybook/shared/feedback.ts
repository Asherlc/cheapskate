import type { ReviewFeedback } from "./contracts";

export function formatFeedback({ target, comments }: ReviewFeedback): string {
  const notes = comments.map(({ note, selector, ...context }) =>
    [note, `Selector: ${selector}`, JSON.stringify(context, null, 2)].join("\n"),
  );
  return [`Storybook feedback for ${target.title} / ${target.name}`, target.storyUrl, ...notes].join("\n\n");
}
