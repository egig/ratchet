import { SparklesIcon, type ConsolePlugin } from '@egig/ratchet/console/client';
import { ConsoleChatPanel } from './ConsoleChatPanel.js';
import { WorkspaceChatPanel } from './WorkspaceChatPanel.js';

/** Agents' console UI — the chat panel in both the console shell and the workspace screen. */
const agentsConsole: ConsolePlugin = {
  name: 'automation-agents',
  shellPanel: { label: 'Toggle chat', icon: SparklesIcon, component: ConsoleChatPanel },
  workspacePanel: { label: 'Toggle chat', icon: SparklesIcon, component: WorkspaceChatPanel },
};

export default agentsConsole;
