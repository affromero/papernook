import { type AgentSelectionUpdate } from "@/lib/agent/state";
import { testAccess } from "./access";
import { initialCredentialState } from "thesidedoor-core/configuration";
import { applyAiConfiguration } from "@/lib/agent/platform/vault";
import { dataRoot } from "@/lib/data-dir";

/** Seed real authoritative state for provider fixtures without creating extra accounts. */
export async function configureTestAgent(
  update: AgentSelectionUpdate,
  credentials?: Record<string, string | number | boolean | null>,
): Promise<void> {
  const { identity } = await testAccess();
  await identity.transact((state) => {
    state.ai.credentials = initialCredentialState();
    applyAiConfiguration(state.ai, update, dataRoot(), credentials);
  });
}

export function setTestAgentModel(model: string | null): Promise<void> {
  return configureTestAgent({ model });
}

export function setTestAgentProvider(
  provider: AgentSelectionUpdate["provider"],
): Promise<void> {
  return configureTestAgent({ provider });
}
