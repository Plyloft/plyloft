import { useEffect, useRef, useState } from "react";
import { useUi } from "../store/uiStore";
import { probeLocalhostPorts } from "../ipc";
import { loopbackUrl, portOfAddress } from "../lib/tryAddress";
import { CBtn } from "./ui/primitives";
import { Details, Segmented, Select, TextField } from "./ux";

/** The ports `probe_localhost_ports` tries (commands.rs), said behind Details. */
const PROBED_PORTS = "3000, 3001, 4173, 4321, 5173, 5174, 5000, 8000, 8080, 8081, 4200, 1313 and 9000";

/** The iframe's sandbox, the same in every mode. */
const SANDBOX = "allow-forms allow-modals allow-pointer-lock allow-popups allow-same-origin allow-scripts"; // ux-allow: iframe sandbox tokens, not copy

type Props = {
  workspaceId: string;
  /** When set, LocalhostMode boots with this port preselected, and the first
   *  probe keeps it even before its server answers (Try it TI-3). */
  initialPort?: number | null;
  /** Try it TI-3: a found address (`http://localhost:5173/blog/`) for
   *  LocalhostMode to boot on — its port preselected as `initialPort`, and
   *  its path kept while that port is the one shown. */
  initialAddress?: string | null;
  /** Try it TI-3: the fixed-address mode. Only this URL, in the iframe: no
   *  mode switch, no rescan, no list. The caller owns Reload. */
  address?: string;
  /** With `address`: a change reloads the iframe (the caller's **Reload**),
   *  back on `address` itself — wherever the page inside had navigated to. */
  reloadKey?: number;
};

/**
 * v1.23.0 (Cycle G3): two modes (`localhost`, `generic`). The "agents"
 * sub-mode was cut as redundant with agent surfaces. Mounted inside Code
 * mode's preview strip — no longer a standalone right tab.
 *
 * GH #268: on the one scale — a segmented control, the ux field and select,
 * nothing under 12 px — and the ports it tried behind Details.
 */
export function BrowserPane({
  workspaceId,
  initialPort = null,
  initialAddress = null,
  address,
  reloadKey = 0,
}: Props) {
  if (address !== undefined) return <FixedAddress address={address} reloadKey={reloadKey} />;
  // Only a loopback address boots the pane; anything else is ignored.
  // What is checked is what is loaded: the normalised href.
  const start = initialAddress ? loopbackUrl(initialAddress) : null;
  return (
    <SwitchablePane
      workspaceId={workspaceId}
      initialPort={initialPort ?? (start ? portOfAddress(start) : null)}
      initialAddress={start}
    />
  );
}

/** Try it TI-3: one address, nothing to choose. Only a loopback address is
 *  loaded, as `loopbackUrl` normalised it; nothing else is navigated. */
