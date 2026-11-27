// UX-2.2 (ADR 0007): the one icon set. Lucide line icons at stroke 1.5, one
// icon per meaning and one meaning per icon — the map is the Ply Design
// System's Icons card. Import only from here: a meaning missing from the map
// is added to the design system first, then here.
import {
  ArrowLeft,
  Bot,
  ChevronDown,
  ChevronRight,
  Check,
  ChevronsUpDown,
  CircleCheck,
  CircleDot,
  CircleHelp,
  CircleX,
  Code,
  Contrast,
  Copy,
  Ellipsis,
  Eye,
  EyeOff,
  File,
  Folder,
  FolderGit2,
  FolderOpen,
  Hash,
  History,
  Inbox,
  Info,
  Keyboard,
  Laptop,
  LibraryBig,
  Layers,
  Link2,
  LogIn,
  List,
  ListChecks,
  ListFilter,
  Maximize2,
  Minimize2,
  OctagonAlert,
  PackageCheck,
  PanelLeft,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings,
  SquareKanban,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  Undo2,
  UserRound,
  UsersRound,
  X,
  type LucideIcon,
} from "lucide-react";

export const ICONS = {
  // Navigation
  search: Search,
  inbox: Inbox,
  history: History,
  board: SquareKanban,
  list: List,
  code: Code,
  terminals: SquareTerminal,
  library: LibraryBig,
  // Skills hub H7: All skills, the app section's entry above the workspaces.
  allSkills: Layers,
  shipBatch: PackageCheck,
  settings: Settings,
  sidebar: PanelLeft,
  // GH #321: the keyboard shortcuts sheet (⌘/).
  shortcuts: Keyboard,
  // Getting started TU-4 (TUTORIAL_SPEC §3.3): the Help menu (its sidebar row since 1.169.0, C9).
  help: CircleHelp,
  // Switch workspace, and the caret of every select: choose one of a list.
  choose: ChevronsUpDown,
  current: Check,
  // Scopes
  thisMac: Laptop,
  repository: FolderGit2,
  // 1.174.0 (DS1): Settings' task groups and the scope mark — Look and
  // feel, and the project a row is shared with.
  look: Contrast,
  project: Folder,
  team: UsersRound,
  account: UserRound,
  // Actions
  add: Plus,
  more: Ellipsis,
  close: X,
  back: ArrowLeft,
  opens: ChevronRight,
  expand: ChevronDown,
  rename: Pencil,
  copy: Copy,
  reveal: FolderOpen,
  filter: ListFilter,
  undo: Undo2,
  restart: RotateCcw,
  maximize: Maximize2,
  restore: Minimize2,
  blockedBy: Link2,
  delete: Trash2,
  // A file sent with a card (not an image, which shows itself).
  file: File,
  // A card page's properties (C6; the Design System's Properties spec)
  status: CircleDot,
  builder: Bot,
  checks: ListChecks,
  review: Eye,
  issue: Hash,
  // 1.175.0 (B3): an issue written by somebody outside the repository, and
  // the parts of its text GitHub doesn't show to who reads it there.
  outside: LogIn,
  hiddenText: EyeOff,
  // Callouts (always beside words)
  info: Info,
  passed: CircleCheck,
  warning: TriangleAlert,
  // GH #274: a check or a dependency that failed (the Dependency doctor's row).
  failed: CircleX,
  destructive: OctagonAlert,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

/**
 * An icon from the map. Decorative by default (hidden from assistive tech);
 * give `label` when the icon is the control's only name.
 */
export function Icon({
  name,
  size = "md",
  label,
}: {
  name: IconName;
  /** sm 14 px (compact rows, chips, tile headers) · md 16 px (sidebar, buttons, pages). */
  size?: "sm" | "md";
  label?: string;
}) {
  const Glyph = ICONS[name];
  return (
    <Glyph
      className={size === "sm" ? "ux-icon ux-icon--sm" : "ux-icon"}
      strokeWidth={1.5}
      absoluteStrokeWidth={false}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      focusable="false"
    />
  );
}
