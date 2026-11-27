// The app's own words the scenario presses or waits for, each with the source
// that draws it. lib.test.mjs requires each there as a string or a JSX label
// (`wordInSource`), not merely as letters in the file, so a rewording breaks a
// test, not a walk. It can't tell whether that source is what the screen shows.
import { SANDBOX_REPO, TEAM_REPO } from "./lib.mjs";

export const WORDS = {
  welcomeTitle: ["Welcome to Plyloft", "src/components/SetupStepBodies.tsx"],
  useRegularly: ["I use them regularly", "src/components/SetupStepBodies.tsx"],
  cont: ["Continue", "src/components/SetupOverlay.tsx"],
  essentials: ["Just the essentials", "src/components/SetupOverlay.tsx"],
  withTeam: ["With a team", "src/components/SetupStepBodies.tsx"],
  // 1.175.0 F2: the question's way in while the deduction says solo.
  addTeamStep: ["Add the team step", "src/lib/setupSteps.ts"],
  stepByStep: ["Switch to step by step", "src/lib/setupSteps.ts"],
  yourTeam: ["Your team", "src/lib/setupSteps.ts"],
  joinTeam: ["Join a team", "src/lib/teamStep.ts"],
  looking: ["Looking for your teams on GitHub…", "src/lib/teamStep.ts"],
  join: ["Join", "src/lib/teamStep.ts"],
  added: ["Added", "src/components/setup/TeamStep.tsx"],
  getOne: ["Get 1 project", "src/lib/teamStep.ts"],
  closeSetup: ["Close setup", "src/components/SetupOverlay.tsx"],
  settings: ["Settings", "src/lib/sidebarNav.ts"],
  general: ["General", "src/lib/settingsNav.ts"],
  moveBoard: ["Move to GitHub Issues", "src/lib/adoption.ts"],
  onIssues: ["On GitHub Issues", "src/components/settings/BoardPage.tsx"],
  closeSettings: ["Close settings", "src/components/SettingsOverlay.tsx"],
  board: ["Board", "src/lib/sidebarNav.ts"],
  area: ["Area", "src/lib/cardArea.ts"],
  issuesLine: ["Cards come from the GitHub issues of", "src/components/KanbanBoard.tsx"],
  newCard: ["New card", "src/components/KanbanBoard.tsx"],
  newCardTitle: ["New card title", "src/components/KanbanBoard.tsx"],
  details: ["Details", "src/lib/cardErrorNow.ts"],
  technical: ["Technical", "src/components/CardDetailPanel.tsx"],
  claim: ["Claim", "src/components/CardClaimChip.tsx"],
  claimedBy: ["Claimed by", "src/lib/cardClaim.ts"],
  moreForCard: ["More for this card", "src/components/CardDetailPanel.tsx"],
  deleteCard: ["Delete card…", "src/components/CardDetailPanel.tsx"],
  closeAndDelete: ["Close issue & delete", "src/lib/cardDeleteSheet.ts"],
  getNewIssues: ["Get new issues", "src/components/KanbanBoard.tsx"],
  closedWord: ["Closed", "src/lib/cardLifecycle.ts"],
  // --membership (membership.mjs).
  membersPage: ["Members and library", "src/lib/settingsNav.ts"],
  addSomebody: ["Add somebody", "src/components/settings/TeamPage.tsx"],
  review: ["Review", "src/components/settings/TeamPage.tsx"],
  sendInvites: ["Send invites", "src/lib/teamAdmin.ts"],
  addToTeam: ["Add to the team", "src/lib/teamAdmin.ts"],
  couldNotCheck: ["could not check — read it again", "src/components/settings/TeamPage.tsx"],
  noAccountChip: ["no GitHub account with this name", "src/lib/teamAdmin.ts"],
  couldntAdd: ["Couldn't add the member.", "src/components/settings/TeamPage.tsx"],
  removeMenu: ["Remove from team…", "src/components/settings/TeamPage.tsx"],
  removeConfirm: ["Remove from team", "src/components/settings/TeamPage.tsx"],
  cancel: ["Cancel", "src/components/settings/TeamPage.tsx"],
  readItAgain: ["Read it again", "src/components/settings/TeamPage.tsx"],
  member: ["Member", "src/components/settings/TeamPage.tsx"],
  readyToStart: ["Ready to start", "src/lib/cardLifecycle.ts"],
  noAccess: ["no access on GitHub", "src/lib/boardFreshness.ts"],
};

