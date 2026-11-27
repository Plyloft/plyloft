import { useEffect } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FALLBACK_CATALOG, type ModelCatalog } from "../lib/modelCatalog";

/**
 * 1.169.0 (A1): the model menus' catalog (`model_catalog.rs`). Read when a
 * menu first shows — which also lets the app read Codex's list and the
 * site's file again when they are due — and replaced whenever the app says
 * it changed (`model-catalog-changed`). Until then, and when the app can't
 * answer, each vendor's levels with no model suggestions: the fields stay
 * free text either way.
 */

interface ModelCatalogState {
  catalog: ModelCatalog;
  refresh: () => Promise<void>;
}

function readable(value: unknown): value is ModelCatalog {
  const c = value as ModelCatalog | null | undefined;
  return !!c && Array.isArray(c.claude?.models) && Array.isArray(c.codex?.models);
}

let unlisten: UnlistenFn | null = null;
let listening: Promise<void> | null = null;
let asking: Promise<void> | null = null;

export const useModelCatalogStore = create<ModelCatalogState>((set) => ({
  catalog: FALLBACK_CATALOG,
  refresh: async () => {
    // Finding 6: listening before asking, so a change the app sends while
    // the answer is on its way is never missed.
    if (!listening) {
      listening = listen<ModelCatalog>("model-catalog-changed", (e) => {
        if (readable(e.payload)) set({ catalog: e.payload });
      }).then(
        (off) => {
          unlisten = off;
        },
        () => {
          listening = null;
        },
      );
    }
    // Menus that mount together share one ask.
    if (!asking) {
      const ready = listening;
      asking = (async () => {
        await ready;
        try {
          const next = await invoke<ModelCatalog>("model_catalog_get");
          if (readable(next)) set({ catalog: next });
        } catch {
          // The fallback stays.
        }
      })().finally(() => {
        asking = null;
      });
    }
    await asking;
  },
}));

/** The catalog, read (again) when the calling menu mounts. */
export function useModelCatalog(): ModelCatalog {
  const catalog = useModelCatalogStore((s) => s.catalog);
  useEffect(() => {
    void useModelCatalogStore.getState().refresh();
  }, []);
  return catalog;
}

/** For the behavioural UI tests: forget the subscription and the catalog. */
export function resetModelCatalogForTests(catalog: ModelCatalog = FALLBACK_CATALOG): void {
  const off = unlisten;
  unlisten = null;
  listening = null;
  asking = null;
  void off?.();
  useModelCatalogStore.setState({ catalog });
}
