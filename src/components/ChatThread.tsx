import { memo } from "react";
import type { ChatAttachment, ChatMessage, ChatVendor } from "../ipc";
import { attachmentFacts, chatVendorName } from "../lib/chatView";
import { MarkdownText } from "./MarkdownText";

/**
 * One message of a card's thread, by its role: shared by the Chat tab
 * (`ChatPanel`) and Plan with two AIs (`PlanExchangePanel`). `who` names the
 * speaker when the vendor alone doesn't (one vendor in both roles of a plan,
 * owner Q5: "Claude (critic)").
 */
export const ChatItem = memo(function ChatItem({
  message,
  vendor,
  attachments,
  labels,
  who,
}: {
  message: ChatMessage;
  vendor: ChatVendor;
  attachments: Map<string, ChatAttachment>;
  labels: Map<string, string>;
  who?: string;
}) {
  const name = who ?? chatVendorName(vendor);
  switch (message.role) {
    case "user":
      return (
        <li
          className={message.isError ? "ux-chat-msg ux-chat-msg--user ux-chat-msg--unsent" : "ux-chat-msg ux-chat-msg--user"}
          data-ply-chat-role="user"
        >
          <span className="ux-chat-who">You</span>
          {message.text && <p className="ux-chat-text">{message.text}</p>}
          {message.attachmentIds.length > 0 && (
            <ul className="ux-chat-chips" aria-label="Files sent with it">
              {message.attachmentIds.map((id) => {
                const a = attachments.get(id);
                return (
                  <li key={id} className="ux-chat-chip ux-chat-chip--sent">
                    <span className="ux-chat-chip-name">{a ? (labels.get(id) ?? a.name) : "A file since removed"}</span>
                    {a && <span className="ux-chat-chip-facts">{attachmentFacts(a)}</span>}
                  </li>
                );
              })}
            </ul>
          )}
          {(message.pastedImages ?? 0) > 0 && (
            <p className="ux-chat-meta">
              {message.pastedImages === 1 ? "1 image pasted in the terminal" : `${message.pastedImages} images pasted in the terminal`}
            </p>
          )}
          {message.isError && <p className="ux-chat-flag">Not sent. Send it again when {name} is ready.</p>}
        </li>
      );
    case "assistant":
      return (
        <li className="ux-chat-msg ux-chat-msg--assistant" data-ply-chat-role="assistant" aria-busy={!message.done || undefined}>
          <span className="ux-chat-who">{name}</span>
          {message.done ? (
            <MarkdownText text={message.text} />
          ) : (
            <>
              <p className="ux-chat-text">{message.text}</p>
              <p className="ux-chat-meta">Writing…</p>
            </>
          )}
        </li>
      );
    case "tool": {
      const tool = message.tool;
      const outcome = tool?.outcome === "failed" ? " (failed)" : tool?.outcome === "denied" ? " (refused)" : tool?.outcome === "running" ? "…" : "";
      return (
        <li className="ux-chat-line" data-ply-chat-role="tool">
          <span>
            {name} used {tool?.name ?? "a tool"}
            {tool?.detail ? `: ${tool.detail}` : ""}
            {outcome}
          </span>
        </li>
      );
    }
    case "shell":
      return (
        <li className="ux-chat-msg ux-chat-msg--shell" data-ply-chat-role="shell">
          <span className="ux-chat-who">A shell command ran</span>
          <code className="ux-chat-code">{message.text}</code>
          <p className="ux-chat-meta">
            It ran with your rights on this computer: a command typed with ! in the terminal isn't covered by the
            chat's read-only setup.
          </p>
          {message.tool?.detail && (
            <details className="ux-details">
              <summary className="ux-details-summary">What it printed</summary>
              <pre className="ux-output">{message.tool.detail}</pre>
            </details>
          )}
        </li>
      );
    case "interrupted":
      return (
        <li className="ux-chat-line" data-ply-chat-role="interrupted">
          <span>You stopped this answer.</span>
        </li>
      );
    case "notice":
      return (
        <li
          className={message.isError ? "ux-chat-line ux-chat-line--warn" : "ux-chat-line"}
          data-ply-chat-role="notice"
        >
          <span>{message.text}</span>
        </li>
      );
    default:
      return (
        <li className="ux-chat-line" data-ply-chat-role={message.role}>
          <span>{message.text}</span>
        </li>
      );
  }
});