export const word = (key) => WORDS[key][0];

/** Code the scenario's composed words come from. */
export const TEMPLATES = [
  ["`Join ${team.name}`", "src/lib/teamStep.ts"],
  ["`Join the team at ${t.repo}?`", "src/lib/teamStep.ts"],
  ["` · ${ghRepo}`", "src/components/settings/BoardPage.tsx"],
  ["`Add ${plan.login} to ${plan.teamName}`", "src/components/settings/TeamPage.tsx"],
  ["`More for ${member.login}`", "src/components/settings/TeamPage.tsx"],
  ["`${repo}, open its issues on GitHub`", "src/components/KanbanBoard.tsx"],
  ["`If GitHub no longer gives ${login} access, it takes them off their issues, and those cards go back to Ready to start.`", "src/lib/teamAdmin.ts"],
  ["`GitHub has no account named ${plan.login}. Check the spelling; Plyloft sends nothing.`", "src/lib/teamAdmin.ts"],
  ["`${outcome.login} removed from the team`", "src/lib/teamAdmin.ts"],
  ["`No write access to ${listRepos(outcome.removed)} any more, and the team no longer lists them.${cancelled}${reads}${seat}`", "src/lib/teamAdmin.ts"],
  ["`${outcome.login} removed, but their seat is still taken`", "src/lib/teamAdmin.ts"],
  ["`${outcome.login} is still in the team`", "src/lib/teamAdmin.ts"],
  ["`${outcome.login} is still listed in the team`", "src/lib/teamAdmin.ts"],
];

/** The word as the code draws it: a whole string, a template's start, or a JSX
 *  label. Letters in a comment or inside a longer word don't count. */
export function wordInSource(source, text) {
  const t = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`"${t}"|'${t}'|\`${t}\`|\`${t} ?\\$\\{|>\\s*${t}\\s*[<{]`).test(source);
}

/** The team's name, from `team.json`, as `Join ${team.name}` writes it. */
export const JOIN_THE_TEAM = "Join Plyloft test team";
export const JOIN_SHEET_TITLE = `Join the team at ${TEAM_REPO}?`;
/** The team's project, as the manifest lists it: the sandbox's name. */
export const PROJECT = SANDBOX_REPO.slice(SANDBOX_REPO.indexOf("/") + 1);

// --membership: the same templates, composed.
export const INVITE_PLAN_TITLE = (login) => `Add ${login} to Plyloft test team`;
export const MORE_FOR = (login) => `More for ${login}`;
export const REPO_BUTTON_TAIL = ", open its issues on GitHub";
export const REMOVAL_CLAIMS_NOTE = (login) => `If GitHub no longer gives ${login} access, it takes them off their issues, and those cards go back to Ready to start.`;
export const NO_ACCOUNT_LINE = (login) => `GitHub has no account named ${login}. Check the spelling; Plyloft sends nothing.`;
/** The line Members keeps after a Remove that went through, with no seat to
 *  speak of (a dev plan holds none). */
export const REMOVAL_NORMAL = (login, team, sandbox) =>
  `${login} removed from the team. No write access to ${team} and ${sandbox} any more, and the team no longer lists them.`;
export const REMOVAL_RESULTS = (login) => [
  `${login} removed from the team`,
  `${login} removed, but their seat is still taken`,
  `${login} is still in the team`,
  `${login} is still listed in the team`,
];
