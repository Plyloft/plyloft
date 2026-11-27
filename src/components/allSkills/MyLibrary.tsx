import { useEffect, useMemo, useState } from "react";
import {
  Callout,
  CBtn,
  CheckList,
  CheckRow,
  ChoiceList,
  Footnote,
  Section,
  Select,
  StatusLine,
  TextField,
} from "../ux";
import { SetupTerminal } from "../SetupTerminal";
import { ThreeColumns } from "../library/ThreeWayCompareFlow";
import { ScriptApprovalFlow } from "../library/ScriptApprovalFlow";
import { HeldVersion } from "../library/HeldVersion";
import {
  skillsHubInstall,
  myLibraryCreate,
  myLibraryForget,
  myLibraryPublish,
  myLibraryPullNow,
  myLibraryRecreate,
  myLibraryUse,
  type MyLibraryCompare,
  type MyLibrarySource,
  type MyLibraryView,
} from "../../ipc";
import {
  COMPARE_LABELS,
  KEEP_OTHER_LABEL,
  KEEP_THIS_LABEL,
  SHARED_REPOS_NOTICE,
  compareWords,
  createLede,
  emptyLede,
  foundLine,
  goneNotice,
  grantElsewhere,
  isAlreadyALibrary,
  isGrantRefusal,
  publishedToast,
  sectionCount,
  signInNotice,
  statusLine,
  whatReachesWhere,
} from "../../lib/myLibrary";
import type { HubRow } from "../../lib/allSkills";
import { machineWords } from "../../lib/platform";
import { myLibraryNeedsOkLine, waitingAsk, type StrongestAsk } from "../../lib/skillAsks";
import { skillsHubScriptsReview } from "../../ipc";
import { useMyLibrary, startMyLibrarySubscriptions } from "../../store/myLibraryStore";
import { refreshAllSkills, useAllSkills } from "../../store/allSkillsStore";
import { confirmSheet } from "../../store/confirmStore";
import { showPlanRefusal } from "../../store/planPrompts";
import { pushToast } from "../../store/toastStore";
import { useSetupRun } from "../../store/setupRunStore";
import { useKanban } from "../../store/kanbanStore";
import { openCardStep } from "../../store/uiStore";
import { useWorkspaces } from "../../store/workspaceStore";
import { isScriptsWait, skillCardReach } from "../../lib/skillCards";

function message(e: unknown): string {
  return String((e as Error)?.message ?? e);
}

/** The login a sheet acts as first: My library's, else gh's active one. */
function firstAccount(view: MyLibraryView): string | null {
  return view.account ?? view.accounts.find((a) => a.active)?.login ?? view.accounts[0]?.login ?? null;
}

/**
 * Skills hub H10 (R6; mockup `my-library.html`): My library at the top of All
 * skills — *Create My library* (and *Use it on this Mac* when GitHub already
 * has one) on a computer that uses none; when it is used here, when it was
 * last updated, and — the repository gone on GitHub — the last copy keeps
 * serving, with *Create it again*, *Point to another repository…* and *Stop
 * using it on this Mac*. It works on every plan.
 */
