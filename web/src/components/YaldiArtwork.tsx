import { usePreferences } from "../lib/preferences";
import { useTheme } from "../lib/theme";

export type YaldiArtworkState = "investigating" | "analysing" | "empty" | "insufficient" | "error" | "resting";
export interface YaldiArtworkProps {
  state: YaldiArtworkState;
  size?: 48 | 80 | 120 | 160;
  className?: string;
}

function ArtworkImage({ state, size = 80, className }: Omit<YaldiArtworkProps, "state"> & { state: YaldiArtworkState | "clue-found" | "demo" }) {
  const { hideArtwork } = usePreferences();
  const { theme } = useTheme();
  if (hideArtwork) return null;
  return <img src={`/yaldi/state-${state}${theme === "dark" ? "-dark" : ""}.svg`}
    width={160} height={160} style={{ width: size, height: size }}
    className={`block shrink-0 ${className ?? ""}`} alt="" aria-hidden="true" loading="lazy" decoding="async" />;
}

/** Decorative companion to complete, visible state text. Uses the app's chosen theme. */
export function YaldiArtwork(props: YaldiArtworkProps) {
  return <ArtworkImage {...props} />;
}

export function YaldiDemoArtwork() {
  return <ArtworkImage state="demo" size={48} />;
}

/** Place beside an existing finding summary only after its server evidence passes eligibility. */
export function YaldiFindingArtwork({ evidenceSufficient, ...props }: Omit<YaldiArtworkProps, "state"> & { evidenceSufficient: boolean }) {
  return evidenceSufficient ? <ArtworkImage state="clue-found" {...props} /> : null;
}

/** Small decorative mark; the live Yald. wordmark supplies the link's accessible name. */
export function YaldiMark() {
  const { hideArtwork } = usePreferences();
  const { theme } = useTheme();
  if (hideArtwork) return null;
  return <span className="relay-brand-mark" aria-hidden="true">
    <img src={`/yaldi/mark-small${theme === "dark" ? "-dark" : ""}.svg`} width={32} height={32} alt="" loading="lazy" decoding="async" />
  </span>;
}
