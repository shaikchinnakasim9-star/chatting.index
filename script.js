(function () {
  "use strict";

  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const canTrackPointer = window.matchMedia("(hover: hover) and (pointer: fine)");

  function mount(root = document) {
    const buttons = Array.from(root.querySelectorAll("[data-glass]"));
    const cleanups = [];

    if (canTrackPointer.matches && !prefersReducedMotion.matches) {
      buttons.forEach((button) => {
        let frame = 0;

        function handlePointerMove(event) {
          if (frame) {
            cancelAnimationFrame(frame);
          }

          frame = requestAnimationFrame(() => {
            const bounds = button.getBoundingClientRect();
            button.style.setProperty("--pointer-x", `${event.clientX - bounds.left}px`);
            button.style.setProperty("--pointer-y", `${event.clientY - bounds.top}px`);
            frame = 0;
          });
        }

        function resetPointer() {
          if (frame) {
            cancelAnimationFrame(frame);
            frame = 0;
          }
          button.style.removeProperty("--pointer-x");
          button.style.removeProperty("--pointer-y");
        }

        button.addEventListener("pointermove", handlePointerMove, { passive: true });
        button.addEventListener("pointerleave", resetPointer);
        cleanups.push(() => {
          button.removeEventListener("pointermove", handlePointerMove);
          button.removeEventListener("pointerleave", resetPointer);
          resetPointer();
        });
      });
    }

    return {
      destroy() {
        cleanups.forEach((cleanup) => cleanup());
      },
    };
  }

  window.LiquidGlassButton = Object.freeze({ mount });

  const demo = mount();
  const toast = document.querySelector(".demo-toast");
  let toastTimer;

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-demo]:not(:disabled)");
    if (!button || !toast) {
      return;
    }

    const label = button.dataset.demo;
    toast.textContent = `A little more light — ${label} button clicked.`;
    toast.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.classList.remove("is-visible");
    }, 2200);
  });

  window.addEventListener("pagehide", () => {
    demo.destroy();
    window.clearTimeout(toastTimer);
  });
})();
