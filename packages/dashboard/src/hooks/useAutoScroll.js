import { useRef, useEffect, useCallback } from 'react';

/**
 * Auto-scroll to the top (newest items) when `dependency` changes.
 * If the user scrolls away from the top, auto-scroll pauses.
 * Auto-scroll resumes when the user scrolls back to the top.
 *
 * Feed panels all prepend newest items, so "newest" = scrollTop 0.
 */
export function useAutoScroll(dependency) {
  const containerRef         = useRef(null);
  const isScrolledAway       = useRef(false);
  const lastScrollTop        = useRef(0);

  // Listen for scroll events to detect user intent
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const { scrollTop } = el;
    const movingDown = scrollTop > lastScrollTop.current;
    lastScrollTop.current = scrollTop;

    if (scrollTop <= 40) {
      // Back at top → re-enable auto-scroll
      isScrolledAway.current = false;
    } else if (movingDown) {
      // User intentionally scrolled away from newest items
      isScrolledAway.current = true;
    }
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // Scroll to top when new items arrive (if user is not scrolled away)
  useEffect(() => {
    const el = containerRef.current;
    if (!el || isScrolledAway.current) return;
    el.scrollTo({ top: 0, behavior: 'smooth' });
  }, [dependency]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    containerRef,
    isAutoScrolling: !isScrolledAway.current,
  };
}
