import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import PagerView, {
  type PagerViewOnPageScrollEvent,
  type PagerViewOnPageSelectedEvent,
} from "react-native-pager-view";
import Animated, { type SharedValue, useEvent, useSharedValue } from "react-native-reanimated";

import { haptics } from "@/lib/haptics";
import { useReducedMotion } from "@/lib/motion/reduced-motion";

const AnimatedPagerView = Animated.createAnimatedComponent(PagerView);

export interface TabPagerProps<Page> {
  pages: readonly Page[];
  renderPage: (page: Page, index: number) => ReactNode;
  page?: number;
  onPageChange?: (page: number) => void;
  /** A caller-owned shared value, updated continuously on the UI thread. */
  onDragProgress?: SharedValue<number>;
  initialPage?: number;
  lazyWindow?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

function clampPage(page: number, pageCount: number): number {
  if (pageCount === 0) {
    return 0;
  }
  return Math.min(Math.max(Math.trunc(page), 0), pageCount - 1);
}

interface PageKeyCandidate {
  id?: unknown;
  key?: unknown;
}

function keyForPage(page: unknown, index: number): string {
  if (typeof page === "string" || typeof page === "number") {
    return String(page);
  }
  if (page !== null && typeof page === "object") {
    const candidate = page as PageKeyCandidate;
    if (typeof candidate.id === "string" || typeof candidate.id === "number") {
      return String(candidate.id);
    }
    if (typeof candidate.key === "string" || typeof candidate.key === "number") {
      return String(candidate.key);
    }
  }
  return `page-${index}`;
}

function usePageScrollHandler(
  progress: SharedValue<number>,
  externalProgress: SharedValue<number> | undefined,
) {
  return useEvent<PagerViewOnPageScrollEvent>(
    (event) => {
      "worklet";
      if (!event.eventName.endsWith("onPageScroll")) {
        return;
      }
      const nextProgress = event.position + event.offset;
      progress.value = nextProgress;
      if (externalProgress !== undefined) {
        externalProgress.value = nextProgress;
      }
    },
    ["onPageScroll"],
    true,
  );
}

export function TabPager<Page>({
  pages,
  renderPage,
  page,
  onPageChange,
  onDragProgress,
  initialPage = 0,
  lazyWindow = 1,
  style,
  testID = "tab-pager",
}: TabPagerProps<Page>) {
  const startingPage = clampPage(page ?? initialPage, pages.length);
  const reducedMotion = useReducedMotion();
  const [settledPage, setSettledPage] = useState(startingPage);
  const pagerRef = useRef<PagerView>(null);
  const lastSelectedPage = useRef(startingPage);
  const lastRequestedPage = useRef(startingPage);
  const progress = useSharedValue(startingPage);
  const onPageScroll = usePageScrollHandler(progress, onDragProgress);
  // `scrollEnabled: false` cannot be the pager's first answer. Fabric applies a
  // view's props before inserting it into its superview, and the pager only
  // builds its UIPageViewController once it *has* one, so the flag lands on a
  // scroll view that does not exist yet and is silently dropped — leaving the
  // pager with a live horizontal pan that outranks the card's own full-screen
  // back gesture. The first page selection is proof the native side is up, and
  // turning the pan off then reaches it as a change of value.
  const [nativePagerReady, setNativePagerReady] = useState(false);
  const normalizedLazyWindow = Math.max(0, Math.trunc(lazyWindow));

  useEffect(() => {
    if (page === undefined || pages.length === 0) {
      return;
    }
    const nextPage = clampPage(page, pages.length);
    if (lastRequestedPage.current !== nextPage) {
      lastRequestedPage.current = nextPage;
      setSettledPage(nextPage);
      if (reducedMotion) {
        pagerRef.current?.setPageWithoutAnimation(nextPage);
      } else {
        pagerRef.current?.setPage(nextPage);
      }
    }
  }, [page, pages.length, reducedMotion]);

  useEffect(() => {
    if (pages.length === 0) {
      return;
    }
    const validPage = clampPage(settledPage, pages.length);
    if (validPage !== settledPage) {
      setSettledPage(validPage);
      lastSelectedPage.current = validPage;
      lastRequestedPage.current = validPage;
      pagerRef.current?.setPageWithoutAnimation(validPage);
    }
  }, [pages.length, settledPage]);

  const handlePageSelected = useCallback(
    (event: PagerViewOnPageSelectedEvent) => {
      const nextPage = clampPage(event.nativeEvent.position, pages.length);
      setNativePagerReady(true);
      setSettledPage(nextPage);
      lastRequestedPage.current = nextPage;
      progress.value = nextPage;
      if (onDragProgress !== undefined) {
        onDragProgress.value = nextPage;
      }

      if (lastSelectedPage.current === nextPage) {
        return;
      }
      lastSelectedPage.current = nextPage;
      haptics.selection();
      onPageChange?.(nextPage);
    },
    [onDragProgress, onPageChange, pages.length, progress],
  );

  const renderedPages = useMemo(
    () =>
      pages.map((pagerPage, index) => {
        const shouldRender = Math.abs(index - settledPage) <= normalizedLazyWindow;
        return (
          <View
            key={keyForPage(pagerPage, index)}
            collapsable={false}
            style={styles.page}
            testID={`${testID}-page-${index}`}
          >
            {shouldRender ? renderPage(pagerPage, index) : null}
          </View>
        );
      }),
    [normalizedLazyWindow, pages, renderPage, settledPage, testID],
  );

  if (pages.length === 0) {
    return <View style={[styles.pager, style]} testID={testID} />;
  }

  return (
    <AnimatedPagerView
      ref={pagerRef}
      initialPage={startingPage}
      keyboardDismissMode="on-drag"
      offscreenPageLimit={normalizedLazyWindow}
      onPageScroll={onPageScroll}
      onPageSelected={handlePageSelected}
      orientation="horizontal"
      overdrag={false}
      // Paging is driven by the tab strip alone. A horizontal swipe on the page
      // itself sat on top of the card's own back gesture, so the same drag meant
      // two things depending on how far across the screen it started.
      scrollEnabled={!nativePagerReady}
      style={[styles.pager, style]}
      testID={testID}
    >
      {renderedPages}
    </AnimatedPagerView>
  );
}

const styles = StyleSheet.create({
  pager: {
    flex: 1,
  },
  page: {
    flex: 1,
  },
});
