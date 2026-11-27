// Round 2 (G3; consents.html scene 1.4): the page of a skill that waits for
// an OK showed the library's current text — the one the person's sessions
// do **not** use — at the moment they decide. Under the status line it now
// says which version this is and shows that version's text: the one approved
// here, or the plain text from before the skill asked. A skill no session
// gets yet shows nothing here; its sheet (Review) shows what came in.
import { useEffect, useState } from "react";
import { skillsHubScriptsReview, type ScriptsReview } from "../../ipc";
import { keptVersionLine } from "../../lib/skillAsks";
import { StatusLine } from "../ux";

export function HeldVersion({ plugin, skill, library }: { plugin: string; skill: string; library?: "mine" }) {
  const [review, setReview] = useState<ScriptsReview | null>(null);
  useEffect(() => {
    let current = true;
    setReview(null);
    skillsHubScriptsReview(plugin, skill, library)
      .then((answer) => current && setReview(answer))
      .catch(() => current && setReview(null));
    return () => {
      current = false;
    };
  }, [plugin, skill, library]);
  if (!review?.keptText) return null;
  return (
    <>
      <StatusLine state="empty">{keptVersionLine(review.approvedAt)}</StatusLine>
      <pre className="ux-output" aria-label={`${skill}, the version your sessions use`}>
        {review.keptText}
      </pre>
    </>
  );
}
