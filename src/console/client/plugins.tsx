import { createContext, useContext, type ComponentType, type ReactNode } from 'react';

type IconComponent = ComponentType<{ className?: string }>;

/** A right-side panel a plugin mounts in one of the console's panel slots. Only the first plugin
 * (in `plugins` order) that fills a slot is used; the slot's toggle button is hidden when no
 * plugin fills it. */
export interface ConsolePanel<P = object> {
  /** toggle button tooltip / aria-label, e.g. 'Toggle chat' */
  label: string;
  icon?: IconComponent;
  component: ComponentType<P>;
}

/** Props the workspace screen's panel receives. */
export interface WorkspacePanelProps {
  workspaceId: string;
  /** call after the panel changed workspace data (e.g. an agent edited tabs) — the tab strip refetches */
  onWorkspaceChanged: () => void;
}

/**
 * What a plugin's console module (`RatchetPlugin.console`) default-exports. Bundled into the
 * console through the `ratchet:plugins` virtual module, so it runs in the browser — import React,
 * `@tanstack/react-query` and `@egig/ratchet/console/client` (which also exports the console's
 * router: `Link`, `useNavigate`, `useParams`, ...), never server code — and never `react-router`:
 * the console doesn't run on it, so its hooks throw outside a react-router `<Router>`.
 */
export interface ConsolePlugin {
  name: string;
  /** pages inside the console shell (`Layout`), matched before the generic `:model/*` route — so a
   * path equal to a model name (e.g. `workflows`) replaces that model's generic list screen */
  routes?: Array<{ path: string; element: ReactNode }>;
  /** right-side panel of the console shell */
  shellPanel?: ConsolePanel;
  /** right-side panel of the workspace screen */
  workspacePanel?: ConsolePanel<WorkspacePanelProps>;
}

const ConsolePluginsContext = createContext<readonly ConsolePlugin[]>([]);

export function ConsolePluginsProvider({ plugins, children }: { plugins: readonly ConsolePlugin[]; children: ReactNode }) {
  return <ConsolePluginsContext.Provider value={plugins}>{children}</ConsolePluginsContext.Provider>;
}

export function useConsolePlugins(): readonly ConsolePlugin[] {
  return useContext(ConsolePluginsContext);
}

/** The panel filling `slot`, or `undefined` when no plugin fills it. */
export function useConsolePanel<K extends 'shellPanel' | 'workspacePanel'>(slot: K): ConsolePlugin[K] | undefined {
  return useConsolePlugins().find((p) => p[slot])?.[slot];
}
