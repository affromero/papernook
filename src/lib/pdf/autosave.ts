export interface PdfAutosaveState {
  dirty: boolean;
  saving: boolean;
  error: Error | null;
}

interface PdfAutosaveOptions {
  delayMs: number;
  save(): Promise<void>;
  onChange(state: PdfAutosaveState): void;
}

export interface PdfAutosaveCoordinator {
  markDirty(): void;
  flush(): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
  state(): PdfAutosaveState;
}

export function createPdfAutosave({
  delayMs,
  save,
  onChange,
}: PdfAutosaveOptions): PdfAutosaveCoordinator {
  let revision = 0;
  let savedRevision = 0;
  let saving = false;
  let paused = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let error: Error | null = null;

  const snapshot = (): PdfAutosaveState => ({
    dirty: revision > savedRevision,
    saving,
    error,
  });

  const emit = (): void => onChange(snapshot());

  const clearTimer = (): void => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };

  const schedule = (): void => {
    clearTimer();
    if (stopped || paused || saving || error || revision <= savedRevision) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delayMs);
  };

  const flush = async (): Promise<void> => {
    clearTimer();
    if (stopped || paused || saving || revision <= savedRevision) return;

    const savingRevision = revision;
    saving = true;
    error = null;
    emit();

    try {
      await save();
      savedRevision = Math.max(savedRevision, savingRevision);
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause
          : new Error("Annotations could not be saved.");
    } finally {
      saving = false;
      emit();
      schedule();
    }
  };

  return {
    markDirty() {
      if (stopped) return;
      revision += 1;
      error = null;
      emit();
      schedule();
    },
    flush,
    pause() {
      paused = true;
      clearTimer();
    },
    resume() {
      if (stopped) return;
      paused = false;
      error = null;
      emit();
      schedule();
    },
    stop() {
      stopped = true;
      clearTimer();
    },
    state: snapshot,
  };
}
