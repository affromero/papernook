interface StartupMigrationOptions {
  etag: string;
  migrate: () => Promise<boolean>;
  save: (etag: string) => Promise<string>;
  reload: () => Promise<string>;
  isConflict: (error: unknown) => boolean;
}

const MAX_STARTUP_MIGRATION_ATTEMPTS = 3;

/**
 * Startup migrations are maintenance, not user edits. If another mount or
 * device completes the same migration first, reload its result instead of
 * locking the canvas behind a conflict warning.
 */
export async function reconcileStartupMigration({
  etag,
  migrate,
  save,
  reload,
  isConflict,
}: StartupMigrationOptions): Promise<string> {
  let currentEtag = etag;
  let lastConflict: unknown;

  for (
    let attempt = 0;
    attempt < MAX_STARTUP_MIGRATION_ATTEMPTS;
    attempt += 1
  ) {
    if (!(await migrate())) return currentEtag;

    try {
      return await save(currentEtag);
    } catch (error) {
      if (!isConflict(error)) throw error;
      lastConflict = error;
      currentEtag = await reload();
    }
  }

  if (!(await migrate())) return currentEtag;
  throw lastConflict;
}
