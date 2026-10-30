import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePreferences } from "../lib/preferences";
import { YaldiArtwork, type YaldiArtworkState } from "./YaldiArtwork";

/** Slow and occasional: one small move, then a long stretch of nothing. */
export const IDLE_MOVE_MS = 40_000;
const BUBBLE_MS = 3_200;
/** Existing poses only. clue-found stays reserved for evidence-backed findings. */
export const IDLE_POSES: readonly YaldiArtworkState[] = ["resting", "investigating", "analysing"];

const PAGE_QUIPS: Record<string, string> = {
  cost: "Counting coins. Purely for evidence.",
  context: "Measuring how long this got.",
  performance: "Timing that one with my stopwatch.",
  sessions: "Comparing notebooks.",
  labs: "Following a lead in the lab.",
};
const QUIPS = ["I wasn't sleeping!", "Just checking the cache…", "Every request leaves a trace."];

/** The next thing Yaldi says: one in four is about the page, the rest cycle. */
export function wakeQuip(page: string, wakes: number): string {
  const local = PAGE_QUIPS[page];
  return local && wakes % 4 === 1 ? local : QUIPS[wakes % QUIPS.length]!;
}

function subscribeMotion(notify: () => void): () => void {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
}

/** Server rendering and an unknown preference both stay still. */
const useReducedMotion = () => useSyncExternalStore(subscribeMotion, () => window.matchMedia("(prefers-reduced-motion: reduce)").matches, () => true);

/** True while any query on the page has failed: Yaldi does not play beside an error. */
function useAnyQueryFailed(): boolean {
  const cache = useQueryClient().getQueryCache();
  return useSyncExternalStore(
    notify => cache.subscribe(notify),
    () => cache.getAll().some(query => query.state.status === "error"),
    () => false,
  );
}

/** A small Yaldi at the right of the page heading. The button wakes it; the art itself is decorative. */
export function IdleYaldi({ page }: { page: string }) {
  const { hideArtwork } = usePreferences();
  const reducedMotion = useReducedMotion();
  const failed = useAnyQueryFailed();
  const [pose, setPose] = useState(0);
  const [moving, setMoving] = useState(false);
  const [bubble, setBubble] = useState<string | null>(null);
  const wakes = useRef(0);

  useEffect(() => {
    if (hideArtwork || reducedMotion || failed) return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      setPose(current => (current + 1) % IDLE_POSES.length);
      setMoving(true);
    }, IDLE_MOVE_MS);
    return () => clearInterval(timer);
  }, [hideArtwork, reducedMotion, failed]);

  useEffect(() => {
    if (!bubble) return;
    const timer = setTimeout(() => setBubble(null), BUBBLE_MS);
    return () => clearTimeout(timer);
  }, [bubble]);

  if (hideArtwork || failed) return null;
  const wake = () => {
    setBubble(wakeQuip(page, wakes.current++));
    if (!reducedMotion) setMoving(true);
  };
  return (
    <div className="idle-yaldi" data-idle-yaldi>
      {bubble ? <p role="status" className="idle-yaldi-bubble">{bubble}</p> : null}
      <button type="button" aria-label="Wake Yaldi" onClick={wake} onAnimationEnd={() => setMoving(false)} data-moving={moving || undefined}>
        <YaldiArtwork state={reducedMotion ? "resting" : bubble ? "investigating" : IDLE_POSES[pose]!} size={72} />
      </button>
    </div>
  );
}
