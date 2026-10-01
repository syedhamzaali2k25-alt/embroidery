import { useEffect } from "react";

/**
 * Scroll reveal: elements matching `selector` fade and rise (--motion-rise, --motion-reveal,
 * ease-out) once, when they scroll into view; items revealed together are staggered by
 * --motion-stagger.
 *
 * The page is complete at rest. Nothing is hidden by CSS: only this script hides anything, and
 * only elements that start below the first screen. It does nothing at all with
 * prefers-reduced-motion or without IntersectionObserver, and it hides nothing until its
 * observer and its fallback (a scroll check that reveals whatever is on screen, in case the
 * observer never fires) are both in place.
 */
export function useReveal(selector: string, deps: unknown[] = []) {
  useEffect(() => {
    if (typeof window === "undefined" || !("IntersectionObserver" in window)) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let cancelled = false;
    let observer: IntersectionObserver | null = null;
    let frame = 0;
    const pending = new Set<HTMLElement>();
    const css = getComputedStyle(document.documentElement);
    const stagger = parseFloat(css.getPropertyValue("--motion-stagger")) || 0;
    const duration = parseFloat(css.getPropertyValue("--motion-reveal")) || 0;

    const reveal = (els: HTMLElement[]) => {
      els.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      const inGroup = new Map<Element | null, number>(); // stagger counts within one group (same parent)
      els.forEach((el) => {
        if (!pending.delete(el)) return;
        observer?.unobserve(el);
        const i = inGroup.get(el.parentElement) ?? 0;
        inGroup.set(el.parentElement, i + 1);
        el.style.transitionDelay = `${Math.min(i, 5) * stagger}ms`;
        el.classList.add("reveal-in");
        el.classList.remove("reveal-pending");
        window.setTimeout(() => { el.classList.remove("reveal-in"); el.style.transitionDelay = ""; }, duration + 6 * stagger + 50);
      });
    };
    const onScreen = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return r.top < window.innerHeight && r.bottom > 0;
    };
    // Fallback in case the observer never fires: reveal whatever is on screen after a scroll.
    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => reveal([...pending].filter(onScreen)));
    };

    // Wait a frame so the page (and its fonts) has its final layout before deciding what is below.
    const start = requestAnimationFrame(() => {
      if (cancelled) return;
      try {
        observer = new IntersectionObserver((entries) => {
          reveal(entries.filter((e) => e.isIntersecting).map((e) => e.target as HTMLElement));
        });
      } catch {
        return; // no observer: hide nothing
      }
      window.addEventListener("scroll", check, { passive: true });
      window.addEventListener("resize", check, { passive: true });
      for (const el of document.querySelectorAll<HTMLElement>(selector)) {
        if (el.getBoundingClientRect().top < window.innerHeight) continue; // on the first screen: leave as is
        pending.add(el);
        el.classList.add("reveal-pending");
        observer.observe(el);
      }
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(start);
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
      for (const el of pending) el.classList.remove("reveal-pending");
      pending.clear();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selector, ...deps]);
}
