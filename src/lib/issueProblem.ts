import { invoke } from "@tauri-apps/api/core";

// 1.175.0 (B3 round 2): the question a Plan challenge opens with, for a
// card of a GitHub issue. The issue's title and text are somebody else's
// text: the backend hands them over quoted, with the parts GitHub hides
// marked (`issue_text.rs::problem_for_ai`), exactly as the Builder gets
// them. The window never joins an issue card's title and notes itself.

/** The quoted question for an issue card with no plan of its own yet;
 *  null for any other card (the window's own `cardBriefText` stands). */
export function cardIssueProblem(workspaceId: string, cardId: string) {
  return invoke<string | null>("card_issue_problem", { workspaceId, cardId });
}
