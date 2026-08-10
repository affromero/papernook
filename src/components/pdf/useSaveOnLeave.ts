import { useEffect, type RefObject } from "react";
import type { PdfAutosaveCoordinator } from "@/lib/pdf/autosave";

/**
 * Keeps unsaved annotations from being lost on the way out: warns on tab
 * close while dirty, and intercepts same-origin link clicks to flush the
 * autosave before letting the navigation proceed.
 */
export function useSaveOnLeave(
  editable: boolean,
  dirtyRef: RefObject<boolean>,
  autosaveRef: RefObject<PdfAutosaveCoordinator | null>,
): void {
  useEffect(() => {
    if (!editable) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [editable, dirtyRef]);

  useEffect(() => {
    if (!editable) return;
    const saveBeforeClientNavigation = (event: MouseEvent) => {
      if (
        !dirtyRef.current ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target;
      const anchor =
        target instanceof Element
          ? target.closest<HTMLAnchorElement>("a")
          : null;
      if (
        !anchor?.href ||
        anchor.target === "_blank" ||
        anchor.hasAttribute("download")
      ) {
        return;
      }
      const destination = new URL(anchor.href, window.location.href);
      if (
        destination.origin !== window.location.origin ||
        destination.href === window.location.href
      ) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      void (async () => {
        const autosave = autosaveRef.current;
        await autosave?.flush();
        const state = autosave?.state();
        if (state && !state.dirty && !state.saving && !state.error) {
          window.location.assign(destination.href);
        }
      })();
    };
    document.addEventListener("click", saveBeforeClientNavigation, true);
    return () =>
      document.removeEventListener("click", saveBeforeClientNavigation, true);
  }, [editable, dirtyRef, autosaveRef]);
}
