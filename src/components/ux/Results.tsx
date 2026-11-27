import { useId } from "react";
import {
  ELSEWHERE_HEADING,
  SEARCH_APP_LABEL,
  groupByScope,
  nothingFoundLine,
  resultsHeading,
  resultsLede,
  type ElsewhereEntry,
  type SettingsSearchResult,
} from "../../lib/settingsSearch";
import { shortcutKeys } from "../../lib/shortcuts";

/**
 * UX language card 7 (GH #107; BOARDS.md §2, §6 "Search in Settings"): what
 * the search field found.
 *
 * `Results for model`, the line that counts them, then one group per scope —
 * named, because a result that does not say what it reaches is a result you
 * have to open to understand. Each result is the setting's label, the path it
 * lives at (`This Mac › Builds & runs › Claude`) and the value it holds right
 * now in mono; a result found only in that value says why it is in the list
 * (`mentions model in its command`).
 *
 * UX-9.4: the list is drawn in the page area, full width, while the field
 * holds text — the navigation stays where it is beside it. Each result is one
 * row under its group's heading, split by hairlines like a page's rows.
 */
export function SearchResults({
  query,
  results,
  headingId,
  onOpen,
  elsewhere = [],
  onElsewhere,
  onSearchApp,
  absentNote,
}: {
  /** 1.169.0 walk: nothing drawn here matched, but a row that isn't drawn
   *  did — its note says why. */
  absentNote?: string | null;
  query: string;
  results: readonly SettingsSearchResult[];
  /** The heading's id, so the field can be described by what it found. */
  headingId: string;
  onOpen: (result: SettingsSearchResult) => void;
  /** QoL 1.168 G2: places outside Settings that match. */
  elsewhere?: readonly ElsewhereEntry[];
  onElsewhere?: (entry: ElsewhereEntry) => void;
  /** QoL 1.168 G2: the whole app's search (⌘K), when Settings has nothing. */
  onSearchApp?: () => void;
}) {
  const groups = groupByScope(results);
  // One base per instance: two results must never share an id.
  const uid = useId();
  return (
    <div className="ux-results" role="group" aria-labelledby={headingId}>
      <h1 id={headingId} className="ux-results-heading">
        {resultsHeading(query)}
      </h1>
      <p className="ux-results-lede">
        {results.length === 0 ? nothingFoundLine(query, absentNote) : resultsLede(results, onElsewhere ? elsewhere.length : 0)}
      </p>
      {groups.map((g) => (
        <div key={g.scope} className="ux-results-group">
          <h2 className="ux-results-scope">
            {g.name}
          </h2>
          <ul className="ux-results-list">
            {g.results.map((r, i) => {
              // The name is the setting; the path, the value and the reason a
              // value-only match is here are its description — an `aria-label`
              // would have replaced the name with a summary and swallowed all
              // three (review 1, MINOR 4).
              const id = `${uid}-${g.scope}-${i}`;
              return (
                <li key={`${r.entry.kind}:${r.entry.page}:${r.entry.section ?? ""}:${r.entry.label}`}>
                  <button
                    type="button"
                    className="ux-result"
                    aria-labelledby={`${id}-label`}
                    aria-describedby={r.why ? `${id}-trail ${id}-why` : `${id}-trail`}
                    onClick={() => onOpen(r)}
                  >
                    <span id={`${id}-label`} className="ux-result-label">
                      {r.entry.label}
                      {/* DS8 (scene 14): found by the name it had. */}
                      {r.was && <span className="ux-result-was"> · was {r.was}</span>}
                    </span>
                    <span id={`${id}-trail`} className="ux-result-trail">
                      {r.trail}
                      {r.value && <span className="ux-result-value">{r.value}</span>}
                    </span>
                    {r.why && (
                      <span id={`${id}-why`} className="ux-result-why">
                        {r.why}
                      </span>
                    )}
                    <span className="ux-result-chevron" aria-hidden>
                      ›
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {elsewhere.length > 0 && onElsewhere && (
        <div className="ux-results-group">
          <h2 className="ux-results-scope">{ELSEWHERE_HEADING}</h2>
          <ul className="ux-results-list">
            {elsewhere.map((e) => {
              const id = `${uid}-elsewhere-${e.id}`;
              return (
                <li key={e.id}>
                  <button
                    type="button"
                    className="ux-result"
                    aria-labelledby={`${id}-label`}
                    aria-describedby={`${id}-trail`}
                    onClick={() => onElsewhere(e)}
                  >
                    <span id={`${id}-label`} className="ux-result-label">
                      {e.label}
                    </span>
                    <span id={`${id}-trail`} className="ux-result-trail">
                      {e.hint ? `${e.where} · ${e.hint}` : e.where}
                    </span>
                    <span className="ux-result-chevron" aria-hidden>
                      ›
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {results.length === 0 && onSearchApp && (
        <div className="ux-results-group">
          <ul className="ux-results-list">
            <li>
              <button type="button" className="ux-result" onClick={onSearchApp}>
                <span className="ux-result-label">{SEARCH_APP_LABEL}</span>
                <span className="ux-result-trail">
                  Commands, files, text in your files and past sessions · {shortcutKeys("palette")}
                </span>
                <span className="ux-result-chevron" aria-hidden>
                  ›
                </span>
              </button>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