function FixedAddress({ address, reloadKey }: { address: string; reloadKey: number }) {
  const url = loopbackUrl(address);
  return (
    <div className="browser-pane browser-pane-fixed">
      <div className="browser-body">
        {url ? (
          <iframe
            key={`${url}-${reloadKey}`}
            src={url}
            className="browser-iframe"
            title="Preview of your app"
            sandbox={SANDBOX}
          />
        ) : (
          <div className="browser-empty">
            <p>No address to show yet.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function SwitchablePane({
  workspaceId,
  initialPort,
  initialAddress,
}: {
  workspaceId: string;
  initialPort: number | null;
  initialAddress: string | null;
}) {
  // Only the two surviving modes; default to `localhost` (the
  // dev-server preview is the dominant use case).
  const persistedMode = useUi((s) => s.browserMode[workspaceId] ?? "localhost");
  const setMode = useUi((s) => s.setBrowserMode);
  const mode = persistedMode;

  return (
    <div className="browser-pane">
      <div className="browser-tabs">
        <Segmented
          label="What to preview"
          value={mode}
          onChange={(m) => setMode(workspaceId, m)}
          options={[
            { value: "localhost", label: "Localhost" },
            { value: "generic", label: "Web page" },
          ]}
        />
      </div>
      <div className="browser-body">
        {mode === "localhost" && (
          <LocalhostMode
            workspaceId={workspaceId}
            initialPort={initialPort}
            initialAddress={initialAddress}
          />
        )}
        {mode === "generic" && <GenericMode />}
      </div>
    </div>
  );
}

// ── Localhost mode ────────────────────────────────────

function LocalhostMode({
  workspaceId: _workspaceId,
  initialPort,
  initialAddress,
}: {
  workspaceId: string;
  initialPort: number | null;
  initialAddress: string | null;
}) {
  const [ports, setPorts] = useState<number[] | null>(null);
  const [selected, setSelected] = useState<number | null>(initialPort);
  const [refreshTick, setRefreshTick] = useState(0);
  // Try it TI-3: the first probe never overrides a port the caller chose —
  // its server may still be starting, and another one answering (the main
  // project's on 3000) is not it. A Rescan the person asks for may.
  const firstProbe = useRef(true);

  async function probe() {
    const keepInitial = firstProbe.current && initialPort != null;
    firstProbe.current = false;
    setPorts(null);
    try {
      const found = await probeLocalhostPorts();
      setPorts(found);
      if (found.length > 0 && !keepInitial) {
        setSelected((cur) => (cur == null || !found.includes(cur) ? found[0] : cur));
      }
    } catch {
      setPorts([]);
    }
  }

  useEffect(() => {
    probe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const url = selected
    ? initialAddress && selected === initialPort
      ? initialAddress
      : `http://localhost:${selected}`
    : null;
  // The chosen port is listed even when the probe has not found it (yet).
  const listed =
    ports == null ? null : selected != null && !ports.includes(selected) ? [selected, ...ports] : ports;

  return (
    <div className="browser-localhost">
      <div className="browser-bar">
        <Select
          label="Dev server"
          mono
          value={listed && listed.length > 0 ? String(selected ?? "") : "none"}
          onChange={(v) => setSelected(Number(v))}
          disabled={!listed || listed.length === 0}
          options={
            listed == null
              ? [{ value: "none", label: "Looking…" }]
              : listed.length === 0
                ? [{ value: "none", label: "No dev server" }]
                : listed.map((p) => ({ value: String(p), label: `localhost:${p}` }))
          }
        />
        <CBtn size="sm" onClick={probe} title="Look for dev servers again">
          Rescan
        </CBtn>
        <CBtn
          size="sm"
          onClick={() => setRefreshTick((t) => t + 1)}
          disabled={!url}
          title="Load the address again, back on its first page"
        >
          Reload
        </CBtn>
      </div>
      {url ? (
        <iframe
          key={`${url}-${refreshTick}`}
          src={url}
          className="browser-iframe"
          title="Your running app"
          sandbox={SANDBOX}
        />
      ) : (
        <div className="browser-empty">
          <p>
            {ports == null
              ? "Looking for a dev server…"
              : "No dev server found. Start one in a terminal, then Rescan."}
          </p>
          {ports != null && (
            <Details summary="Ports tried">
              Plyloft looks on localhost ports {PROBED_PORTS}.
            </Details>
          )}
        </div>
      )}
    </div>
  );
}

// ── Generic mode ─────────────────────────────────────

function GenericMode() {
  const [draftUrl, setDraftUrl] = useState<string>("");
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  function go() {
    let url = draftUrl.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }
    setLoadedUrl(url);
  }

  return (
    <div className="browser-localhost">
      <div className="browser-bar">
        <TextField
          label="Address"
          mono
          wide
          value={draftUrl}
          onChange={setDraftUrl}
          onEnter={() => go()}
          placeholder="https://example.com"
        />
        <CBtn size="sm" onClick={go}>
          Go
        </CBtn>
        <CBtn
          size="sm"
          onClick={() => setRefreshTick((t) => t + 1)}
          disabled={!loadedUrl}
          title="Reload the preview"
        >
          Reload
        </CBtn>
      </div>
      {loadedUrl ? (
        <iframe
          key={`${loadedUrl}-${refreshTick}`}
          src={loadedUrl}
          className="browser-iframe"
          title="Browser"
          sandbox={SANDBOX}
          referrerPolicy="no-referrer"
        />
      ) : (
        <div className="browser-empty">
          <p>Type an address, then Go.</p>
          <Details summary="Why a page may stay blank">
            Some sites refuse to be shown inside another app (X-Frame-Options
            or a strict Content-Security-Policy).
          </Details>
        </div>
      )}
    </div>
  );
}