export function MyLibraryPanel({ skills }: { skills: number }) {
  const view = useMyLibrary((s) => s.view);
  const sheet = useMyLibrary((s) => s.sheet);
  const found = useMyLibrary((s) => s.found);
  const { setSheet, find, set } = useMyLibrary.getState();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();

  useEffect(() => {
    startMyLibrarySubscriptions();
  }, []);
  const account = view ? firstAccount(view) : null;
  useEffect(() => {
    if (view && !view.repo) void find(account);
  }, [view, account, find]);

  if (!view) return null;
  if (sheet === "create") return <CreateMyLibraryFlow view={view} onDone={() => setSheet(null)} />;
  if (sheet === "use" || sheet === "point") {
    return <UseMyLibraryFlow view={view} pointing={sheet === "point"} suggested={found} onDone={() => setSheet(null)} />;
  }

  async function act(id: string, run: () => Promise<MyLibraryView>, done?: string) {
    setBusy(id);
    setError(null);
    try {
      set(await run());
      if (done) pushToast({ kind: "info", title: done });
      refreshAllSkills();
    } catch (e) {
      if (!showPlanRefusal(e)) setError(message(e));
    } finally {
      setBusy(null);
    }
  }

  if (!view.repo) {
    return (
      <Section title="My library">
        <p className="ux-row-hint">{emptyLede()}</p>
        {found && <StatusLine state="empty">{foundLine(found)}</StatusLine>}
        {error && <StatusLine state="aborted">{error}</StatusLine>}
        <div className="ux-hub-actions">
          {found ? (
            <CBtn
              tone="strong"
              disabled={busy != null}
              onClick={() => void act("use", () => myLibraryUse(found, account), `My library ${found} is on ${machineWords("this Mac")}.`)}
            >
              {busy === "use" ? "Copying…" : machineWords("Use it on this Mac")}
            </CBtn>
          ) : null}
          <CBtn tone={found ? undefined : "strong"} onClick={() => setSheet("create")}>
            Create My library
          </CBtn>
          <CBtn tone="quiet" onClick={() => setSheet("use")}>
            Use one you have…
          </CBtn>
        </div>
      </Section>
    );
  }

  const gone = goneNotice(view, now);
  const signIn = signInNotice(view);
  return (
    <Section title="My library" count={`${view.repo} · ${sectionCount(skills)}`}>
      <StatusLine state={view.lastError && view.lastError !== "held" ? "aborted" : "empty"}>{statusLine(view, now)}</StatusLine>
      {view.plugin !== "mine" && (
        <p className="ux-row-hint">
          {`Your team library already has a skill set called mine, so sessions get My library as ${view.plugin}:<name>.`}
        </p>
      )}
      {gone && (
        <Callout
          kind="warn"
          text={gone}
          actions={
            <>
              <CBtn
                tone="strong"
                disabled={busy != null}
                onClick={() => void act("recreate", myLibraryRecreate, `My library ${view.repo} is on GitHub again.`)}
              >
                {busy === "recreate" ? "Creating…" : "Create it again"}
              </CBtn>
              <CBtn onClick={() => setSheet("point")}>
                Point to another repository…
              </CBtn>
              <StopUsing busy={busy} onStop={() => void act("forget", myLibraryForget)} />
            </>
          }
        />
      )}
      {signIn && <p className="ux-row-hint">{signIn}</p>}
      {error && <StatusLine state="aborted">{error}</StatusLine>}
      {!gone && (
        <div className="ux-hub-actions">
          <CBtn size="sm" disabled={busy != null} onClick={() => void act("pull", myLibraryPullNow)}>
            {busy === "pull" ? "Reading…" : "Read it again"}
          </CBtn>
          <StopUsing busy={busy} onStop={() => void act("forget", myLibraryForget)} />
        </div>
      )}
    </Section>
  );
}

function StopUsing({ busy, onStop }: { busy: string | null; onStop: () => void }) {
  return (
    <CBtn
      size="sm"
      tone="quiet"
      disabled={busy != null}
      onClick={() =>
        void confirmSheet({
          title: machineWords("Stop using My library on this Mac?"),
          body: machineWords(
            "Its copy on this Mac goes to the Trash, and new sessions here get no mine: skills. My library stays on GitHub, and copies of its skills in your repositories stay as they are.",
          ),
          confirmLabel: "Stop using it",
          destructive: true,
        }).then((yes) => yes && onStop())
      }
    >
      {busy === "forget" ? "Stopping…" : machineWords("Stop using it on this Mac")}
    </CBtn>
  );
}

/** The account choice, when gh has more than one signed in (§5.3: My
 *  library runs as the account that owns it). */
function AccountSelect({ view, value, onChange }: { view: MyLibraryView; value: string | null; onChange: (login: string) => void }) {
  if (view.accounts.length < 2) return null;
  return (
    <Select
      label="GitHub account"
      value={value ?? ""}
      onChange={onChange}
      options={view.accounts.map((a) => ({ value: a.login, label: a.active ? `${a.login} (active)` : a.login }))}
    />
  );
}

