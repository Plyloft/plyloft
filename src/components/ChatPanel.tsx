import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import {
  onChatMessages,
  onChatState,
  type ChatAttachment,
  type ChatVendor,
} from "../ipc";
import { exchangeOpen, PLAN_TWO_AIS_LABEL } from "../lib/planExchangeView";
import { formRequestFresh, usePlanExchange } from "../store/planExchangeStore";
import { ChatItem } from "./ChatThread";
import { PlanExchangePanel, type PlanContext } from "./PlanExchangePanel";
import { chatKey, EMPTY_CONVERSATION, useChat } from "../store/chatStore";
import {
  answerAnnouncement,
  attachmentAddedWords,
  attachmentFacts,
  attachmentLabels,
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_FILES_LINE,
  chatBuilderLine,
  chatScopeLine,
  CHAT_VENDORS,
  chatRefusedWords,
  chatStatusWords,
  chatTokenLine,
  chatVendorName,
  composerOpen,
  pastedFileName,
  pastedFilesToAttach,
  removeAttachmentTitle,
  repeatedNames,
  CHAT_ATTACHMENT_LIMITS,
  CHAT_ATTACHMENT_ACCEPT,
  stopOffered,
  TELL_BUILDER_LABEL,
  lastPersonMessage,
  tellBuilderPress,
  tellBuilderTitle,
  tooLargeReason,
  vendorSwitchOpen,
  type ChatBuilderReach,
} from "../lib/chatView";
import { CARD_CHAT_DROP_KINDS, acceptsAttr, acceptsDrag } from "../lib/dropGuard";
import { IncompleteDropError, dropRefusalWords, readDroppedFile } from "../lib/droppedFile";
import { isFolderTrustRefusal } from "../lib/claudeReviewTrust";
import { isMac, machineWords } from "../lib/platform";
import { ClaudeReviewTrustStep } from "./ClaudeReviewTrust";
import { ChatTerminal } from "./ChatTerminal";
import { Callout, CBtn, CIcon, Details, FailureText, FilePickButton, RepairFor, Segmented } from "./ux";
import { failureWith, plainFailure } from "../lib/plainError";
import { backendMarkTool } from "../lib/backendMarks";
import { failure, type Failure } from "../lib/failure";

/** 1.174.0 E10: what the Chat tab is used for — an AI to ask, or the plan. */
type ChatChoice = ChatVendor | "plan";

/** Block 8 (Challenger M3): the raw text, when there is one, behind Details. */
type Refusal = { key: string; name: string; reason: string; details?: string };
type Pending = { key: string; name: string };

const EMPTY_ATTACHMENTS: ChatAttachment[] = [];
const EMPTY_IDS: string[] = [];

/**
 * Card chat (part 2): the card's Chat tab. A plain conversation about the
 * card with Claude or Codex — discussion only: neither can change anything
 * from here. One conversation per vendor (the picker switches, both
 * histories stay); one live session per card.
 *
 * Mounted once the tab was first opened and kept mounted (the card page's
 * sections hide, never unmount); keyed by card. `chat://state` and
 * `chat://messages` for this card are folded into `chatStore`.
 */
