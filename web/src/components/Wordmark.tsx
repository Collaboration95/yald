import { NavLink, useLocation } from "react-router-dom";
import { YaldiMark } from "./YaldiArtwork";

/** Keep the product name live text, beside its optional detective companion. */
export function Wordmark() {
  const { search } = useLocation();

  return (
    <NavLink
      to={{ pathname: "/", search }}
      className="relay-brand"
      aria-label="Yald overview"
    >
      <YaldiMark />
      <span className="relay-wordmark">Yald<span className="relay-brand-stop">.</span></span>
    </NavLink>
  );
}
