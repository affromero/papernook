import { describe, expect, it, vi } from "vitest";
import { createPdfAutosave } from "@/lib/pdf/autosave";

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("PDF autosave coordinator", () => {
  it("serializes a later edit after an in-flight save", async () => {
    vi.useFakeTimers();
    const first = deferred();
    const saves: Promise<void>[] = [first.promise, Promise.resolve()];
    const save = vi.fn(async () => {
      await saves.shift();
    });
    const states: { dirty: boolean; saving: boolean }[] = [];
    const autosave = createPdfAutosave({
      delayMs: 100,
      save,
      onChange: ({ dirty, saving }) => states.push({ dirty, saving }),
    });

    autosave.markDirty();
    await vi.advanceTimersByTimeAsync(100);
    expect(save).toHaveBeenCalledTimes(1);

    autosave.markDirty();
    first.resolve();
    await first.promise;
    await vi.runAllTimersAsync();

    expect(save).toHaveBeenCalledTimes(2);
    expect(autosave.state()).toMatchObject({ dirty: false, saving: false });
    expect(states).toContainEqual({ dirty: true, saving: false });
    vi.useRealTimers();
  });

  it("retains dirty state after a failed save and retries explicitly", async () => {
    const save = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("conflict"))
      .mockResolvedValueOnce();
    const autosave = createPdfAutosave({
      delayMs: 60_000,
      save,
      onChange: () => undefined,
    });

    autosave.markDirty();
    await autosave.flush();
    expect(autosave.state()).toMatchObject({
      dirty: true,
      saving: false,
      error: expect.any(Error),
    });

    await autosave.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(autosave.state()).toMatchObject({ dirty: false, error: null });
    autosave.stop();
  });

  it("does not save while remote changes have paused the coordinator", async () => {
    const save = vi.fn(async () => undefined);
    const autosave = createPdfAutosave({
      delayMs: 0,
      save,
      onChange: () => undefined,
    });

    autosave.pause();
    autosave.markDirty();
    await autosave.flush();
    expect(save).not.toHaveBeenCalled();

    autosave.resume();
    await autosave.flush();
    expect(save).toHaveBeenCalledOnce();
    autosave.stop();
  });
});
