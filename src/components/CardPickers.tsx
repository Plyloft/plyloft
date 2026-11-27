// 1.175.0 F10 (UX-10): the card's one Change… panel — opened from the
// sentence under What you want before the first build, from the facts line
// after it — with the rows of the moment, in this order: Builder,
// Permissions, Reviewer, Area (until the build), Blocked by, After a fix
// round (lane C, F5), Fix failing checks by itself (moved here from the
// Shipping section, owner I11; F7 adds its offer beside it), Done.
// What may be chosen is the card page's (`can`); the presses are the pickers'.
import type { ReactNode } from "react";
import { CBtn } from "./ux";
import { BuilderPermissionsPick, BuilderVendorPick } from "./BuilderRunStep";
import { CardModelPick } from "./CardModelPick";
import type { RoleModelFact } from "../lib/cardModels";
import { RetryOnPick } from "./RetryOnPick";
import { CardAreaPick } from "./CardAreaLine";
import { BlockedByValue } from "./CardDependencies";
import { CardAutoFixPick, autoFixPickShown } from "./CardAutoFixPick";
import { FixRoundPick } from "./FixRoundPick";
import { reviewOnly } from "../lib/prReview";
import type { KanbanCard } from "../store/kanbanStore";

export function CardPickers({
  card,
  cards,
  vendor,
  can,
  restart,
  helper,
  builderFact,
  builderModel,
  challengerModel,
  reviewRetry,
  onBlockers,
  onOpen,
  onDone,
}: {
  card: KanbanCard;
  cards: readonly KanbanCard[];
  vendor: "claude" | "codex";
  can: { vendor: boolean; permissions: boolean; models: boolean; area: boolean; blockers: boolean };
  /** A closed session can be resumed: the choice is a new start's. */
  restart: boolean;
  /** The honest line under Permissions (not on the guided first card). */
  helper: boolean;
  builderFact: ReactNode;
  builderModel: RoleModelFact;
  challengerModel: RoleModelFact;
  /** Retry on… beside the Reviewer once it has a word. */
  reviewRetry: boolean;
  onBlockers: (ids: string[]) => void;
  onOpen: (cardId: string) => void;
  onDone: () => void;
}) {
  const people = can.vendor || can.permissions || can.models;
  return (
    <section
      className="ux-card-pickers"
      id={`card-pickers-${card.id}`}
      aria-label={people ? "Change who builds and reviews" : "Change this card's choices"}
      data-ply-card-pickers=""
    >
      {!reviewOnly(card) && (can.vendor || can.models) && (
        <div className="ux-card-pickers-row">
          <span className="ux-card-field-label">Builder</span>
          <span className="ux-card-builder-pick">
            {can.vendor ? <BuilderVendorPick card={card} /> : builderFact}
            {can.models && <CardModelPick card={card} role="builder" fact={builderModel} />}
            {/* 1.169.0 (A3): the Builder round once more, on another model. */}
            {can.models && <RetryOnPick card={card} role="builder" vendor={vendor} />}
          </span>
        </div>
      )}
      {!reviewOnly(card) && can.permissions && (
        <div className="ux-card-pickers-row">
          <span className="ux-card-field-label">Permissions</span>
          <BuilderPermissionsPick card={card} vendor={vendor} helper={helper} restart={restart} />
        </div>
      )}
      {can.models && (
        <div className="ux-card-pickers-row">
          <span className="ux-card-field-label">Reviewer</span>
          <span className="ux-card-builder-pick">
            <CardModelPick card={card} role="challenger" fact={challengerModel} />
            {reviewRetry && <RetryOnPick card={card} role="challenger" vendor={challengerModel.vendor} />}
          </span>
        </div>
      )}
      {can.area && (
        <div className="ux-card-pickers-row">
          <span className="ux-card-field-label">Area</span>
          <CardAreaPick card={card} />
        </div>
      )}
      {can.blockers && (
        <div className="ux-card-pickers-row" data-ply-card-blockers-pick="">
          <span className="ux-card-field-label">Blocked by</span>
          <BlockedByValue card={card} cards={cards} readOnly={false} onOpen={onOpen} onChange={onBlockers} />
        </div>
      )}
      {/* 1.175.0 F5 (I7): the card's own "After a fix round". */}
      {!reviewOnly(card) && !card.prReview && (
        <div className="ux-card-pickers-row">
          <span className="ux-card-field-label">After a fix round</span>
          <FixRoundPick card={card} />
        </div>
      )}
      {/* F10 (I11): moved here from the Shipping section. F7 adds its
          "Turn on" offer beside it. */}
      {autoFixPickShown(card) && <CardAutoFixPick card={card} />}
      <div className="ux-card-section-actions">
        <CBtn tone="quiet" onClick={onDone}>
          Done
        </CBtn>
      </div>
    </section>
  );
}
