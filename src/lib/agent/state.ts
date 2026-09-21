import { z } from "zod";
import {
  credentialStateSchema,
  initialCredentialState,
} from "thesidedoor-core/configuration";
import { PROVIDER_IDS } from "./types";

export const AGENT_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export const AI_STATE_READY = "papernook-ai-configuration-v1";
export const AI_CREDENTIALS_READY = "papernook-provider-credentials-v1";
export const agentSelectionSchema = z
  .object({
    provider: z.enum(PROVIDER_IDS).optional(),
    model: z.string().optional(),
    effort: z.enum(AGENT_EFFORTS).optional(),
    baseUrl: z.string().optional(),
    webAccess: z.boolean().optional(),
  })
  .strict();
export type AgentConfig = z.infer<typeof agentSelectionSchema>;
export type AgentSelectionUpdate = {
  [Key in keyof AgentConfig]?: AgentConfig[Key] | null;
};
export function applyAgentSelection(
  current: AgentConfig,
  update: AgentSelectionUpdate,
): AgentConfig {
  const config = { ...current };
  if (update.provider !== undefined) {
    if (update.provider) config.provider = update.provider;
    else delete config.provider;
    delete config.model;
    delete config.effort;
    delete config.baseUrl;
  }
  if (update.model !== undefined) {
    delete config.effort;
    if (update.model) config.model = update.model;
    else delete config.model;
  }
  if (update.effort !== undefined) {
    if (update.effort) config.effort = update.effort;
    else delete config.effort;
  }
  if (update.baseUrl !== undefined) {
    if (update.baseUrl) config.baseUrl = update.baseUrl;
    else delete config.baseUrl;
  }
  if (update.webAccess === null) delete config.webAccess;
  else if (update.webAccess !== undefined) config.webAccess = update.webAccess;
  return agentSelectionSchema.parse(config);
}
export type AgentEffort = (typeof AGENT_EFFORTS)[number];
export const aiStateSchema = z.object({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  imports: z.array(z.string()),
  selection: agentSelectionSchema,
  credentials: credentialStateSchema,
});
export type AiState = z.infer<typeof aiStateSchema>;
export const initialAiState = () => ({
  revision: 0,
  imports: [AI_STATE_READY, AI_CREDENTIALS_READY],
  selection: {} as AgentConfig,
  credentials: initialCredentialState(),
});
