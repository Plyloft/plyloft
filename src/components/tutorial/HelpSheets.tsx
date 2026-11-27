import { useRef, useState } from "react";
import { CBtn } from "../ui/primitives";
import { Details } from "../ux/Page";
import { Sheet } from "../ux/Sheet";
import { formatKeys, machineWords } from "../../lib/platform";
import { QUICK_TOUR_LINK } from "../../lib/tutorial/manifest";
import { CHANGELOG_URL, type HighlightNav, type ReleaseHighlights } from "../../lib/releaseHighlights";
import {
  GET_HELP_ADDRESS_LINE,
  GET_HELP_LEDE,
  GET_HELP_NOTE,
  GET_HELP_TITLE,
  WHATS_NEW_EARLIER,
  WHATS_NEW_FULL_CHANGELOG,
  WHATS_NEW_NONE,
  WHATS_NEW_TITLE,
  supportMailto,
} from "../../lib/tutorial/whatsNew";
import { openSupportMail, openWebLink } from "../../ipc";
import { closeGetHelp, closeWhatsNew, tutorialReportNow, useHelp, type WhatsNew } from "../../store/helpStore";
import { startQuickTour } from "../../store/quickTourStore";
import { pushToast } from "../../store/toastStore";
import { openGuide, tourNavigate } from "../../store/tutorialStore";
import { linkDidNotOpen } from "../../lib/linkToast";
import { pushErrorToast } from "../../lib/errorToast";

/**
 * Getting started TU-8 (TUTORIAL_SPEC §12.2, §3.3): Help's two sheets,
 * drawn beside the shell. New in this version shows the installed version's
 * highlights, the versions since the member last looked below them, and the
 * site's full changelog (owner, 2026-10-21); Get help
 * puts the report in an email the member sends themselves, or copies it.
 * Nothing is sent by Plyloft.
 */
export function HelpSheets() {
  const whatsNew = useHelp((s) => s.whatsNew);
  const getHelp = useHelp((s) => s.getHelp);
  return (
    <>
      {whatsNew && <WhatsNewSheet news={whatsNew} />}
      {getHelp && <GetHelpSheet />}
    </>
  );
}

function WhatsNewSheet({ news }: { news: WhatsNew }) {
  return (
    <Sheet
      title={WHATS_NEW_TITLE}
      onClose={closeWhatsNew}
      leadAction={
        <CBtn
          size="sm"
          onClick={() =>
            void openWebLink(CHANGELOG_URL).catch((e: unknown) =>
              pushToast(linkDidNotOpen(CHANGELOG_URL, e)),
            )
          }
        >
          {WHATS_NEW_FULL_CHANGELOG}
        </CBtn>
      }
      actions={
        <CBtn tone="accent" onClick={closeWhatsNew}>
          Close
        </CBtn>
      }
    >
      {news.current ? (
        // F6: the newest title is a heading like the older ones, not the
        // sheet's muted lede (it read as the lesser of the two).
        <div className="ux-whats-new-release ux-whats-new-release--newest" data-ply-whats-new-version={news.current.version}>
          <h3 className="ux-tour-note-title" id={`whats-new-${news.current.version}`}>
            {machineWords(`Plyloft ${news.current.version} · ${news.current.title}`)}
          </h3>
          <Points release={news.current} labelledBy={`whats-new-${news.current.version}`} />
        </div>
      ) : (
        <p className="ux-tour-step-text">{WHATS_NEW_NONE}</p>
      )}
      {news.earlier.length > 0 && (
        <>
          {/* Headings, so a screen reader moves release by release. */}
          <h3 className="ux-tour-chapter">{WHATS_NEW_EARLIER}</h3>
          {news.earlier.map((r) => (
            <div key={r.version} className="ux-whats-new-release" data-ply-whats-new-version={r.version}>
              <h3 className="ux-tour-note-title" id={`whats-new-${r.version}`}>
                {machineWords(`Plyloft ${r.version} · ${r.title}`)}
              </h3>
              <Points release={r} labelledBy={`whats-new-${r.version}`} />
            </div>
          ))}
        </>
      )}
    </Sheet>
  );
}

