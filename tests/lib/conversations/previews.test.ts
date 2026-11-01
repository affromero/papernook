import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  previewBytes,
  readPreview,
  savePreview,
} from "@/lib/conversations/previews/cache";
import {
  previewHash,
  messagePreviews,
} from "@/lib/conversations/previews/source";
import { snapshotBridge } from "@/lib/conversations/formats/mcp";
import { pngFixture } from "../../helpers/png";

const directories: string[] = [];
const temporary = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "previews-"));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("saved visual exports", () => {
  it("matches only current executable display fences and preserves exact source identities", () => {
    const source = "export default function App(){return <p>42</p>}";
    expect(
      messagePreviews(
        `Example \`react-preview\`\n\n\`\`\`react-preview\n${source}\n\`\`\``,
        {},
      ),
    ).toEqual([
      { kind: "react-preview", hash: previewHash("react-preview", source) },
    ]);
    expect(previewHash("react-preview", source)).not.toBe(
      previewHash("html-preview", source),
    );
  });
  it("saves a bounded real PNG under its current source and rejects malformed or oversized pixels", () => {
    const base = temporary();
    const bytes = pngFixture();
    const uri = `data:image/png;base64,${bytes.toString("base64")}`;
    expect(previewBytes(uri)).toEqual(bytes);
    savePreview(base, previewHash("mermaid", "graph TD; A-->B"), bytes);
    expect(readPreview(base, "mermaid", "graph TD; A-->B")).toEqual(bytes);
    expect(readPreview(base, "mermaid", "graph TD; A-->C")).toBeNull();
    expect(() => previewBytes(uri + "=")).toThrow(/encoding/);
    const corrupt = Buffer.from(bytes);
    corrupt[40] ^= 1;
    expect(() =>
      previewBytes(`data:image/png;base64,${corrupt.toString("base64")}`),
    ).toThrow(/checksum/);
    expect(() =>
      previewBytes(
        `data:image/png;base64,${pngFixture(4097).toString("base64")}`,
      ),
    ).toThrow(/dimensions/);
    expect(() => savePreview(base, "../escape", bytes)).toThrow(/identity/);
    expect(() =>
      previewBytes(
        `data:image/png;base64,${pngFixture(1, 1, true).toString("base64")}`,
      ),
    ).toThrow(/Animated PNG/);
  });
  it("enforces aggregate image count and recovers its own interrupted atomic writes", () => {
    const base = temporary();
    const bytes = pngFixture();
    for (let index = 0; index < 64; index++)
      savePreview(base, previewHash("mermaid", String(index)), bytes);
    expect(() =>
      savePreview(base, previewHash("mermaid", "overflow"), bytes),
    ).toThrow(/cache limit/);
    const hash = previewHash("mermaid", "0");
    const interrupted = path.join(
      base,
      "previews",
      `${hash}.png.00000000-0000-0000-0000-000000000000.tmp`,
    );
    fs.writeFileSync(interrupted, "partial");
    savePreview(base, hash, bytes);
    expect(fs.existsSync(interrupted)).toBe(false);
    expect(fs.readdirSync(path.join(base, "previews"))).toHaveLength(64);
  });
});

describe("read-only MCP display handshake", () => {
  it("delivers exported data once after initialization and refuses all host actions", () => {
    const bridge = snapshotBridge(
      JSON.stringify({
        template: "<p>Saved</p>",
        structuredContent: { answer: 42 },
        _meta: { secret: "hidden" },
      }),
    )!;
    expect(
      bridge({ jsonrpc: "2.0", method: "ui/notifications/initialized" }),
    ).toEqual([]);
    const initialized = bridge({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/initialize",
      params: { hostCapabilities: { tools: true } },
    });
    expect(initialized).toMatchObject([
      { result: { hostCapabilities: {}, protocolVersion: "2026-01-26" } },
    ]);
    expect(JSON.stringify(initialized)).not.toContain("hidden");
    expect(
      bridge({ jsonrpc: "2.0", method: "ui/notifications/initialized" }),
    ).toEqual([
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input",
        params: { arguments: {} },
      },
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { content: [], structuredContent: { answer: 42 } },
      },
    ]);
    expect(
      bridge({ jsonrpc: "2.0", method: "ui/notifications/initialized" }),
    ).toEqual([]);
    expect(
      bridge({ jsonrpc: "2.0", id: 2, method: "ui/initialize" }),
    ).toMatchObject([{ error: { code: -32601 } }]);
    expect(
      bridge({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "deleteAccount" },
      }),
    ).toMatchObject([{ error: { code: -32601 } }]);
    expect(
      bridge({ jsonrpc: "2.0", id: "x".repeat(129), method: "ping" }),
    ).toEqual([]);
    for (let index = 0; index < 32; index++)
      bridge({ jsonrpc: "2.0", id: index, method: "ping" });
    expect(bridge({ jsonrpc: "2.0", id: 99, method: "ping" })).toEqual([]);
  });
});