/** *Grant it*: gh's own permission refresh in the guided terminal. */
function GrantIt() {
  const run = useSetupRun((s) => s.run);
  const start = useSetupRun((s) => s.start);
  return (
    <>
      <CBtn tone="strong" onClick={() => void start("refresh.gh")}>
        Grant it
      </CBtn>
      {run?.actionId === "refresh.gh" && <SetupTerminal />}
    </>
  );
}

/** Mockup 6a: the create sheet. */
export function CreateMyLibraryFlow({ view, onDone }: { view: MyLibraryView; onDone: () => void }) {
  const thisMac = useAllSkills((s) => s.index.thisMac?.rows);
  const names = useMemo(() => (thisMac ?? []).map((r) => r.name).sort(), [thisMac]);
  const [name, setName] = useState(view.defaultName);
  const [account, setAccount] = useState<string | null>(firstAccount(view));
  const [start, setStart] = useState<"empty" | "thisMac">("empty");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seed = start === "thisMac" ? picked : [];
  const set = useMyLibrary((s) => s.set);
  const setSheet = useMyLibrary((s) => s.setSheet);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const next = await myLibraryCreate(name.trim(), account, seed);
      set(next);
      pushToast({ kind: "info", title: `My library is on GitHub: ${next.repo} (private).` });
      refreshAllSkills();
      onDone();
    } catch (e) {
      if (!showPlanRefusal(e)) setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function useIt() {
    setBusy(true);
    setError(null);
    try {
      set(await myLibraryUse(`${account ?? ""}/${name.trim()}`, account));
      refreshAllSkills();
      onDone();
    } catch (e) {
      if (!showPlanRefusal(e)) setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ux-flow">
      <p className="ux-flow-eyebrow">My library · 1 step</p>
      <h2 className="ux-flow-title">Create My library</h2>
      <p className="ux-page-lede">{createLede(account, name.trim())}</p>
      <AccountSelect view={view} value={account} onChange={setAccount} />
      <TextField label="Repository name" mono value={name} onChange={setName} disabled={busy} />
      <p className="ux-row-hint">
        {`${account ?? "<your account>"}/${name.trim() || view.defaultName} · Private. You can rename it; Plyloft only needs the library layout inside.`}
      </p>
      <ChoiceList
        value={start}
        onChange={setStart}
        label="What it starts with"
        options={[
          { value: "empty", label: "Start empty", hint: "Add skills later, from any skill's page in All skills." },
          {
            value: "thisMac",
            label: machineWords("Start with skills from this Mac"),
            hint: machineWords("Copies the ones you pick. Your folders on this Mac stay as they are."),
            disabled: names.length === 0,
          },
        ]}
      />
      {start === "thisMac" && (
        <CheckList label={machineWords("Skills from this Mac")}>
          {names.map((n) => (
            <CheckRow
              key={n}
              checked={picked.includes(n)}
              onChange={(on) => setPicked((p) => (on ? [...p, n] : p.filter((x) => x !== n)))}
            >
              {n}
            </CheckRow>
          ))}
        </CheckList>
      )}
      <StatusLine state="empty">{whatReachesWhere(seed)}</StatusLine>
      <Footnote>{SHARED_REPOS_NOTICE}</Footnote>
      {error && <StatusLine state="aborted">{error}</StatusLine>}
      {error && isGrantRefusal(error) && grantElsewhere(view, account) && (
        <p className="ux-row-hint">{grantElsewhere(view, account)}</p>
      )}
      <div className="ux-flow-actions">
        <CBtn tone="quiet" onClick={() => { setSheet(null); onDone(); }} disabled={busy}>
          Cancel
        </CBtn>
        {error && isGrantRefusal(error) && !grantElsewhere(view, account) && <GrantIt />}
        {error && isAlreadyALibrary(error) && (
          <CBtn onClick={() => void useIt()} disabled={busy}>
            {machineWords("Use it on this Mac")}
          </CBtn>
        )}
        <CBtn tone="accent" onClick={() => void create()} disabled={busy || !name.trim()}>
          {busy ? "Creating…" : "Create on GitHub"}
        </CBtn>
      </div>
    </div>
  );
}

/** *Use one you have…* and *Point to another repository…*. */
function UseMyLibraryFlow({
  view,
  pointing,
  suggested,
  onDone,
}: {
  view: MyLibraryView;
  pointing: boolean;
  suggested: string | null;
  onDone: () => void;
}) {
  const [account, setAccount] = useState<string | null>(firstAccount(view));
  const [repo, setRepo] = useState(suggested ?? `${firstAccount(view) ?? ""}/${view.defaultName}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = useMyLibrary((s) => s.set);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      set(await myLibraryUse(repo.trim(), account));
      refreshAllSkills();
      onDone();
    } catch (e) {
      if (!showPlanRefusal(e)) setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ux-flow">
      <p className="ux-flow-eyebrow">My library</p>
      <h2 className="ux-flow-title">{pointing ? "Point to another repository" : machineWords("Use My library on this Mac")}</h2>
      <p className="ux-page-lede">
        {pointing
          ? machineWords("Your sessions on this Mac get the skills of the repository you name from the next session. The copy of the old one goes to the Trash.")
          : machineWords("Name the private repository My library is in. Plyloft copies it to this Mac; your sessions here get its skills from the next session.")}
      </p>
      <AccountSelect view={view} value={account} onChange={setAccount} />
      <TextField label="Repository" mono value={repo} onChange={setRepo} disabled={busy} placeholder="owner/name" />
      {error && <StatusLine state="aborted">{error}</StatusLine>}
      <div className="ux-flow-actions">
        <CBtn tone="quiet" onClick={onDone} disabled={busy}>
          Cancel
        </CBtn>
        <CBtn tone="accent" onClick={() => void go()} disabled={busy || !repo.includes("/")}>
          {busy ? "Copying…" : pointing ? "Point to it" : machineWords("Use it on this Mac")}
        </CBtn>
      </div>
    </div>
  );
}

function compareStatus(status: string): string {
  switch (status) {
    case "both":
      return "both";
    case "here":
      return machineWords("only this Mac");
    case "upstream":
      return "only the other computer";
    case "same":
      return "same change on both";
    default:
      return "differs";
  }
}

/** §14 Q4: the two-computer compare — before, the other computer's, this
 *  Mac's — and the two answers. */
export function MyLibraryCompareFlow({
  compare,
  busy,
  onHide,
  onChoose,
}: {
  compare: MyLibraryCompare;
  busy: boolean;
  onHide: () => void;
  onChoose: (choice: "keepThis" | "keepOther") => void;
}) {
  const [file, setFile] = useState<string | null>(null);
  const [choice, setChoice] = useState<"keepThis" | "keepOther">("keepThis");
  const words = compareWords(compare, Date.now());
  const shown = compare.files.find((f) => f.path === file) ?? compare.files[0];
  const labels = {
    baseLabel: compare.twoWay ? null : "the version both started from",
    upstreamLabel: COMPARE_LABELS.other,
    hereLabel: COMPARE_LABELS.here,
  };
  return (
    <div className="ux-flow ux-flow--wide">
      <p className="ux-flow-eyebrow">Compare · {compare.skill}</p>
      <h2 className="ux-flow-title">{words.title}</h2>
      <p className="ux-page-lede">{words.lede}</p>
      {compare.twoWay && (
        <p className="ux-card-muted">{machineWords("This Mac has no version both started from, so this compare shows two sides.")}</p>
      )}
      <div className="ux-compare-files" role="list" aria-label={`Files of ${compare.skill} that differ`}>
        {compare.files.map((f) => (
          <button
            key={f.path}
            type="button"
            role="listitem"
            className={f.path === shown?.path ? "ux-compare-file ux-compare-file--on" : "ux-compare-file"}
            aria-current={f.path === shown?.path ? "true" : undefined}
            onClick={() => setFile(f.path)}
          >
            <span className="ux-mono-fg">{f.path}</span>
            <span className="cchip cchip--outline">{compareStatus(f.status)}</span>
          </button>
        ))}
      </div>
      {shown && <ThreeColumns compare={labels} file={shown} />}
      <ChoiceList
        value={choice}
        onChange={setChoice}
        label={`What My library keeps of ${compare.skill}`}
        options={[
          {
            value: "keepThis",
            label: KEEP_THIS_LABEL,
            hint: machineWords("My library takes this Mac's version; the other computer's next sessions get it. Its version stays in My library's history."),
          },
          {
            value: "keepOther",
            label: KEEP_OTHER_LABEL,
            hint: machineWords("My library stays as the other computer left it, and this Mac's sessions get that version. Your copy on this Mac stays as it is."),
          },
        ]}
      />
      <div className="ux-flow-actions">
        <CBtn tone="quiet" onClick={onHide} disabled={busy}>
          Close
        </CBtn>
        <CBtn tone="accent" onClick={() => onChoose(choice)} disabled={busy}>
          {busy ? "Publishing…" : choice === "keepThis" ? KEEP_THIS_LABEL : KEEP_OTHER_LABEL}
        </CBtn>
      </div>
    </div>
  );
}

/** The source *Add to My library* publishes from, for a hub row. */
export function publishSource(row: HubRow): MyLibrarySource | null {
  if (row.placeholder || row.missing) return null;
  if (row.scope === "thisMac") return { kind: "thisMac", skill: row.name };
  if (row.scope === "repository" && row.workspaceId && !row.branchOnly) {
    return { kind: "repository", workspaceId: row.workspaceId, skill: row.name };
  }
  return null;
}

/**
 * *Add to My library* (Promote → My library) on a skill's hub page: publish,
 * or — the other computer changed it since this one last did — the compare.
 * A My library row whose scripts wait for this computer's OK gets *Review*.
 */
export function MyLibrarySkillActions({ row, onBack }: { row: HubRow; onBack: () => void }) {
  const view = useMyLibrary((s) => s.view);
  const setSheet = useMyLibrary((s) => s.setSheet);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compare, setCompare] = useState<MyLibraryCompare | null>(null);
  const [reviewing, setReviewing] = useState(false);
  useEffect(() => {
    startMyLibrarySubscriptions();
  }, []);
  // 1.175.0 B1: what waits for the OK — a script, or what the skill's text
  // asks for — read from the sheet's own review, so the row and the sheet agree.
  const [waits, setWaits] = useState<StrongestAsk | null | undefined>(undefined);
  const waiting = row.scope === "myLibrary" && row.needsOk;
  const waitingPlugin = row.plugin ?? "mine";
  useEffect(() => {
    if (!waiting) return;
    let current = true;
    setWaits(undefined);
    skillsHubScriptsReview(waitingPlugin, row.name, "mine")
      .then((review) => current && setWaits(waitingAsk(review)))
      .catch(() => current && setWaits(null));
    return () => {
      current = false;
    };
  }, [waiting, waitingPlugin, row.name]);
  const source = publishSource(row);

  if (row.scope === "myLibrary" && !row.needsOk) {
    return <InstallFromMyLibrary row={row} />;
  }
  if (row.scope === "myLibrary" && row.needsOk) {
    if (reviewing) {
      return (
        <ScriptApprovalFlow
          plugin={row.plugin ?? "mine"}
          skill={row.name}
          library="mine"
          onDone={() => {
            setReviewing(false);
            refreshAllSkills();
          }}
          onCancel={() => setReviewing(false)}
        />
      );
    }
    return (
      <div className="ux-hub-actions">
        <StatusLine state="empty">{machineWords(myLibraryNeedsOkLine(waits))}</StatusLine>
        <HeldVersion plugin={row.plugin ?? "mine"} skill={row.name} library="mine" />
        <CBtn tone="strong" onClick={() => setReviewing(true)}>
          Review
        </CBtn>
      </div>
    );
  }
  if (!source || !view) return null;
  const plugin = view.plugin;

  async function publish(choice?: "keepThis" | "keepOther") {
    if (!source) return;
    setBusy(true);
    setError(null);
    try {
      const out = await myLibraryPublish(source, choice, choice ? compare?.otherId : undefined);
      const words = out.kind === "compare" ? null : publishedToast(out, plugin);
      const windows = out.kind === "published" ? out.windows ?? undefined : undefined;
      // 1.176.4: earlier kept commits set aside on the way lead the one
      // toast, with what this press did under them.
      if (out.setAside) {
        pushToast({ kind: "warn", title: out.setAside, body: [words, windows].filter(Boolean).join(" ") || undefined });
      } else if (words) {
        pushToast({ kind: "info", title: words, body: windows });
      }
      if (out.kind === "compare") {
        setCompare(out.compare);
        return;
      }
      setCompare(null);
      refreshAllSkills();
    } catch (e) {
      if (!showPlanRefusal(e)) setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  if (compare) {
    return (
      <MyLibraryCompareFlow
        compare={compare}
        busy={busy}
        onHide={() => setCompare(null)}
        onChoose={(choice) => void publish(choice)}
      />
    );
  }
  if (!view.repo) {
    return (
      <div className="ux-hub-actions">
        <CBtn
          onClick={() => {
            onBack();
            setSheet("create");
          }}
        >
          Create My library to add it
        </CBtn>
      </div>
    );
  }
  return (
    <div className="ux-hub-actions">
      <CBtn onClick={() => void publish()} disabled={busy || !view.hasClone}>
        {busy ? "Adding…" : "Add to My library"}
      </CBtn>
      {error && <StatusLine state="aborted">{error}</StatusLine>}
    </div>
  );
}

/**
 * R6 AC: a My library skill installed into a repository is a linked copy
 * (origin `library`), through a skill card like a team skill's Install —
 * into the workspace open now. A script it brings is shown first.
 */
function InstallFromMyLibrary({ row }: { row: HubRow }) {
  const activeId = useWorkspaces((s) => s.activeId);
  const workspaceName = useWorkspaces((s) => s.workspaces.find((w) => w.id === s.activeId)?.name ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const plugin = row.plugin ?? "mine";
  if (!activeId || !workspaceName) return null;
  const workspaceId = activeId;

  async function perform(scriptsOk?: string[]) {
    const done = await skillsHubInstall(workspaceId, plugin, row.name, false, scriptsOk, "mine");
    if (done.kind === "written") {
      pushToast({ kind: "info", title: `${row.name} installed in ${workspaceName}` });
      return;
    }
    await useKanban.getState().loadFromDisk(workspaceId, true);
    // QoL 13.4 (G12): Install stays where it was pressed; the card opens
    // from the toast.
    const card = done.card;
    pushToast({
      kind: "info",
      title: `Card made: ${card.title}`,
      body: skillCardReach(card),
      action: { label: "Open card", onClick: () => openCardStep(workspaceId, card.id, "outcome") },
    });
  }

  async function install() {
    setBusy(true);
    setError(null);
    try {
      await perform();
      refreshAllSkills();
    } catch (e) {
      if (isScriptsWait(message(e))) setSheet(true);
      else if (!showPlanRefusal(e)) setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  if (sheet) {
    return (
      <ScriptApprovalFlow
        plugin={plugin}
        skill={row.name}
        library="mine"
        install={{ workspaceId, verb: "install", onConfirm: (ids) => perform(ids) }}
        onDone={() => {
          setSheet(false);
          refreshAllSkills();
        }}
        onCancel={() => setSheet(false)}
      />
    );
  }
  return (
    <div className="ux-hub-actions">
      <CBtn onClick={() => void install()} disabled={busy}>
        {busy ? "Making the card…" : `Install in ${workspaceName}`}
      </CBtn>
      {error && <StatusLine state="aborted">{error}</StatusLine>}
    </div>
  );
}