/** One release's points, each with what it offers (the place it is about,
 *  or the tour), never pressing anything else. */
function Points({
  release,
  label,
  labelledBy,
}: {
  release: ReleaseHighlights;
  label?: string;
  labelledBy?: string;
}) {
  return (
    <ul
      className="ux-whats-new"
      aria-label={labelledBy ? undefined : machineWords(label ?? `Plyloft ${release.version}`)}
      aria-labelledby={labelledBy}
    >
      {release.points.map((point, i) => (
        <li key={i} className="ux-whats-new-row" data-ply-whats-new={`${release.version}:${i}`}>
          <p className="ux-tour-note-body">{formatKeys(machineWords(point.text))}</p>
          {point.action && "tour" in point.action && (
            <div className="ux-tour-actions">
              <CBtn
                size="sm"
                onClick={() => {
                  closeWhatsNew();
                  void openGuide();
                }}
              >
                Start the tour
              </CBtn>
              <CBtn
                size="sm"
                onClick={() => {
                  closeWhatsNew();
                  startQuickTour();
                }}
              >
                {QUICK_TOUR_LINK}
              </CBtn>
            </div>
          )}
          {point.action && "nav" in point.action && (
            <CBtn
              size="sm"
              onClick={() => {
                closeWhatsNew();
                // The workspace on screen, never the tour's own.
                tourNavigate((point.action as { nav: HighlightNav }).nav, { active: true });
              }}
            >
              {point.action.label ?? "Take me there"}
            </CBtn>
          )}
        </li>
      ))}
    </ul>
  );
}

function GetHelpSheet() {
  // The report as it was when the sheet opened: what the member reads is
  // what the email carries.
  const [report] = useState(() => tutorialReportNow(true));
  // The email's is the short one: counts, not each step (a mail handler may
  // cut a long link); Copy carries the whole report.
  const [mail] = useState(() => supportMailto(tutorialReportNow(true, true)));
  const [opening, setOpening] = useState(false);
  const email = () => {
    setOpening(true);
    openSupportMail(mail)
      .then(
        // The sheet stays either way (TU-8 Challenger): on a Mac `open`
        // answers as soon as it starts, and Mail with no account opens on
        // its own setup screen — the address and Copy are still here.
        () => {},
        (e) =>
          pushErrorToast("Your mail app didn't open", e, { then: "Copy the report and send it to support@plyloft.com." }),
      )
      .finally(() => setOpening(false));
  };
  const copyRef = useRef<HTMLButtonElement>(null);
  const copy = () =>
    void navigator.clipboard.writeText(report).then(
      () => pushToast({ kind: "info", title: "Report copied" }),
      (e) => pushErrorToast("Couldn't copy the report", e),
    );
  return (
    <Sheet
      title={GET_HELP_TITLE}
      lede={machineWords(GET_HELP_LEDE)}
      size="confirm"
      onClose={closeGetHelp}
      initialFocusRef={copyRef}
      leadAction={
        <CBtn tone="quiet" onClick={closeGetHelp}>
          Close
        </CBtn>
      }
      actions={
        <>
          <CBtn ref={copyRef} onClick={copy}>
            Copy the report
          </CBtn>
          {/* The backend hands the new email to the system's mail app
              (`open_support_mail`); nothing is sent. */}
          <CBtn tone="accent" disabled={opening} onClick={email}>
            Email support
          </CBtn>
        </>
      }
    >
      <p className="ux-tour-step-text" data-ply-support-address="">
        {GET_HELP_ADDRESS_LINE}
      </p>
      <p className="ux-tour-note-body">{GET_HELP_NOTE}</p>
      <Details summary="What the report says">
        <pre className="ux-output" data-ply-tutorial-report="">
          {report}
        </pre>
      </Details>
    </Sheet>
  );
}
