import { useEffect, useState } from "react";
import { projectConfigGet, type CardPresentationState } from "../ipc";
import {
  END_GUIDE_LABEL,
  GUIDE_TITLE,
  guideSentence,
  guideShownOn,
  guideStageFor,
} from "../lib/firstCardGuide";
import type { AgentVendor } from "../lib/roleModels";
import { tourOnCard } from "../lib/tutorial/tutorialEngine";
import { endGuide } from "../store/firstCardGuideStore";
import { useSettings } from "../store/settingsStore";
import { useKanban } from "../store/kanbanStore";
import { fixRoundCheckOn } from "../lib/fixRoundCheck";
import { CBtn, Callout } from "./ux";
import { pushErrorToast } from "../lib/errorToast";

/**
 * OB-16 (onboarding §14): the Guide on the guided first card's page — one
 * sentence for the card's state (`lib/firstCardGuide.ts`), no action of its
 * own beyond a quiet `End the guide`. Drawn under the card's Now box, so
 * "the box above" and "the change below" are where they say. Nothing on any
 * other card, and nothing once the guide has ended.
 *
 * Getting started TU-5 (TUTORIAL_SPEC §2): one guide at a time — while the
 * tour runs on this card, its coach-marks speak and this callout is not
 * drawn. The record and the permission rule are unchanged.
 */
export function FirstCardGuide({
  workspaceId,
  cardId,
  state,
  landed,
  vendor,
  shipsAs,
}: {
  workspaceId: string;
  cardId: string;
  state: CardPresentationState;
  /** The card's work is on its branch (`cardShippedOrPrOpen`). */
  landed: boolean;
  vendor: AgentVendor;
  /** G1: Ship it opens a pull request here (`shipItGoesToGitHub`). */
  shipsAs?: "merge" | "pr";
}) {
  const guide = useSettings((s) => s.settings.onboarding?.firstCard ?? null);
  const tour = useSettings((s) => tourOnCard(s.settings.onboarding?.tutorial ?? null, workspaceId, cardId));
  // 1.175.0 F5 round 2: the changes line follows the card's "After a fix round".
  const checksByItself = useSettings((s) => {
    const card = useKanban.getState().byWorkspace[workspaceId]?.cards.find((c) => c.id === cardId);
    return fixRoundCheckOn(card ?? { prReview: null }, s.settings.behavior.checkFixRoundsByItself !== false);
  });
  const shown = guideShownOn(guide, workspaceId, cardId) && !tour;
  const stage = guideStageFor(state, { landed, outcome: guide?.outcome });
  const [targetBranch, setTargetBranch] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);

  // The ship sentence names the branch Ship it lands on: read as soon as the
  // Guide shows, so it is there before the card reaches Ready to ship.
  const wantsBranch = shown;
  useEffect(() => {
    if (!wantsBranch) return;
    let live = true;
    projectConfigGet(workspaceId)
      .then((config) => {
        if (live) setTargetBranch(config?.targetBranch ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [wantsBranch, workspaceId]);

  if (!shown) return null;
  return (
    <div data-ply-first-card-guide={stage}>
      <Callout
        kind="info"
        title={GUIDE_TITLE}
        text={guideSentence(stage, { vendor, targetBranch, shipsAs, shipping: state === "shipping", checksByItself })}
        actions={
          <CBtn
            tone="quiet"
            disabled={ending}
            onClick={() => {
              setEnding(true);
              endGuide()
                .catch((e) =>
                  pushErrorToast("Couldn't end the guide", e),
                )
                .finally(() => setEnding(false));
            }}
          >
            {END_GUIDE_LABEL}
          </CBtn>
        }
      />
    </div>
  );
}
