/**
 * Skills hub H9 (`docs/plans/SKILLS_HUB.md` R9, §14 Q9, Q27): the words for a
 * skill that comes with Plyloft — its version, what changed, and which of the
 * three switches decides it (workspace → team → this Mac).
 *
 * Pure, so `node` can test it; `librarySkills.ts` and the skill's page only
 * draw what this returns. The facts come from `commands::ply_skills_view`
 * (`PlySkillSwitch`, `PlyPlace`); this Mac's own switch is the live settings,
 * so flicking it re-decides here without a re-read ([`liveSwitch`]).
 */
import type { PlyPlace, PlySkillChange, PlySkillSwitch } from "../ipc.ts";
import { machineWords } from "./platform.ts";

/** `v1.155.0`. */
export function versionWord(version: string): string {
  return `v${version}`;
}

/**
 * The row's hint (R9 AC): `v1.167.0 · Changed in 1.167.0: <summary>` once a
 * skill has changed since it first shipped; `v1.152.0 · <first sentence>` for
 * one still at its first version; the first sentence alone on a build that
 * lists no versions.
 */
export function plyRowHint(firstSentence: string, changes: readonly PlySkillChange[] | undefined): string {
  const latest = changes?.[0];
  if (!latest) return firstSentence;
  if ((changes?.length ?? 0) > 1 && latest.summary.trim() !== "") {
    return `${versionWord(latest.version)} · Changed in ${latest.version}: ${latest.summary.trim()}`;
  }
  return firstSentence ? `${versionWord(latest.version)} · ${firstSentence}` : versionWord(latest.version);
}

/** The page's lines under the header: `Changed in …` and `Earlier: …`. */
export function plyChangeLines(changes: readonly PlySkillChange[] | undefined): { latest: string | null; earlier: string | null } {
  const [latest, ...rest] = changes ?? [];
  if (!latest) return { latest: null, earlier: null };
  return {
    latest: `Changed in ${latest.version}: ${sentence(latest.summary)}`,
    earlier:
      rest.length > 0
        ? `Earlier: ${rest.map((change) => `${change.version} — ${change.summary.trim()}`).join(" · ")}.`
        : null,
  };
}

function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * The switch with this Mac's level taken from the live settings: a level
 * above it (workspace, a fork, the team) keeps deciding; otherwise this Mac's
 * switch is the answer.
 */
export function liveSwitch(read: PlySkillSwitch | null | undefined, macOn: boolean): PlySkillSwitch | null {
  if (!read) return null;
  if (read.level === "workspace" || read.level === "fork" || read.level === "team") {
    return { ...read, macOn };
  }
  return { ...read, macOn, on: macOn, level: macOn ? "default" : "mac" };
}

/** Where a choice set in this workspace lives, in words. */
function setIn(place: PlyPlace): string {
  return place.shared && place.repository
    ? `set in ${place.repository} (.atelier/workspace.json)`
    : machineWords("set for this workspace on this Mac");
}

/**
 * The note a row carries when a level above this Mac decides (the row's own
 * toggle stays this Mac's): "Off in this workspace (set in acme/web …)".
 * `null` when this Mac's switch is the answer.
 */
export function plyRowNote(name: string, sw: PlySkillSwitch | null, place: PlyPlace | null | undefined): string | null {
  if (!sw || !place) return null;
  switch (sw.level) {
    case "workspace":
      return `${sw.on ? "On" : "Off"} in this workspace (${setIn(place)}).`;
    case "fork":
      return `Off in this workspace: ${place.repository ?? "this repository"} has its own ${name}, personalized from Plyloft.`;
    case "team":
      // The team default reaches wherever the team library does: every
      // workspace on this Mac, shared or not (walk, 2026-10-20).
      return machineWords(`Off for the team${place.team?.owner ? ` — set by ${place.team.owner}` : ""}, in every workspace on this Mac.`);
    default:
      return null;
  }
}

/**
 * Mac re-walk, 2026-10-20: a Plyloft row's toggle is this Mac's switch, and
 * stays so. When a level above it decides the other way here (a fork, the
 * workspace, the team), the row says what the toggle is — `null` otherwise.
 */
export function plyMacSwitchNote(sw: PlySkillSwitch | null | undefined): string | null {
  if (!sw || sw.level === "mac" || sw.level === "default" || sw.on === sw.macOn) return null;
  return machineWords(
    `The switch is this Mac's own (${sw.macOn ? "on" : "off"}); in this workspace the line above decides.`,
  );
}

/** Whether a Plyloft row's toggle (this Mac's) is overruled here. */
export function plyMacSwitchOverruled(sw: PlySkillSwitch | null | undefined): boolean {
  return plyMacSwitchNote(sw) !== null;
}