export function ChatPanel({
  workspaceId,
  cardId,
  plan,
  pullRequest = null,
  builder,
}: {
  workspaceId: string;
  cardId: string;
  /** 1.171.0 (E1): the card's Builder — the vendor a chat that never chose
   *  one opens on, where the Builder stands (the line above the field), and
   *  Send to the Builder's send (the result's Not right path). */
  builder?: {
    vendor: ChatVendor;
    reach: ChatBuilderReach;
    tell?: (text: string) => Promise<"sent" | "failed">;
  };
  /** A pull request's card: the scope line says whose it is (walk of #386). */
  pullRequest?: { pushable: boolean; fixNote?: string | null } | null;
  /** Plan with two AIs: the card page's context. Without it the tab is the
   *  Chat alone (no switch, no plan reads). */
  plan?: PlanContext;
}) {
  const key = chatKey(workspaceId, cardId);
  const planView = usePlanExchange((s) => s.byKey[key]);
  const planRequest = usePlanExchange((s) => s.formRequests[key] ?? 0);
  const current = planView?.snapshot?.current ?? null;
  const planHolds = exchangeOpen(current) || current?.status === "paused";
  const earlierPlans = (planView?.snapshot?.earlier.length ?? 0) > 0;
  const switchShown = plan != null && (plan.offered || planHolds || earlierPlans);
  const [mode, setMode] = useState<"chat" | "plan">("chat");
  // An exchange under way, or the card page's Plan with two AIs: Plan.
  useEffect(() => {
    if (planHolds) setMode("plan");
  }, [planHolds, current?.id]);
  useEffect(() => {
    if (plan && formRequestFresh(planRequest)) setMode("plan");
    // A request is followed when it comes (or just before this mounts).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planRequest]);
  useEffect(() => {
    if (!plan) return;
    void usePlanExchange.getState().load(workspaceId, cardId).catch(() => {});
    // Read once per card; `plan://` events keep it current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, cardId, plan != null]);
  const planRunning = current?.status === "running";
  const view = useChat((s) => s.byKey[key]);
  const vendor: ChatVendor = view?.vendor ?? builder?.vendor ?? "claude";
  const conversation = view?.conversations[vendor] ?? EMPTY_CONVERSATION;
  const attachments = view?.attachments ?? EMPTY_ATTACHMENTS;
  const pendingIds = view?.pendingIds ?? EMPTY_IDS;
  const draft = view?.drafts[view.vendor] ?? "";
  const { status, reason, attention, ptyId, messages, usage } = conversation;
  /** F10 round 2: what Send to the Builder puts back with the field
   *  empty — the person's own last message, sent from here with Send or
   *  (walk 4.8) with Send to the Builder. */
  const lastSaid = view?.lastSaid ?? lastPersonMessage(messages, view?.typedIds ?? []);
  const name = chatVendorName(vendor);

  const [loadError, setLoadError] = useState<Failure | null>(null);
  // QoL 1.168 block 8 (A5): plain words, the raw text behind Details.
  const [actionError, setActionError] = useState<Failure | null>(null);
  const [sending, setSending] = useState(false);
  const [telling, setTelling] = useState(false);
  /** The last send was refused: the state line says so, not "ready". */
  const [refused, setRefused] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [uploads, setUploads] = useState<Pending[]>([]);
  const [refusals, setRefusals] = useState<Refusal[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [terminalShown, setTerminalShown] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const logRef = useRef<HTMLOListElement | null>(null);
  const terminalId = `chat-terminal-${cardId}`;
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  // Read the chat, and follow it.
  useEffect(() => {
    let cancelled = false;
    const unlisten: Array<() => void> = [];
    const mine = (e: { workspaceId: string; cardId: string }) => e.workspaceId === workspaceId && e.cardId === cardId;
    void (async () => {
      const offState = await onChatState((e) => {
        if (mine(e)) useChat.getState().applyState(e);
      });
      const offMessages = await onChatMessages((e) => {
        if (mine(e)) useChat.getState().applyMessages(e);
      });
      if (cancelled) {
        offState();
        offMessages();
        return;
      }
      unlisten.push(offState, offMessages);
      try {
        await useChat.getState().load(workspaceId, cardId, builder?.vendor);
      } catch (e) {
        if (!cancelled) setLoadError(failure("Plyloft couldn't load this card's chat. Close the card and open it again.", e));
      }
    })();
    return () => {
      cancelled = true;
      unlisten.forEach((off) => off());
    };
  }, [workspaceId, cardId]);

  // A screen-reader line for each answer that finishes while the tab is
  // open; the history already there when a conversation loads is not read.
  const announced = useRef<Map<ChatVendor, Set<string>>>(new Map());
  // The other vendor's last answer is not read again after a switch.
  useEffect(() => setAnnouncement(""), [vendor]);
  useEffect(() => {
    if (!view?.loaded) return;
    let seen = announced.current.get(vendor);
    const done = messages.filter((m) => m.role === "assistant" && m.done);
    if (!seen) {
      announced.current.set(vendor, new Set(done.map((m) => m.id)));
      return;
    }
    const fresh = done.filter((m) => !seen.has(m.id));
    fresh.forEach((m) => seen.add(m.id));
    const last = fresh[fresh.length - 1];
    if (last) setAnnouncement(answerAnnouncement(vendor, last.text));
  }, [messages, vendor, view?.loaded]);

  // Follow the conversation — a new message, a streaming answer's growth,
  // an answer's markdown drawn a moment after it lands — only while the
  // member is at its end: scrolled up to read, it stays. It opens at the
  // end. Only a scroll *up* away from the end leaves it: content that grows
  // under a scroll that was at the end (the markdown, drawn lazily) is not
  // the member scrolling away (follow-ups: a reopened chat opened part-way
  // up, and then stopped following).
  const atEnd = useRef(true);
  const lastTop = useRef(0);
  const follow = useCallback(() => {
    const log = logRef.current;
    if (!log || !atEnd.current) return;
    log.scrollTo({ top: log.scrollHeight });
    lastTop.current = log.scrollTop;
  }, []);
  useEffect(() => {
    atEnd.current = true;
  }, [vendor]);
  useEffect(() => follow(), [messages, vendor, follow]);
  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const grew = new MutationObserver(() => follow());
    grew.observe(log, { childList: true, subtree: true, characterData: true });
    const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => follow());
    resized?.observe(log);
    return () => {
      grew.disconnect();
      resized?.disconnect();
    };
  }, [follow]);

  // A new state (or vendor) is news of its own: the refusal no longer is.
  useEffect(() => setRefused(false), [status, vendor]);

  // The terminal goes when its session does.
  useEffect(() => {
    if (!ptyId) setTerminalShown(false);
  }, [ptyId]);

  // The textarea stays editable (a draft can be written during an answer,
  // and focus stays where it is); only Send and Enter wait.
  // A card has one composer: while its exchange runs, the Chat waits (the
  // backend refuses the send too).
  const canWrite = composerOpen(status) && !sending && !switching && !planRunning;
  const hasSomething = draft.trim().length > 0 || pendingIds.length > 0;
  const trustStop = vendor === "claude" && isFolderTrustRefusal(reason);
  const terminalOffered = vendor === "claude" && ptyId != null;

  async function switchVendor(next: ChatVendor) {
    if (next === vendor && view?.opened) return;
    setSwitching(true);
    setActionError(null);
    try {
      await useChat.getState().open(workspaceId, cardId, next);
    } catch (e) {
      setActionError(failureWith(`The chat didn't switch to ${chatVendorName(next)}`, e));
    } finally {
      setSwitching(false);
    }
  }

  async function send() {
    if (!canWrite || !hasSomething || uploads.length > 0) return;
    setSending(true);
    setActionError(null);
    try {
      await useChat.getState().send(workspaceId, cardId);
      setRefused(false);
    } catch (e) {
      setRefused(true);
      setActionError(failureWith("Your message wasn't sent", e));
    } finally {
      setSending(false);
      composerRef.current?.focus();
    }
  }

  /** 1.171.0 (E1): the draft goes to the Builder instead (the store's toast
   *  says how it went); it leaves the field once the Builder has it. */
  async function tellBuilder() {
    const tell = builder?.tell;
    // F10 round 2: the field's text is sent; an empty field gets the
    // person's last message back, never sent by itself.
    const press = tellBuilderPress(draft, lastSaid);
    if (!tell || !press || telling) return;
    if ("fill" in press) {
      useChat.getState().setDraft(workspaceId, cardId, press.fill);
      composerRef.current?.focus();
      return;
    }
    const text = press.send;
    setTelling(true);
    setActionError(null);
    try {
      if ((await tell(text)) === "sent") {
        useChat.getState().told(workspaceId, cardId, text);
        useChat.getState().setDraft(workspaceId, cardId, "");
      }
    } catch (e) {
      setActionError(failureWith("It didn't reach the Builder", e));
    } finally {
      setTelling(false);
    }
  }

  async function stop() {
    setActionError(null);
    try {
      await useChat.getState().interrupt(workspaceId, cardId);
    } catch (e) {
      setActionError(failureWith(`${name} wasn't stopped`, e));
    }
  }

  /** Drop, paste and Add files… all come here: each file read whole and
   *  sent as raw bytes. A pasted image is named by when it was pasted. */
  async function attach(files: File[], pasted = false) {
    for (const file of files) {
      const name = pasted ? pastedFileName(file, new Date()) : file.name;
      const stamp = `${name}-${Date.now()}-${Math.random()}`;
      if (file.size > CHAT_ATTACHMENT_MAX_BYTES) {
        setRefusals((r) => [...r, { key: stamp, name, reason: tooLargeReason(file.size) }]);
        continue;
      }
      setUploads((u) => [...u, { key: stamp, name }]);
      try {
        const bytes = await readDroppedFile(file);
        await useChat.getState().addAttachment(workspaceId, cardId, name, bytes);
      } catch (e) {
        // 1.172.2 D2: a file that couldn't be read whole says why in the
        // same words as every other drop place; the raw reason behind Details.
        const said =
          e instanceof IncompleteDropError
            ? (({ body, details }) => ({ sentence: body, details }))(dropRefusalWords(e, name, "chat"))
            : plainFailure(e);
        setRefusals((r) => [...r, { key: stamp, name, reason: said.sentence, ...(said.details ? { details: said.details } : {}) }]);
      } finally {
        setUploads((u) => u.filter((p) => p.key !== stamp));
      }
    }
  }

  /** `label` is how the tab names it ("name (2)"), so a refusal says which. */
  async function remove(attachment: ChatAttachment, label = attachment.name) {
    setActionError(null);
    try {
      await useChat.getState().removeAttachment(workspaceId, cardId, attachment.id);
    } catch (e) {
      setActionError(failureWith(`${label} wasn't removed`, e));
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter is a new line — as the app's other
    // composers. A key that ends an input method's composition never sends
    // (`isComposing`, and keyCode 229, which WebKit reports for it).
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Nothing can be sent now (an answer runs, a file is read): Enter is a
    // new line, as in any text box, never a key that does nothing.
    if (!canWrite || !hasSomething || uploads.length > 0) return;
    e.preventDefault();
    void send();
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const data = e.clipboardData;
    if (!data) return;
    const files = pastedFilesToAttach(Array.from(data.types ?? []), Array.from(data.files ?? []));
    if (files.length === 0) return;
    e.preventDefault();
    void attach(files, true);
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (!acceptsDrag(e, CARD_CHAT_DROP_KINDS)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    if (!dragOver) setDragOver(true);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    if (!acceptsDrag(e, CARD_CHAT_DROP_KINDS)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) void attach(files);
  }

  const byId = useMemo(() => new Map(attachments.map((a) => [a.id, a])), [attachments]);
  const labels = useMemo(() => attachmentLabels(attachments), [attachments]);
  const repeated = useMemo(() => repeatedNames(attachments), [attachments]);
  const pending = pendingIds.map((id) => byId.get(id)).filter((a): a is ChatAttachment => a != null);

  const tokenLine = chatTokenLine(usage);
  // 1.174.0 E10 (T14, owner E q5 a): one control — Ask Claude · Ask Codex ·
  // Plan with two AIs (the third only where the mode switch was). Switching
  // AI keeps today's rules: off while it answers, with the same tooltips.
  const choice: ChatChoice = plan && mode === "plan" ? "plan" : vendor;
  const useTab = (
    <Segmented<ChatChoice>
      label="Use this tab to"
      value={choice}
      onChange={(next) => {
        if (next === "plan") {
          setMode("plan");
          return;
        }
        setMode("chat");
        if (next !== vendor) void switchVendor(next);
      }}
      options={[
        ...CHAT_VENDORS.map((v) => ({
          value: v as ChatChoice,
          label: `Ask ${chatVendorName(v)}`,
          // E10 round 1: from Plan, the AI in use always brings you back.
          disabled:
            !(choice === "plan" && v === vendor) &&
            (switching || sending || (v !== vendor && !vendorSwitchOpen(status))),
          title:
            v !== vendor && !vendorSwitchOpen(status)
              ? `Stop ${name}'s answer first: switching ends its session.`
              : v === vendor
                ? undefined
                : `Chat with ${chatVendorName(v)}. The conversation with ${name} stays.`,
        })),
        ...(switchShown ? [{ value: "plan" as ChatChoice, label: PLAN_TWO_AIS_LABEL }] : []),
      ]}
    />
  );
  const modeSwitch = <div className="ux-chat-bar">{useTab}</div>;

  if (plan && mode === "plan") {
    return (
      <div className="ux-chat" data-ply-chat={cardId} data-ply-chat-mode="plan">
        {modeSwitch}
        <PlanExchangePanel workspaceId={workspaceId} cardId={cardId} context={plan} chatVendor={vendor} />
      </div>
    );
  }

  return (
    <div
      className="ux-chat"
      data-ply-chat={cardId}
      data-ply-chat-status={status}
      data-ply-chat-vendor={vendor}
      // 1.172.2 (Challenger round 1): the whole chat takes a dropped file
      // for the next message — its list too, not only the composer — so a
      // drop anywhere in it never reaches the card page around it.
      data-drop-zone="card-chat"
      data-drop-accepts={acceptsAttr(CARD_CHAT_DROP_KINDS)}
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        const next = e.relatedTarget as Node | null;
        if (!next || !e.currentTarget.contains(next)) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      <p className="ux-chat-scope">{chatScopeLine(pullRequest)}</p>
      {planRunning && (
        <Callout
          kind="info"
          title="Two AIs are planning this card"
          text={`${chatVendorName(vendor)} waits until they finish, or until you stop them in Plan with two AIs.`}
        />
      )}

      <div className="ux-chat-bar">
        {useTab}
        <span className="ux-chat-state" data-ply-chat-state-words="">
          {refused && composerOpen(status) ? chatRefusedWords(vendor) : chatStatusWords(status, vendor, attention)}
        </span>
        {terminalOffered && !attention && (
          <CBtn
            tone="quiet"
            aria-expanded={terminalShown}
            aria-controls={terminalId}
            onClick={() => setTerminalShown((v) => !v)}
          >
            {terminalShown ? "Hide terminal" : "Show terminal"}
          </CBtn>
        )}
      </div>

      {loadError && (
        <>
          <Callout kind="danger" title="The chat couldn't be read" text={loadError.sentence} />
          {loadError.details && (
            <Details>
              <pre className="ux-output">{loadError.details}</pre>
            </Details>
          )}
        </>
      )}

      {trustStop && (
        <ClaudeReviewTrustStep refused subject="chat" workspaceId={workspaceId} density="dense" />
      )}
      {reason && !trustStop && (
        // 1.176.0 seams: Callout shows the sentence without its mark; a CLI
        // that doesn't start gets its Repair.
        <Callout kind="warn" title={`${name} stopped`} text={reason} actions={backendMarkTool(reason) ? <RepairFor texts={[reason]} /> : undefined} />
      )}
      {attention && (
        <Callout
          kind="info"
          title={`${name} is waiting on its own screen`}
          text={`${attention} Plyloft doesn't answer it for you: answer it in the terminal.`}
          actions={
            terminalOffered ? (
              <CBtn
                tone="accent"
                aria-expanded={terminalShown}
                aria-controls={terminalId}
                onClick={() => setTerminalShown((v) => !v)}
              >
                {terminalShown ? "Hide terminal" : "Show terminal"}
              </CBtn>
            ) : undefined
          }
        />
      )}
      {terminalShown && ptyId && <ChatTerminal id={terminalId} workspaceId={workspaceId} cardId={cardId} ptyId={ptyId} />}

      <ol
        ref={logRef}
        // Scrollable: it takes focus so the keyboard can scroll it.
        tabIndex={0}
        onScroll={(e) => {
          const log = e.currentTarget;
          if (log.scrollHeight - log.scrollTop - log.clientHeight < 24) atEnd.current = true;
          else if (log.scrollTop < lastTop.current) atEnd.current = false;
          lastTop.current = log.scrollTop;
        }}
        className="ux-chat-log"
        aria-label={`Conversation with ${name}`}
        data-ply-chat-log=""
      >
        {messages.length === 0 && view?.loaded && (
          <li className="ux-chat-empty">
            Ask {name} anything about this card: what it means and how to approach it.
          </li>
        )}
        {messages.map((m) => (
          <ChatItem key={m.id} message={m} vendor={vendor} attachments={byId} labels={labels} />
        ))}
      </ol>
      <div className="ux-sr-only" aria-live="polite" data-ply-chat-announce="">
        {announcement}
      </div>

      {tokenLine && (
        <p className="ux-chat-tokens" data-ply-chat-tokens="">
          {tokenLine}
        </p>
      )}

      {builder && !pullRequest && (
        <p className="ux-chat-scope" data-ply-chat-builder-line={builder.reach}>
          {chatBuilderLine(builder.reach)}
        </p>
      )}

      <div
        className={dragOver ? "ux-chat-composer ux-chat-composer--over" : "ux-chat-composer"}
        aria-busy={uploads.length > 0 || undefined}
      >
        {(pending.length > 0 || uploads.length > 0) && (
          <ul className="ux-chat-chips" aria-label="Files sent with your next message">
            {pending.map((a) => (
              <AttachmentChip
                key={a.id}
                attachment={a}
                label={labels.get(a.id) ?? a.name}
                added={repeated.has(a.name) ? attachmentAddedWords(a.addedAt) : null}
                onRemove={() => void remove(a, labels.get(a.id))}
              />
            ))}
            {uploads.map((u) => (
              <ReadingChip key={u.key} name={u.name} />
            ))}
          </ul>
        )}
        {refusals.length > 0 && (
          <ul className="ux-chat-refusals">
            {refusals.map((r) => (
              <li key={r.key} className="ux-chat-refusal" role="alert">
                <span>
                  {r.name} wasn't attached. {r.reason}
                  {r.details && (
                    <Details>
                      <pre className="ux-output">{r.details}</pre>
                    </Details>
                  )}
                </span>
                <CIcon
                  icon="close"
                  tone="quiet"
                  aria-label={`Dismiss the note about ${r.name}`}
                  onClick={() => setRefusals((all) => all.filter((x) => x.key !== r.key))}
                />
              </li>
            ))}
          </ul>
        )}
        {actionError && (
          <div className="ux-chat-error" role="alert">
            <FailureText failure={actionError} />
          </div>
        )}
        <textarea
          ref={composerRef}
          className="ux-chat-input"
          aria-label={`Message to ${name}`}
          rows={3}
          value={draft}
          placeholder={
            canWrite ? `Ask ${name} about this card. Drop or paste files here.` : chatStatusWords(status, vendor, attention)
          }
          onChange={(e) => useChat.getState().setDraft(workspaceId, cardId, e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div className="ux-chat-actions">
          <span className="ux-chat-hint">{machineWords(CHAT_FILES_LINE)}</span>
          <FilePickButton
            // macOS's Open panel (WKWebView) turns dotted extensions into
            // file types and may keep Open disabled (Mac walk F3): no filter
            // there; the backend checks every file anyway.
            accept={isMac() ? undefined : CHAT_ATTACHMENT_ACCEPT}
            onFiles={(files) => void attach(files)}
            title={`Choose images, PDFs, Word or text files for your next message. ${CHAT_ATTACHMENT_LIMITS}`}
          >
            Add files…
          </FilePickButton>
          {builder?.tell && builder.reach === "builder" && !pullRequest && (
            <CBtn
              disabled={telling || tellBuilderPress(draft, lastSaid) === null}
              title={tellBuilderTitle(draft, lastSaid)}
              data-ply-chat-tell-builder=""
              onClick={() => void tellBuilder()}
            >
              {TELL_BUILDER_LABEL}
            </CBtn>
          )}
          {stopOffered(status) ? (
            <CBtn tone="danger" onClick={() => void stop()}>
              Stop
            </CBtn>
          ) : (
            <CBtn
              tone={hasSomething && canWrite ? "accent" : "ghost"}
              disabled={!canWrite || !hasSomething || uploads.length > 0}
              reason={uploads.length > 0 ? "Wait for your files to be read." : null}
              onClick={() => void send()}
            >
              Send
            </CBtn>
          )}
        </div>
      </div>

      {attachments.length + uploads.length > 0 && (
        <details className="ux-details">
          <summary className="ux-details-summary">Files in this chat ({attachments.length + uploads.length})</summary>
          <div className="ux-details-body">
            <ul className="ux-chat-chips" aria-label="Files in this chat">
              {attachments.map((a) => (
                <AttachmentChip
                  key={a.id}
                  attachment={a}
                  label={labels.get(a.id) ?? a.name}
                  added={repeated.has(a.name) ? attachmentAddedWords(a.addedAt) : null}
                  onRemove={() => void remove(a, labels.get(a.id))}
                />
              ))}
              {/* A file still being read (a PDF's text extracted) is listed
                  here too, saying so, as its chip in the composer does. */}
              {uploads.map((u) => (
                <ReadingChip key={u.key} name={u.name} />
              ))}
            </ul>
          </div>
        </details>
      )}
    </div>
  );
}

/** `label` tells apart files of one name ("name (2)"); `added`, for such a
 *  name, says when this one was added. */
function AttachmentChip({
  attachment,
  label,
  added,
  onRemove,
}: {
  attachment: ChatAttachment;
  label: string;
  added: string | null;
  onRemove: () => void;
}) {
  return (
    <li className="ux-chat-chip" data-ply-chat-attachment={attachment.id}>
      <span className="ux-chat-chip-name" title={attachment.name}>
        {label}
      </span>
      <span className="ux-chat-chip-facts">
        {attachmentFacts(attachment)}
        {added ? ` · ${added}` : ""}
      </span>
      {attachment.note && <span className="ux-chat-chip-note">{attachment.note}</span>}
      <CIcon icon="close" className="ux-chat-chip-remove" aria-label={`Remove ${label}`} title={removeAttachmentTitle(label)} onClick={onRemove} />
    </li>
  );
}

/** A file still being read: its name and "Reading…". */
function ReadingChip({ name }: { name: string }) {
  return (
    <li className="ux-chat-chip ux-chat-chip--busy" aria-busy="true">
      <span className="ux-chat-chip-name">{name}</span>
      <span className="ux-chat-chip-facts">Reading…</span>
    </li>
  );
}
