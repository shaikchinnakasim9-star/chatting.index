const pointerMedia = window.matchMedia("(hover: hover) and (pointer: fine)");
const reducedMotionMedia = window.matchMedia("(prefers-reduced-motion: reduce)");

export function initLiquidGlassButtons(root: Document = document): () => void {
  if (!pointerMedia.matches || reducedMotionMedia.matches) {
    return () => {};
  }

  let activeButton: HTMLButtonElement | null = null;
  let pendingFrame = 0;
  let pendingPointer: { button: HTMLButtonElement; x: number; y: number } | null = null;

  function clearButton(button: HTMLButtonElement | null) {
    if (!button) return;
    button.style.removeProperty("--pointer-x");
    button.style.removeProperty("--pointer-y");
    if (activeButton === button) activeButton = null;
  }

  function handlePointerMove(event: PointerEvent) {
    if (event.pointerType !== "mouse" || !(event.target instanceof Element)) return;

    const button = event.target.closest("button");
    if (!(button instanceof HTMLButtonElement) || button.disabled) {
      clearButton(activeButton);
      return;
    }

    if (activeButton !== button) clearButton(activeButton);
    activeButton = button;
    const bounds = button.getBoundingClientRect();
    pendingPointer = {
      button,
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    };

    if (!pendingFrame) {
      pendingFrame = requestAnimationFrame(() => {
        if (pendingPointer) {
          pendingPointer.button.style.setProperty("--pointer-x", `${pendingPointer.x}px`);
          pendingPointer.button.style.setProperty("--pointer-y", `${pendingPointer.y}px`);
        }
        pendingFrame = 0;
      });
    }
  }

  function handlePointerOut(event: PointerEvent) {
    if (!(event.target instanceof Element) || !(event.target.closest("button") instanceof HTMLButtonElement)) return;

    const button = event.target.closest("button");
    if (!(button instanceof HTMLButtonElement)) return;
    if (event.relatedTarget instanceof Node && button.contains(event.relatedTarget)) return;
    clearButton(button);
  }

  root.addEventListener("pointermove", handlePointerMove, { passive: true });
  root.addEventListener("pointerout", handlePointerOut);

  return () => {
    root.removeEventListener("pointermove", handlePointerMove);
    root.removeEventListener("pointerout", handlePointerOut);
    if (pendingFrame) cancelAnimationFrame(pendingFrame);
    clearButton(activeButton);
  };
}
