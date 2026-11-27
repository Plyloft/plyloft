// In-page helpers for scenarios: find visible controls by label/text, and a
// handle on the app's own stores (exposed by the harness entry).
/* eslint-disable */
(function () {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  function shown(el) {
    if (!el || !el.getClientRects().length) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false;
    if (el.closest("[inert]")) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  const CONTROLS = "button,[role=menuitem],[role=menuitemradio],[role=tab],[role=option],[role=radio],[role=switch],[role=checkbox],a,summary,[role=button],[role=link],[role=treeitem],[role=row],label";
  window.__find = function (q, opts) {
    opts = opts || {};
    const els = [...document.querySelectorAll(opts.sel || CONTROLS)].filter(shown);
    const within = opts.within ? els.filter((e) => e.closest(opts.within)) : els;
    const L = within;
    return (
      L.find((e) => norm(e.getAttribute("aria-label")) === q) ||
      L.find((e) => norm(e.innerText) === q) ||
      L.find((e) => norm(e.getAttribute("title")) === q) ||
      (opts.exact ? null : L.find((e) => norm(e.innerText).startsWith(q))) ||
      (opts.exact ? null : L.find((e) => norm(e.getAttribute("aria-label")).startsWith(q))) ||
      (opts.exact ? null : L.find((e) => norm(e.getAttribute("title")).startsWith(q))) ||
      null
    );
  };
  window.__hasText = (t) => norm(document.body.innerText).includes(t);
  window.__P = function () {
    const S = window.__ply.stores;
    const get = (n) => S[`/src/store/${n}.ts`];
    const uiMod = get("uiStore");
    const ws = get("workspaceStore").useWorkspaces.getState().activeId;
    return {
      S, get, uiMod, ws,
      ui: () => uiMod.useUi.getState(),
      tiles: () => get("tileStore").useTiles.getState(),
      tilesStore: get("tileStore").useTiles,
      kanban: () => get("kanbanStore").useKanban.getState(),
      toast: get("toastStore"),
      wsStore: get("workspaceStore").useWorkspaces,
      settings: get("settingsStore").useSettings,
      H: window.__harness,
      seed: window.__HARNESS_SEED__,
    };
  };
})();
