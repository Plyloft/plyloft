import type { ReactNode } from "react";

// UX language card 4 (GH #96; PATTERNS.md §7): the two pieces an Item row of
// the Library adds to the catalogue.

/**
 * `AvailabilityChips` — only the CLIs a skill reaches are drawn.
 *
 * A CLI the skill does not reach has **no chip** (BOARDS.md §3 "Skill row"):
 * a greyed chip beside a lit one reads as two facts of equal weight, and the
 * fact that matters at a glance is where the skill does arrive. What is
 * missing is said in words — by the section's line when a whole section
 * reaches one CLI, and by the skill's own page otherwise.
 */
export function AvailabilityChips({
  claude,
  codex,
}: {
  claude: boolean;
  codex: boolean;
}) {
  const lit = [claude ? "Claude" : null, codex ? "Codex" : null].filter(
    (name): name is string => name !== null,
  );
  if (lit.length === 0) return null;
  return (
    <span className="ux-avail">
      {lit.map((name) => (
        <span key={name} className="cchip ux-avail-chip">
          {name}
        </span>
      ))}
    </span>
  );
}

/**
 * `DuplicateNotice` — the same name at another scope.
 *
 * Nothing wins (ADR 0005, corrected on the boards 2026-09-17): both copies
 * reach the agents, so the chip states the fact and the action compares them.
 */
export function DuplicateChip({
  children,
  title,
  tone = "outline",
}: {
  children: ReactNode;
  /** Its tooltip — kept even inside a control with a title of its own (the
   *  Board card's, 1.171.0 E3). */
  title?: string;
  /** `warn`: a chip that asks something of the person (a conflict). */
  tone?: "outline" | "warn";
}) {
  return (
    <span className={tone === "warn" ? "cchip cchip--warn" : "cchip cchip--outline"} title={title}>
      {children}
    </span>
  );
}
