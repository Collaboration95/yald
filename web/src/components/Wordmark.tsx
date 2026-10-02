import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";

/** A small surprise on hover, with a fixed footprint so the dashboard stays still. */
export function Wordmark() {
  const { search } = useLocation();
  const [morph, setMorph] = useState(0);
  const chooseMorph = () => setMorph(Math.floor(Math.random() * 3));

  return (
    <NavLink
      to={{ pathname: "/", search }}
      className="relay-brand"
      aria-label="Yald — YetAnotherLlmDashboard overview"
      data-morph={morph}
      onPointerEnter={chooseMorph}
      onFocus={chooseMorph}
    >
      <span className="relay-wordmark" aria-hidden="true">
        <span className="relay-wordmark-short">Yald<span className="relay-brand-stop">.</span></span>
        <span className="relay-wordmark-full">
          <span>Yet</span><span>Another</span><span>Llm</span><span>Dashboard</span><span className="relay-brand-stop">.</span>
        </span>
      </span>
    </NavLink>
  );
}
