import { useEffect, useState } from "react";
import { CBtn, Group, Row, Section, Select, type SelectOption } from "../ux";
import {
  githubAccountWorkspaces,
  workspaceSetGithubAccount,
  type GithubAccount,
  type GithubStatus,
  type WorkspaceGithub,
} from "../../ipc";
import { accountRow } from "../../lib/githubStep";
import { useGithubStatus } from "../../store/githubStatusStore";
import { useSetup } from "../../store/setupStore";
import { useWorkspaces } from "../../store/workspaceStore";
import { pushErrorToast } from "../../lib/errorToast";

/** The select's value for "gh's active account" (`githubAccount` unset). */
export const ACTIVE_ACCOUNT = "";

/** OB-7b / OB-12: only several github.com accounts ask which one a workspace
 *  uses; with one (or none) nothing extra is shown — today's behaviour. */
export function accountChoiceNeeded(status: GithubStatus | null): boolean {
  return (status?.accounts?.length ?? 0) > 1;
}

/** The choices for one workspace: gh's active account, then each account,
 *  and — when the workspace names a login gh no longer lists — that login,
 *  so the select still says what is stored. */
export function accountOptions(accounts: readonly GithubAccount[], current: string | null): SelectOption[] {
  const active = accounts.find((a) => a.active);
  const options: SelectOption[] = [
    { value: ACTIVE_ACCOUNT, label: active ? `Active account (${active.login})` : "Active account" },
    ...accounts.map((a) => ({
      value: a.login,
      label: a.state === "refused" ? `${a.login} (signed out)` : a.login,
    })),
  ];
  if (current && !accounts.some((a) => a.login.toLowerCase() === current.toLowerCase())) {
    options.push({ value: current, label: `${current} (not signed in)` });
  }
  return options;
}

/** The row's hint: the repository, and what the choice covers. */
export function workspaceHint(ws: WorkspaceGithub, accounts: readonly GithubAccount[]): string {
  const missing =
    ws.account !== null && !accounts.some((a) => a.login.toLowerCase() === ws.account!.toLowerCase());
  if (missing) {
    return `${ws.repo} · ${ws.account} isn't signed in on this computer, so its GitHub calls stop. Pick another account or sign it in again.`;
  }
  if (ws.ssh) {
    return `${ws.repo} · Pushes and fetches use your SSH keys; Plyloft's other GitHub calls use this account.`;
  }
  return ws.repo;
}

/**
 * OB-7b (ONBOARDING_SPEC §5 step 5 "Several accounts", §9.2 "GitHub
 * accounts"): Settings › Setup and account › Setup › Account for each project (the summary row "GitHub accounts" above it adds accounts). gh's accounts,
 * and per workspace whose origin is on GitHub which one Plyloft's own GitHub
 * calls use (Ship as a PR, GitHub Issues, fetches and pushes) — written as
 * `Workspace.githubAccount` through `workspace_set_github_account`. Agent
 * terminals never get it (D7): an agent typing `gh` uses the active account.
 *
 * Nothing is drawn while gh lists one account or none.
 */
export function GitHubAccountsSection() {
  const status = useGithubStatus((s) => s.status);
  const [rows, setRows] = useState<WorkspaceGithub[] | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  // 1.176.2 (E1): a read that failed is not "no project is on GitHub".
  const [readFailed, setReadFailed] = useState(false);
  const [readAgain, setReadAgain] = useState(0);
  const several = accountChoiceNeeded(status);

  useEffect(() => {
    void useGithubStatus.getState().refresh();
  }, []);

  useEffect(() => {
    if (!several) return;
    let live = true;
    githubAccountWorkspaces()
      .then((list) => {
        if (!live) return;
        setReadFailed(false);
        setRows(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!live) return;
        setReadFailed(true);
        setRows([]);
      });
    return () => {
      live = false;
    };
  }, [several, readAgain]);

  if (!several || !status?.accounts) return null;
  const accounts = status.accounts;

  async function choose(ws: WorkspaceGithub, value: string) {
    const login = value === ACTIVE_ACCOUNT ? null : value;
    setSaving(ws.id);
    try {
      await workspaceSetGithubAccount(ws.id, login);
      setRows((cur) => cur?.map((r) => (r.id === ws.id ? { ...r, account: login } : r)) ?? cur);
      void useWorkspaces.getState().refresh();
    } catch (e) {
      pushErrorToast(`Couldn't change ${ws.name}'s GitHub account`, e);
    } finally {
      setSaving(null);
    }
  }

  return (
    <Section title="Account for each project" scope="this-mac">
      <Group>
        <Row
          kind="value"
          label="Accounts"
          hint={accountRow(status).hint}
          action={
            <CBtn onClick={() => useSetup.getState().openSetup("rerun", "github")}>
              Add another account
            </CBtn>
          }
        />
      </Group>
      <Group label="Workspaces">
        {rows === null ? (
          <Row kind="value" label="Workspaces" hint="Looking…" />
        ) : readFailed ? (
          <Row
            kind="value"
            label="Workspaces"
            hint="Plyloft couldn't read your projects' GitHub accounts."
            action={
              <CBtn
                tone="quiet"
                onClick={() => {
                  setRows(null);
                  setReadAgain((n) => n + 1);
                }}
              >
                Read it again
              </CBtn>
            }
          />
        ) : rows.length === 0 ? (
          <Row kind="value" label="Workspaces" hint="No project is on GitHub yet." />
        ) : (
          rows.map((ws) => (
            <Row key={ws.id} kind="choice" label={ws.name} hint={workspaceHint(ws, accounts)}>
              <Select
                value={ws.account ?? ACTIVE_ACCOUNT}
                options={accountOptions(accounts, ws.account)}
                disabled={saving === ws.id}
                label={`GitHub account for ${ws.name}`}
                onChange={(next) => void choose(ws, next)}
              />
            </Row>
          ))
        )}
      </Group>
    </Section>
  );
}