/** The status line (page and row): what a session gets, by the CLIs it reaches. */
export function plyStatusFor(
  claude: boolean,
  codex: boolean,
  sw: PlySkillSwitch | null,
  macOn: boolean,
  name: string,
  place: PlyPlace | null | undefined,
): string {
  const on = sw ? sw.on : macOn;
  if (!on) {
    switch (sw?.level) {
      case "workspace":
        return "Comes with Plyloft · switched off in this workspace, so no tile, card or run here gets it.";
      case "fork":
        return `Comes with Plyloft · this repository has its own ${name}, so no tile, card or run here gets Plyloft's.`;
      case "team":
        return machineWords(
          `Comes with Plyloft · switched off for the team${place?.team?.owner ? ` by ${place.team.owner}` : ""}, so no tile, card or run in any workspace on this Mac gets it.`,
        );
      default:
        return machineWords("Comes with Plyloft · switched off on this Mac, so no tile, card or run gets it.");
    }
  }
  const here = sw && sw.level === "workspace" ? " here" : "";
  if (claude && codex) return `Comes with Plyloft · every Claude and Codex tile, card and run Plyloft opens${here} gets it.`;
  if (claude) return `Comes with Plyloft · every Claude tile, card and run Plyloft opens${here} gets it.`;
  if (codex) return `Comes with Plyloft · every Codex tile, card and run Plyloft opens${here} gets it.`;
  return "Comes with Plyloft.";
}

/** The `Where it's on` section's rows (mockup 7, reworded per Q27). */
export interface PlySwitchRows {
  /** `In acme-web: off`. */
  count: string;
  note: string;
  workspace: { label: string; hint: string; choice: "follow" | "on" | "off"; disabled: boolean };
  team: { label: string; hint: string; off: boolean; canSet: boolean } | null;
  mac: { label: string; hint: string; on: boolean };
}

export const PLY_WHERE_TITLE = "Where it's on";
export const PLY_WHERE_NOTE = machineWords(
  "The workspace's choice wins, then the team's, then this Mac's. A change reaches the next session; one already open keeps what it started with.",
);

export function plySwitchRows(name: string, sw: PlySkillSwitch, place: PlyPlace): PlySwitchRows {
  const where = place.repository ?? "this repository";
  let workspaceHint: string;
  if (sw.workspace === false) {
    workspaceHint = `Off — ${setIn(place)}.`;
  } else if (sw.workspace === true) {
    workspaceHint = `On — ${setIn(place)}.`;
  } else if (sw.fork) {
    workspaceHint = `Off — ${where} has its own ${name}, personalized from Plyloft. Choose On to use both.`;
  } else {
    workspaceHint = "No choice here — follows the team, then this Mac.";
  }
  if (place.shared) {
    workspaceHint += place.readOnly
      ? ` Only people who can push to ${where} change it.`
      : ` A choice here reaches everyone who opens ${where}.`;
  }
  const team = place.team;
  const owner = team?.owner ?? null;
  return {
    count: `In ${place.workspaceName}: ${sw.on ? "on" : "off"}`,
    note: PLY_WHERE_NOTE,
    workspace: {
      label: `In ${place.workspaceName}`,
      hint: machineWords(workspaceHint),
      choice: sw.workspace === true ? "on" : sw.workspace === false ? "off" : "follow",
      disabled: place.shared && place.readOnly,
    },
    team: team
      ? {
          label: `${team.name}'s team default`,
          hint: machineWords(
            sw.teamOff
              ? `Off — set${owner ? ` by ${owner}` : ""} for the team, in every workspace on this Mac.${team.youOwn ? "" : owner ? ` Only ${owner} can change it.` : ""}`
              : `No team choice — follows this Mac.${
                  team.youOwn
                    ? " Switch it off to take it out of every workspace's sessions on each teammate's Mac."
                    : owner
                      ? ` Only ${owner} can switch it off for the team.`
                      : ""
                }`,
          ),
          off: sw.teamOff,
          canSet: team.youOwn,
        }
      : null,
    mac: {
      label: machineWords("On this Mac"),
      hint: `${sw.macOn ? "On" : "Off"} — used where neither the workspace nor the team decides.`,
      on: sw.macOn,
    },
  };
}

/** The owner-only words a member reads when they press the team default
 *  (the backend says the same, `ply_skill_ipc::owner_only_words`). */
export function ownerOnlyWords(name: string, owner: string | null): string {
  return owner
    ? `Only ${owner} can switch Plyloft's ${name} off for the team.`
    : `The team names no owner, so nobody can switch Plyloft's ${name} off for the team yet.`;
}

/** Personalize's two places (the sheet's choices). */
export function personalizeChoices(
  name: string,
  place: PlyPlace | null | undefined,
  solo: boolean,
): { id: "repository" | "team"; label: string; hint: string }[] {
  const repo = place?.repository ?? "this repository";
  const out: { id: "repository" | "team"; label: string; hint: string }[] = [
    {
      id: "repository",
      label: "This repository",
      hint:
        `A card adds your own ${name} to ${repo}. Once it ships, sessions in a copy of the repository that has it ` +
        `use yours instead of Plyloft's; other workspaces keep Plyloft's.`,
    },
  ];
  const team = place?.team;
  if (team && !solo) {
    out.push({
      id: "team",
      label: "The team library",
      hint: team.youOwn
        ? `Your ${name} goes into ${team.name}'s library, and Plyloft's is switched off for the team.`
        : `Your ${name} goes into ${team.name}'s library. ${ownerOnlyWords(name, team.owner)} ` +
          "Your fork reaches sessions next to it until then.",
    });
  }
  return out;
}

/** The sentence **Ask <owner>** copies (R9 edge): no hidden write. */
export function askOwnerSentence(name: string, team: string): string {
  return (
    `Could you switch Plyloft's ${name} off for ${team}? Our own ${name} is in the team library now, ` +
    `so sessions get both until the team default says off (Library › Skills › ${name} › Where it's on).`
  );
}
