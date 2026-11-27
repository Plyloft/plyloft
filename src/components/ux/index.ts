// UX language (ADR 0004, docs/ux-language/PATTERNS.md): the component layer
// a page surface is built from. Classes are prefixed `ux-`; CBtn, CIcon and
// PChip stay the buttons and chips and are restyled by the page tokens
// inside a Page (ux.css). `scripts/ux-check.mjs` holds migrated files to it.
import "./ux.css";

export {
  Page,
  PageHeader,
  ScopeBadge,
  ScopeMark,
  ProjectShareableContext,
  ScopeLabelProvider,
  type ScopeLabel,
  Section,
  Group,
  StatusLine,
  Details,
  EmptyState,
  DangerZone,
  ChangedMark,
  PendingMark,
  BackLink,
  Footnote,
  type RunState,
} from "./Page";
// GH #102: the error shape (BOARDS.md §5), built only from a `UxError`. Card
// #94 drew the same three parts from a second `ErrorBlock` in `Page.tsx`; the
// merge kept this one, and card #94's pages build a `UxError` for it.
export { ErrorBlock } from "./ErrorBlock";
// UX P-D2: an inline failure — a plain sentence, the raw text behind Details.
export { FailureText } from "./FailureText";
export { RepairFor } from "./RepairFor";
// UX-2.2: the one icon set (Lucide), by meaning.
export { Icon, ICONS, type IconName } from "./Icon";
// UX-2.3: the one-scale primitives for the shell, the card page and lists.
export {
  ScreenHeader,
  Properties,
  StateWord,
  Callout,
  Timeline,
  Popover,
  Flow,
  type Crumb,
  type Property,
  type TimelineEvent,
} from "./Screen";
// GH #277: rows to tick under hairlines (Ship batch).
export { CheckLine, CheckList, CheckRow } from "./CheckList";
// OB-4: a guided procedure's numbered steps and its progress (Setup).
export { StepList, ProgressBar, type StepItem } from "./Steps";
export { ListView, type ListColumn, type ListGroup, type ListSort } from "./ListView";
export { PublishBar } from "./Publish";
export { Sheet, SheetChange } from "./Sheet";
export { Swatches, type Swatch } from "./Swatches";
export { Captioned, Row, RowValue, FoundRow, useLandingNonce, usePageReading, useRowState, type RowKind } from "./Row";
export {
  Toggle,
  FilePickButton,
  Select,
  Segmented,
  ChoiceList,
  TextField,
  SearchField,
  TypeOrChoose,
  type SelectOption,
} from "./controls";
export { AvailabilityChips, DuplicateChip } from "./items";
export { MoreMenu, MenuButton, MenuList, PlanMark, SplitButton, type MenuItem } from "./MoreMenu";
export { NavList, NavMenuButton, type NavListGroup } from "./Nav";
export { SearchResults } from "./Results";
export { CBtn, CIcon, PChip } from "../ui/primitives";
// N14 walk F6: content that opens inline in answer to a press is scrolled
// into view and its heading focused.
export { useReveal, revealElement, settleReveal, prefersReducedMotion, type RevealOptions } from "./useReveal";
