import { useEffect, useState, type CSSProperties } from "react";

const KONAMI = "UUDDLRLRba";
const ARROWS: Record<string, string> = { ArrowUp: "U", ArrowDown: "D", ArrowLeft: "L", ArrowRight: "R" };
const CONFETTI = ["var(--relay-coral)", "var(--accent)", "var(--info)", "var(--warn)", "var(--violet)"];

type Surprise = { id: number; message: string; confetti?: CSSProperties[] };

const throwConfetti = () => Array.from({ length: 80 }, (_, index) => ({
  "--x": `${Math.random() * 100}%`,
  "--dx": `${(Math.random() - 0.5) * 240}px`,
  "--r": `${Math.random() * 900 - 450}deg`,
  "--d": `${Math.random() * 500}ms`,
  "--t": `${1600 + Math.random() * 1200}ms`,
  "--c": CONFETTI[index % CONFETTI.length],
}) as CSSProperties);

/** Keyboard easter eggs: the Konami code throws confetti, typing "yald" does a barrel roll. */
export function Delight() {
  const [surprise, setSurprise] = useState<Surprise | null>(null);

  useEffect(() => {
    let typed = "";
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if ((event.target as HTMLElement).closest?.("input, textarea, select, [contenteditable]")) return;
      const key = ARROWS[event.key] ?? (event.key.length === 1 ? event.key.toLowerCase() : "");
      typed = (typed + key).slice(-KONAMI.length);
      if (typed.endsWith(KONAMI)) {
        typed = "";
        setSurprise({ id: Date.now(), message: "↑↑↓↓←→←→BA · +30 lives, none of them billed", confetti: throwConfetti() });
      } else if (typed.endsWith("yald")) {
        typed = "";
        if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          document.querySelector(".relay-frame")?.animate(
            [{ transform: "rotate(0)" }, { transform: "rotate(1turn)" }],
            { duration: 900, easing: "cubic-bezier(.6, 0, .4, 1)" },
          );
        }
        setSurprise({ id: Date.now(), message: "Yet Another Llm Dashboard, now with a barrel roll" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!surprise) return;
    const timer = setTimeout(() => setSurprise(null), 3200);
    return () => clearTimeout(timer);
  }, [surprise]);

  if (!surprise) return null;
  return (
    <>
      {surprise.confetti ? (
        <div key={`confetti-${surprise.id}`} className="delight-confetti" aria-hidden="true">
          {surprise.confetti.map((style, index) => <i key={index} style={style} />)}
        </div>
      ) : null}
      <div key={surprise.id} className="delight-toast" role="status">{surprise.message}</div>
    </>
  );
}
