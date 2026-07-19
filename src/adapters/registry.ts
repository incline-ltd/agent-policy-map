import type { AgentName } from "../types.js";
import type { AgentAdapter } from "./types.js";
import { codexAdapter } from "./codex.js";
import { claudeAdapter } from "./claude.js";
import { cursorAdapter } from "./cursor.js";
import { copilotAdapter } from "./copilot.js";

export const ADAPTERS: Record<AgentName, AgentAdapter> = {
  codex: codexAdapter,
  claude: claudeAdapter,
  cursor: cursorAdapter,
  copilot: copilotAdapter,
};

export const AGENT_NAMES: AgentName[] = ["codex", "claude", "cursor", "copilot"];

export function isAgentName(v: string): v is AgentName {
  return (AGENT_NAMES as string[]).includes(v);
}
