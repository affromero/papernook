import { describe, expect, it } from "vitest";
import {
  MAX_READING_SCALE,
  MIN_READING_SCALE,
  newerReadingPosition,
  parseReadingPosition,
  scaleTransfers,
  readingPositionFromUnknown,
  readingPositionKey,
  serializeReadingPosition,
} from "@/lib/pdf/view/reading-position";

describe("readingPositionKey", () => {
  it("keeps positions of different papers apart", () => {
    const key = readingPositionKey("ml", "attention", "andres");
    expect(key).not.toBe(readingPositionKey("ml", "attention-v2", "andres"));
    expect(key).not.toBe(readingPositionKey("nlp", "attention", "andres"));
    expect(key).toContain("ml");
    expect(key).toContain("attention");
  });

  it("keeps profiles on a shared browser apart", () => {
    expect(readingPositionKey("ml", "attention", "andres")).not.toBe(
      readingPositionKey("ml", "attention", "guest"),
    );
  });
});

describe("parseReadingPosition", () => {
  it("round-trips a serialized position, timestamp included", () => {
    const stored = serializeReadingPosition({
      page: 7,
      scale: 1.25,
      updatedAt: 1_756_600_000_000,
      viewport: 1180,
    });
    expect(parseReadingPosition(stored)).toEqual({
      page: 7,
      scale: 1.25,
      updatedAt: 1_756_600_000_000,
      viewport: 1180,
    });
  });

  it("returns null when nothing was stored", () => {
    expect(parseReadingPosition(null)).toBeNull();
    expect(parseReadingPosition(undefined)).toBeNull();
    expect(parseReadingPosition("")).toBeNull();
  });

  it("returns null for malformed or non-object values", () => {
    expect(parseReadingPosition("{not json")).toBeNull();
    expect(parseReadingPosition("42")).toBeNull();
    expect(parseReadingPosition("null")).toBeNull();
    expect(parseReadingPosition('"7"')).toBeNull();
  });

  it("rejects pages that are not positive integers", () => {
    expect(parseReadingPosition('{"page":0,"scale":1}')).toBeNull();
    expect(parseReadingPosition('{"page":-3,"scale":1}')).toBeNull();
    expect(parseReadingPosition('{"page":2.5,"scale":1}')).toBeNull();
    expect(parseReadingPosition('{"page":"2","scale":1}')).toBeNull();
    expect(parseReadingPosition('{"scale":1}')).toBeNull();
  });

  it("treats a position written before timestamps as infinitely old", () => {
    expect(parseReadingPosition('{"page":3,"scale":1.5}')).toEqual({
      page: 3,
      scale: 1.5,
      updatedAt: 0,
      viewport: 0,
    });
  });

  it("degrades a malformed timestamp to 0 instead of losing the page", () => {
    for (const updatedAt of ['"soon"', "-5", "null", "1e999"]) {
      expect(
        parseReadingPosition(`{"page":3,"scale":1.5,"updatedAt":${updatedAt}}`),
      ).toEqual({ page: 3, scale: 1.5, updatedAt: 0, viewport: 0 });
    }
  });

  it("clamps out-of-range zoom levels but keeps the page", () => {
    expect(
      parseReadingPosition(
        JSON.stringify({ page: 9, scale: MIN_READING_SCALE / 2 }),
      ),
    ).toEqual({ page: 9, scale: MIN_READING_SCALE, updatedAt: 0, viewport: 0 });
    expect(
      parseReadingPosition(
        JSON.stringify({ page: 9, scale: MAX_READING_SCALE * 2 }),
      ),
    ).toEqual({ page: 9, scale: MAX_READING_SCALE, updatedAt: 0, viewport: 0 });
  });

  it("rejects zoom values that are not finite numbers", () => {
    expect(parseReadingPosition('{"page":1,"scale":"1"}')).toBeNull();
    expect(parseReadingPosition('{"page":1,"scale":1e999}')).toBeNull();
    expect(parseReadingPosition('{"page":1,"scale":null}')).toBeNull();
    expect(parseReadingPosition('{"page":1}')).toBeNull();
  });

  it("accepts the zoom bounds themselves", () => {
    expect(
      parseReadingPosition(
        JSON.stringify({ page: 1, scale: MIN_READING_SCALE }),
      ),
    ).toEqual({ page: 1, scale: MIN_READING_SCALE, updatedAt: 0, viewport: 0 });
    expect(
      parseReadingPosition(
        JSON.stringify({ page: 1, scale: MAX_READING_SCALE }),
      ),
    ).toEqual({ page: 1, scale: MAX_READING_SCALE, updatedAt: 0, viewport: 0 });
  });

  it("ignores extra fields from an older or foreign shape", () => {
    expect(
      parseReadingPosition('{"page":3,"scale":1.5,"scrollTop":120}'),
    ).toEqual({ page: 3, scale: 1.5, updatedAt: 0, viewport: 0 });
  });
});

describe("readingPositionFromUnknown", () => {
  it("accepts an already-parsed API payload", () => {
    expect(
      readingPositionFromUnknown({
        page: 4,
        scale: 2,
        updatedAt: 17,
        viewport: 0,
      }),
    ).toEqual({ page: 4, scale: 2, updatedAt: 17, viewport: 0 });
    expect(readingPositionFromUnknown(null)).toBeNull();
    expect(readingPositionFromUnknown("position")).toBeNull();
    expect(readingPositionFromUnknown({ page: 0, scale: 1 })).toBeNull();
  });
});

describe("newerReadingPosition", () => {
  const older = { page: 2, scale: 1, updatedAt: 1_000, viewport: 0 };
  const newer = { page: 9, scale: 1.5, updatedAt: 2_000, viewport: 0 };

  it("picks the more recently written position from either side", () => {
    expect(newerReadingPosition(older, newer)).toBe(newer);
    expect(newerReadingPosition(newer, older)).toBe(newer);
  });

  it("falls back to whichever side exists", () => {
    expect(newerReadingPosition(null, newer)).toBe(newer);
    expect(newerReadingPosition(older, null)).toBe(older);
    expect(newerReadingPosition(null, null)).toBeNull();
  });

  it("keeps the first argument on a tie, so callers can prefer local", () => {
    const localCopy = { ...newer, page: 5 };
    expect(newerReadingPosition(localCopy, newer)).toBe(localCopy);
    const untimed = { page: 1, scale: 1, updatedAt: 0, viewport: 0 };
    expect(newerReadingPosition(untimed, { ...untimed, page: 8 })).toBe(
      untimed,
    );
  });

  it("lets a timestamped position beat a pre-timestamp one", () => {
    const untimed = { page: 12, scale: 1, updatedAt: 0, viewport: 0 };
    expect(newerReadingPosition(untimed, older)).toBe(older);
  });
});

describe("scaleTransfers", () => {
  const at = (viewport: number) => ({
    page: 1,
    scale: 0.95,
    updatedAt: 1,
    viewport,
  });

  it("transfers zoom between comparable surfaces only", () => {
    expect(scaleTransfers(at(1180), 1180)).toBe(true);
    expect(scaleTransfers(at(1180), 1000)).toBe(true);
    expect(scaleTransfers(at(1180), 810)).toBe(false); // desktop -> tablet
    expect(scaleTransfers(at(810), 1180)).toBe(false); // tablet -> desktop
  });

  it("never transfers zoom from an unknown viewport", () => {
    expect(scaleTransfers(at(0), 1180)).toBe(false);
    expect(scaleTransfers(at(1180), 0)).toBe(false);
  });
});
