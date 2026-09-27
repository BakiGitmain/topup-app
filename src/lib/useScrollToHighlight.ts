import { createRef, useCallback, useEffect, useRef, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent, ScrollView, View } from 'react-native';

import { revealOffset } from './scrollHighlight';
import { useReducedMotion } from './useReducedMotion';

/**
 * One scroll area the highlight may need to move. Spread its `props` onto the ScrollView (or, where the screen has handlers of its
 * own, call these from them): it only remembers how far the area is scrolled and how tall its content is. A plain object
 * that updates itself, held for the screen's lifetime, so reading it during render is fine.
 */
export class ScrollContainer {
  readonly scrollView = createRef<ScrollView>();
  offset = 0;
  content = 0;
  insetBottom = 0;
  /** Something floats over the bottom of this area (a tab bar): reveal items above it. */
  setInsetBottom(value: number) {
    this.insetBottom = value;
  }
  onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    this.offset = e.nativeEvent.contentOffset.y;
  };
  onContentSizeChange = (_w: number, h: number) => {
    this.content = h;
  };
  /** Spread onto the ScrollView: `<ScrollView {...container.props}>`. */
  readonly props = {
    ref: this.scrollView,
    onScroll: this.onScroll,
    onContentSizeChange: this.onContentSizeChange,
    scrollEventThrottle: 32,
  };
}

export function useScrollContainer(): ScrollContainer {
  const [container] = useState(() => new ScrollContainer());
  return container;
}

/** What a list hands to each of its items (HighlightTarget): which one to measure, which one glows right now. */
export type HighlightBinding = {
  targetId: string | null;
  targetRef: (node: View | null) => void;
  glowingId: string | null;
  endGlow: () => void;
};

type Options = {
  /** The item to reveal (a route param), or null. */
  targetId: string | null;
  /** Changes on every tap, so tapping the same notification twice highlights twice -- and a revisit never does. */
  token: string | null;
  /** The list has finished loading. */
  ready: boolean;
  /** The target is in the loaded list and still worth pointing at. False = open normally, no highlight. */
  present: boolean;
  /** The scroll areas around the item, innermost first. */
  containers: readonly ScrollContainer[];
  /** Called once the request is dealt with (highlighted, or given up on). Clear the route params here. */
  onConsumed: () => void;
};

/** Time for layout to settle (images, fonts) before measuring, and for an animated scroll to land before glowing. */
const SETTLE_MS = 150;
const SCROLL_MS = 420;
/** A target that is "present" but never mounts (hidden by a filter, say) is given up on after this. */
const GIVE_UP_MS = 3000;

type Measurable = { measureInWindow: View['measureInWindow'] };

/** A ScrollView's own frame: its native host view (getNativeScrollRef), or the ref itself where that is the host. */
function scrollHost(view: ScrollView | null): Measurable | null {
  const host = (view as unknown as { getNativeScrollRef?: () => unknown } | null)?.getNativeScrollRef?.() ?? view;
  return host && typeof (host as Partial<Measurable>).measureInWindow === 'function' ? (host as Measurable) : null;
}

function measure(node: Measurable | null) {
  return new Promise<{ y: number; height: number } | null>((resolve) => {
    if (!node) return resolve(null);
    node.measureInWindow((_x, y, _w, height) => resolve({ y, height }));
  });
}

/**
 * The one "scroll into view, then glow once" mechanism, used by every list a notification can point into (the
 * product page's packs, the profile's transactions). Each request is handled exactly once: when the list is ready,
 * the item is measured, every container is scrolled just enough to show it, and then it glows (HighlightTarget draws
 * the glow). A target that isn't there anymore opens the screen without a highlight instead of failing.
 */
export function useScrollToHighlight({ targetId, token, ready, present, containers, onConsumed }: Options): HighlightBinding {
  const reduced = useReducedMotion();
  const [node, setNode] = useState<View | null>(null);
  const [glowingId, setGlowingId] = useState<string | null>(null);
  const handled = useRef(new Set<string>());
  const latest = useRef({ containers, onConsumed });
  useEffect(() => {
    latest.current = { containers, onConsumed };
  });

  const key = targetId && token ? `${targetId}|${token}` : null;

  useEffect(() => {
    if (!key || !targetId || !ready || handled.current.has(key)) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let cancelled = false;
    const finish = (glow: boolean) => {
      if (cancelled || handled.current.has(key)) return;
      handled.current.add(key);
      if (glow) setGlowingId(targetId);
      latest.current.onConsumed();
    };

    if (!present) {
      timers.push(setTimeout(() => finish(false), 0));
    } else if (!node) {
      timers.push(setTimeout(() => finish(false), GIVE_UP_MS));
    } else {
      timers.push(
        setTimeout(async () => {
          const areas = latest.current.containers;
          const item = await measure(node);
          const views = await Promise.all(areas.map((c) => measure(scrollHost(c.scrollView.current))));
          if (cancelled || !item) return;
          // Innermost first: after each area scrolls, the item sits that much higher for the next one out.
          let top = item.y;
          let moved = false;
          views.forEach((view, i) => {
            const area = areas[i];
            if (!view) return;
            const next = revealOffset({
              itemTop: top,
              itemHeight: item.height,
              viewTop: view.y,
              viewHeight: view.height,
              offset: area.offset,
              contentHeight: area.content,
              insetBottom: area.insetBottom,
            });
            if (next === area.offset) return;
            area.scrollView.current?.scrollTo({ y: next, animated: !reduced });
            top -= next - area.offset;
            moved = true;
          });
          timers.push(setTimeout(() => finish(true), moved && !reduced ? SCROLL_MS : 0));
        }, SETTLE_MS)
      );
    }
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [key, targetId, ready, present, node, reduced]);

  const endGlow = useCallback(() => setGlowingId(null), []);
  return { targetId, targetRef: setNode, glowingId, endGlow };
}
