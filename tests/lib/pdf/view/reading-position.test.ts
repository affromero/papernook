import { describe, expect, it } from "vitest";
import {
  MAX_READING_SCALE,
  MIN_READING_SCALE,
  parseReadingPosition,
  readingPositionKey,
  serializeReadingPosition,
} from "@/lib/pdf/view/reading-position";

describe("readingPositionKey", () => {
  it("keeps positions of different papers apart", () => {
    const key = readingPositionKey("ml", "attention");
    expect(key).not.toBe(readingPositionKey("ml", "attention-v2"));
    expect(key).not.toBe(readingPositionKey("nlp", "attention"));
    expect(key).toContain("ml");
    expect(key).toContain("attention");
  });
});

describe("parseReadingPosition", () => {
  it("round-trips a serialized position", () => {
    const stored = serializeReadingPosition({ page: 7, scale: 1.25 });
    expect(parseReadingPosition(stored)).toEqual({ page: 7, scale: 1.25 });
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

  it("clamps out-of-range zoom levels but keeps the page", () => {
    expect(
      parseReadingPosition(
        JSON.stringify({ page: 9, scale: MIN_READING_SCALE / 2 }),
      ),
    ).toEqual({ page: 9, scale: MIN_READING_SCALE });
    expect(
      parseReadingPosition(
        JSON.stringify({ page: 9, scale: MAX_READING_SCALE * 2 }),
      ),
    ).toEqual({ page: 9, scale: MAX_READING_SCALE });
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
    ).toEqual({ page: 1, scale: MIN_READING_SCALE });
    expect(
      parseReadingPosition(
        JSON.stringify({ page: 1, scale: MAX_READING_SCALE }),
      ),
    ).toEqual({ page: 1, scale: MAX_READING_SCALE });
  });

  it("ignores extra fields from an older or foreign shape", () => {
    expect(
      parseReadingPosition('{"page":3,"scale":1.5,"scrollTop":120}'),
    ).toEqual({ page: 3, scale: 1.5 });
  });
});
