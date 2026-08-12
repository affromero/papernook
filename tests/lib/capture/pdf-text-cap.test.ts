import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_EXTRACTED_TEXT_BYTES } from "@/lib/pdf-limits";

/**
 * PDF compression is unbounded, so pdftotext output is attacker-controlled in
 * size. Extraction must stop at a fixed ceiling instead of buffering whatever
 * the file expands into.
 */

let killed: string[];

/** A pdftotext that never stops emitting text, like a decompression bomb. */
function mockEndlessPdftotext(): void {
  killed = [];
  vi.doMock("node:child_process", () => ({
    spawn: () => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: Readable;
        kill: (signal: string) => void;
      };
      let stopped = false;
      child.kill = (signal: string) => {
        killed.push(signal);
        stopped = true;
        queueMicrotask(() => child.emit("close", 0));
      };
      const megabyte = "x".repeat(1024 * 1024);
      child.stdout = new Readable({
        read() {
          if (stopped) return;
          this.push(megabyte);
        },
      });
      return child;
    },
  }));
}

beforeEach(() => {
  vi.resetModules();
  mockEndlessPdftotext();
});

afterEach(() => {
  vi.doUnmock("node:child_process");
});

describe("pdf text extraction limits", () => {
  it("stops at the ceiling instead of buffering an unbounded expansion", async () => {
    const { extractPdfText } = await import("@/lib/capture/analyze");

    const text = await extractPdfText("/tmp/bomb.pdf");

    expect(text.length).toBe(MAX_EXTRACTED_TEXT_BYTES);
    expect(killed).toContain("SIGTERM");
  });
});
