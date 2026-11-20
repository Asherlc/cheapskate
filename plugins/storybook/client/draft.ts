import type { ReviewFeedback } from "../shared/contracts";
import { formatFeedback } from "../shared/feedback";

type ResolveDraft = (selector: { agentId: string }) => readonly {
  readonly prompt: string;
  setPrompt(text: string): void;
}[];

export function appendFeedbackToDraft(feedback: ReviewFeedback, composers: ResolveDraft): void {
  const text = formatFeedback(feedback);
  const [composer] = composers({ agentId: feedback.target.agentId });
  if (!composer) throw new Error("The review conversation is unavailable. Reopen it and try again.");
  const { prompt } = composer;
  composer.setPrompt(prompt ? `${prompt}\n\n${text}` : text);
}
