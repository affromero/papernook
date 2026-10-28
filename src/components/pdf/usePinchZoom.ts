"use client";

import { useEffect, useRef, type RefObject } from "react";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";

/**
 * Pencil mode reserves touch for pinch zoom while drawing. Comment mode
 * allows single-finger placement while retaining two-finger zoom.
 */
export function usePinchZoom(
  stageRef: RefObject<HTMLDivElement | null>,
  viewerRef: RefObject<PDFViewer | null>,
  active: boolean,
  allowSingleTouch = false,
): void {
  const pinchDistanceRef = useRef<number | null>(null);
  const pinchGestureRef = useRef(false);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !active) return;
    const reserveTouch = (event: TouchEvent) => {
      if (
        allowSingleTouch &&
        event.touches.length < 2 &&
        !pinchGestureRef.current
      )
        return;
      event.preventDefault();
      event.stopPropagation();
    };
    const touchDistance = (event: TouchEvent): number | null => {
      if (event.touches.length !== 2) return null;
      const first = event.touches[0];
      const second = event.touches[1];
      if (!first || !second) return null;
      return Math.hypot(
        second.clientX - first.clientX,
        second.clientY - first.clientY,
      );
    };
    const beginGesture = (event: TouchEvent) => {
      if (event.touches.length >= 2) pinchGestureRef.current = true;
      reserveTouch(event);
      pinchDistanceRef.current = touchDistance(event);
    };
    const updateGesture = (event: TouchEvent) => {
      reserveTouch(event);
      const nextDistance = touchDistance(event);
      const previousDistance = pinchDistanceRef.current;
      if (!nextDistance || !previousDistance) {
        pinchDistanceRef.current = nextDistance;
        return;
      }
      const first = event.touches[0];
      const second = event.touches[1];
      if (!first || !second) return;
      viewerRef.current?.updateScale({
        drawingDelay: 180,
        scaleFactor: nextDistance / previousDistance,
        origin: [
          (first.clientX + second.clientX) / 2,
          (first.clientY + second.clientY) / 2,
        ],
      });
      pinchDistanceRef.current = nextDistance;
    };
    const endGesture = (event: TouchEvent) => {
      reserveTouch(event);
      if (event.touches.length < 2) pinchDistanceRef.current = null;
      if (event.touches.length === 0) pinchGestureRef.current = false;
    };
    const options: AddEventListenerOptions = {
      capture: true,
      passive: false,
    };
    stage.addEventListener("touchstart", beginGesture, options);
    stage.addEventListener("touchmove", updateGesture, options);
    stage.addEventListener("touchend", endGesture, options);
    stage.addEventListener("touchcancel", endGesture, options);
    return () => {
      pinchDistanceRef.current = null;
      pinchGestureRef.current = false;
      stage.removeEventListener("touchstart", beginGesture, options);
      stage.removeEventListener("touchmove", updateGesture, options);
      stage.removeEventListener("touchend", endGesture, options);
      stage.removeEventListener("touchcancel", endGesture, options);
    };
  }, [active, allowSingleTouch, stageRef, viewerRef]);

  // Desktop trackpad pinch arrives as a wheel event with ctrlKey set
  // (never as touches), so it stays active regardless of pencil mode.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      viewerRef.current?.updateScale({
        drawingDelay: 180,
        scaleFactor: Math.exp(-event.deltaY / 100),
        origin: [event.clientX, event.clientY],
      });
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [stageRef, viewerRef]);
}
