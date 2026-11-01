import { object } from "./schema";

/** Read-only display handshake. Inputs never acquire tools, credentials or host state. */
export function snapshotBridge(
  source: string,
): ((message: unknown) => unknown[]) | null {
  let snapshot: Record<string, unknown> | null;
  try {
    snapshot = object(JSON.parse(source) as unknown);
  } catch {
    return null;
  }
  if (!snapshot || typeof snapshot.template !== "string") return null;
  const data = object(snapshot.structuredContent);
  let phase: "new" | "initialized" | "delivered" = "new";
  let replies = 0;
  return (input) => {
    const message = object(input);
    if (
      message?.jsonrpc !== "2.0" ||
      typeof message.method !== "string" ||
      message.method.length > 200
    )
      return [];
    const id = message.id;
    const request =
      (typeof id === "string" && id.length <= 128) ||
      (typeof id === "number" && Number.isSafeInteger(id));
    if (
      message.method === "ui/notifications/initialized" &&
      id === undefined &&
      phase === "initialized"
    ) {
      phase = "delivered";
      return [
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-input",
          params: { arguments: {} },
        },
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: { content: [], ...(data ? { structuredContent: data } : {}) },
        },
      ];
    }
    if (!request || replies++ >= 32) return [];
    if (message.method === "ui/initialize" && phase === "new") {
      phase = "initialized";
      return [
        {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2026-01-26",
            hostInfo: { name: "Papernook", version: "snapshot" },
            hostCapabilities: {},
            hostContext: {
              theme: "light",
              displayMode: "inline",
              availableDisplayModes: ["inline"],
              locale: "en",
            },
          },
        },
      ];
    }
    if (message.method === "ping") return [{ jsonrpc: "2.0", id, result: {} }];
    return [
      {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message:
            "Imported app snapshots are read-only. Host actions are unavailable.",
        },
      },
    ];
  };
}
