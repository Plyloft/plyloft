/**
 * v1.31.0: lightweight placeholder shown in the tile-grid / right-tabs
 * stacks while a not-yet-warmed workspace's heavy per-workspace subtree
 * (TileGrid + card-host xterm) mounts inside a React
 * `startTransition` (see App.tsx warming effect).
 *
 * Before this, the first switch to any workspace committed that whole
 * subtree in one synchronous render — the main thread froze and macOS
 * showed the spinning-rainbow beachball. Now the sidebar/toolbar swap
 * instantly and this fills the content area for ~1s until the real host
 * commits. Rendered absolutely positioned over the (relative) stack so it
 * never disturbs the warmed-host layout.
 */
type Props = {
  /** Right-panel variant: spinner only — the narrow column skips the label. */
  compact?: boolean;
};

export function WorkspaceSkeleton({ compact = false }: Props) {
  return (
    <div className="ws-skeleton" aria-hidden="true">
      <div className="ws-skeleton-spinner" />
      {!compact && (
        <div className="ws-skeleton-label">Opening workspace…</div>
      )}
    </div>
  );
}
