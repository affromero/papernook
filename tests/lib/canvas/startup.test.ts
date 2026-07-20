import { describe, expect, it, vi } from "vitest";
import { reconcileStartupMigration } from "@/lib/canvas/startup";

class ConflictError extends Error {}

describe("canvas startup migration", () => {
  it("saves a migrated canvas against its loaded version", async () => {
    const save = vi.fn(async () => '"saved"');
    const reload = vi.fn(async () => '"latest"');

    const etag = await reconcileStartupMigration({
      etag: '"loaded"',
      migrate: async () => true,
      save,
      reload,
      isConflict: (error) => error instanceof ConflictError,
    });

    expect(etag).toBe('"saved"');
    expect(save).toHaveBeenCalledWith('"loaded"');
    expect(reload).not.toHaveBeenCalled();
  });

  it("accepts a competing mount's completed migration", async () => {
    const migrate = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const save = vi.fn(async () => {
      throw new ConflictError();
    });
    const reload = vi.fn(async () => '"latest"');

    const etag = await reconcileStartupMigration({
      etag: '"loaded"',
      migrate,
      save,
      reload,
      isConflict: (error) => error instanceof ConflictError,
    });

    expect(etag).toBe('"latest"');
    expect(save).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reapplies migration to the latest canvas before retrying", async () => {
    const save = vi
      .fn<(etag: string) => Promise<string>>()
      .mockRejectedValueOnce(new ConflictError())
      .mockResolvedValueOnce('"saved-latest"');
    const reload = vi.fn(async () => '"latest"');

    const etag = await reconcileStartupMigration({
      etag: '"loaded"',
      migrate: async () => true,
      save,
      reload,
      isConflict: (error) => error instanceof ConflictError,
    });

    expect(etag).toBe('"saved-latest"');
    expect(save).toHaveBeenNthCalledWith(1, '"loaded"');
    expect(save).toHaveBeenNthCalledWith(2, '"latest"');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not hide non-conflict failures", async () => {
    await expect(
      reconcileStartupMigration({
        etag: '"loaded"',
        migrate: async () => true,
        save: async () => {
          throw new Error("storage unavailable");
        },
        reload: async () => '"latest"',
        isConflict: (error) => error instanceof ConflictError,
      }),
    ).rejects.toThrow("storage unavailable");
  });

  it("stops after three competing migration saves", async () => {
    const save = vi.fn(async () => {
      throw new ConflictError();
    });
    const reload = vi.fn(async () => '"latest"');

    await expect(
      reconcileStartupMigration({
        etag: '"loaded"',
        migrate: async () => true,
        save,
        reload,
        isConflict: (error) => error instanceof ConflictError,
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(save).toHaveBeenCalledTimes(3);
    expect(reload).toHaveBeenCalledTimes(3);
  });
});
