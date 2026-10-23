import { useChartStyle } from "../lib/chartStyle";
import { clsx } from "clsx";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Check, ChevronDown, Info, Loader2 } from "lucide-react";

export function Card({ children, className, padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return <section className={clsx("card widget-card min-w-0", padded && "p-4", className)}>{children}</section>;
}

export function CardHeader({ title, subtitle, action, className }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <header data-widget-title={typeof title === "string" ? title : undefined} className={clsx("widget-header mb-3 flex items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <h2 className="text-[13.5px] font-semibold tracking-[-0.01em] text-ink">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-[11.5px] leading-4 text-muted">{subtitle}</p> : null}
      </div>
      {action ? <div className="widget-action flex shrink-0 items-center gap-1.5">{action}</div> : null}
    </header>
  );
}

/** A small (i) that holds method, coverage and caveat text instead of a paragraph on the page. */
export function InfoTip({ children, label = "More info", align = "left", className }: { children: ReactNode; label?: string; align?: "left" | "right"; className?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span className={clsx("info-tip relative inline-flex align-middle", className)} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={event => { if (event.key === "Escape") setOpen(false); }}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted transition hover:text-ink focus-visible:text-ink"
      >
        <Info size={12} strokeWidth={2} />
      </button>
      {open ? (
        <span
          id={id}
          role="tooltip"
          className={clsx("info-tip-body fade-in absolute top-full z-50 mt-1 w-[min(300px,calc(100vw-2rem))] rounded-lg border border-line bg-surface px-3 py-2 text-left text-[11.5px] font-normal normal-case leading-[1.45] tracking-normal text-ink-soft shadow-xl", align === "right" ? "right-0" : "left-0")}
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}

/** Marks a metric or section that only covers some of the traffic, with the detail one hover away. */
export function PartialBadge({ children, label = "Partial" }: { children: ReactNode; label?: string }) {
  return <Badge tone="warn" className="gap-0.5">{label}<InfoTip label={`${label}: details`}>{children}</InfoTip></Badge>;
}

/** Tags a section whose numbers only exist for opencodex requests, so Claude Code is never shown as rows of "—". */
export function CodexOnly({ className }: { className?: string }) {
  return (
    <span className={clsx("inline-flex items-center gap-1", className)}>
      <Badge className="normal-case tracking-normal">Codex only</Badge>
      <InfoTip label="About Codex-only numbers">Timing and outcomes come from the opencodex proxy. Claude Code transcripts do not record them, so those requests are left out.</InfoTip>
    </span>
  );
}

/** Says nothing at 95% coverage or better; below that, a "Partial" badge with the counts one hover away. */
export function CoverageBadge({ sample, what = "measured" }: { sample: { eligibleRequests: number; totalRequests: number } | undefined; what?: string }) {
  if (!sample || sample.totalRequests === 0 || sample.eligibleRequests / sample.totalRequests >= 0.95) return null;
  return <PartialBadge>{sample.eligibleRequests.toLocaleString("en-US")} of {sample.totalRequests.toLocaleString("en-US")} requests {what}. The rest are left out.</PartialBadge>;
}

/** The first `limit` rows, then a "Show all" button: no inner-scroll boxes with half-cut rows. */
export function Expandable<T>({ items, limit = 8, children }: { items: T[]; limit?: number; children: (rows: T[]) => ReactNode }) {
  const [all, setAll] = useState(false);
  const rows = all ? items : items.slice(0, limit);
  return (
    <>
      {children(rows)}
      {items.length > limit ? (
        <button type="button" onClick={() => setAll(current => !current)} className="mt-2 text-[11.5px] font-medium text-accent hover:underline">
          {all ? "Show fewer" : `Show all ${items.length.toLocaleString("en-US")}`}
        </button>
      ) : null}
    </>
  );
}

type Tone = "neutral" | "good" | "bad" | "warn" | "info" | "violet";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-surface-3 text-ink-soft",
  good: "bg-accent-soft text-accent",
  bad: "bg-bad-soft text-bad",
  warn: "bg-warn-soft text-warn",
  info: "bg-info-soft text-info",
  violet: "bg-surface-3 text-violet",
};

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return (
    <span className={clsx("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium", TONE_CLASS[tone], className)}>
      {children}
    </span>
  );
}

export function Stat({
  label,
  value,
  hint,
  delta,
  deltaTone = "auto",
  spark,
  icon,
  tone = "neutral",
  info,
  tag,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  delta?: number | null;
  deltaTone?: "auto" | "inverse" | "none";
  spark?: number[];
  icon?: ReactNode;
  tone?: Tone;
  /** Method or coverage detail, shown in an (i) next to the label. */
  info?: ReactNode;
  /** Short scope tag next to the label, e.g. "Codex only". */
  tag?: string;
}) {
  const deltaColor = delta === null || delta === undefined
    ? "text-muted"
    : deltaTone === "none"
      ? "text-muted"
      : (deltaTone === "inverse" ? delta < 0 : delta > 0)
        ? "text-accent"
        : delta === 0
          ? "text-muted"
          : "text-bad";
  const accentBar: Record<Tone, string> = {
    neutral: "bg-line-strong",
    good: "bg-accent",
    bad: "bg-bad",
    warn: "bg-warn",
    info: "bg-info",
    violet: "bg-violet",
  };
  return (
    <div className="card stat-card relative overflow-hidden p-3.5" data-stat={label} data-tone={tone}>
      <div className={clsx("stat-accent absolute left-0 top-0 h-full w-[3px]", accentBar[tone])} />
      <div className="flex items-start justify-between gap-2">
        <p className="stat-label flex items-center gap-1 text-[11px] font-medium uppercase tracking-[0.04em] text-muted">
          {label}
          {tag ? <Badge className="normal-case tracking-normal">{tag}</Badge> : null}
          {info ? <InfoTip label={`${label}: details`}>{info}</InfoTip> : null}
        </p>
        {icon ? <span className="text-muted">{icon}</span> : null}
      </div>
      <p className="stat-value num mt-2 text-[22px] font-semibold leading-none tracking-[-0.02em] text-ink">{value}</p>
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="stat-hint min-w-0 truncate text-[11px] text-muted">{hint}</div>
        {delta !== undefined ? (
          <span title="vs the previous period of the same length" className={clsx("num shrink-0 text-[11px] font-semibold", deltaColor)}>
            {delta === null ? "—" : `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(Math.abs(delta) >= 1 ? 0 : 1)}%`}
          </span>
        ) : null}
      </div>
      {spark && spark.length > 1 ? <MiniSpark values={spark} className="mt-2.5" /> : null}
    </div>
  );
}

export function MiniSpark({ values, className, color = "var(--accent)" }: { values: number[]; className?: string; color?: string }) {
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const width = 100;
  const height = 22;
  const step = width / Math.max(1, values.length - 1);
  const points = values.map((value, index) => `${(index * step).toFixed(2)},${(height - ((value - min) / range) * height).toFixed(2)}`);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={clsx("h-[22px] w-full", className)}>
      <polyline points={`0,${height} ${points.join(" ")} ${width},${height}`} fill={color} opacity="0.12" stroke="none" />
      <polyline points={points.join(" ")} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Segmented<T extends string>({ value, options, onChange, size = "md" }: { value: T; options: { id: T; label: string }[]; onChange: (value: T) => void; size?: "sm" | "md" }) {
  return (
    <div className="segmented flex items-center gap-0.5 rounded-lg bg-surface-3 p-0.5">
      {options.map(option => (
        <button
          key={option.id}
          type="button"
          onClick={() => onChange(option.id)}
          aria-pressed={value === option.id}
          className={clsx(
            "rounded-[7px] font-medium transition",
            size === "sm" ? "px-2 py-[3px] text-[11px]" : "px-2.5 py-1 text-[11.5px]",
            value === option.id ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-soft",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Popover({ label, children, active, width = 280, align = "right", ariaLabel, chevron = true }: { label: ReactNode; children: ReactNode; active?: boolean; width?: number; align?: "left" | "right"; ariaLabel?: string; chevron?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={ariaLabel}
        onClick={() => setOpen(current => !current)}
        className={clsx(
          "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11.5px] font-medium transition",
          active ? "border-accent/40 bg-accent-soft text-accent" : "border-line bg-surface text-ink-soft hover:border-line-strong",
        )}
      >
        {label}
        {chevron ? <ChevronDown size={12} className={clsx("transition", open && "rotate-180")} /> : null}
      </button>
      {open ? (
        <div
          id={id}
          className={clsx("fade-in absolute z-40 mt-1.5 max-h-[380px] overflow-auto rounded-xl border border-line bg-surface p-2 shadow-xl", align === "right" ? "right-0" : "left-0")}
          style={{ width, maxWidth: "calc(100vw - 1.5rem)" }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function CheckList({ items, selected, onToggle, empty = "No options", labelFor, counts, searchable }: {
  items: string[];
  selected: string[];
  onToggle: (value: string) => void;
  empty?: string;
  /** Display text for an item whose stored value is not meant to be read. */
  labelFor?: (item: string) => string;
  counts?: Record<string, number>;
  /** Show a search box; by default only lists longer than eight get one. */
  searchable?: boolean;
}) {
  const [query, setQuery] = useState("");
  if (items.length === 0) return <p className="px-2 py-3 text-[11.5px] text-muted">{empty}</p>;
  const label = (item: string) => labelFor?.(item) ?? item;
  const needle = query.trim().toLowerCase();
  const visible = needle ? items.filter(item => `${label(item)} ${item}`.toLowerCase().includes(needle)) : items;
  return (
    <>
      {searchable ?? items.length > 8 ? (
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          aria-label="Search options"
          placeholder="Search…"
          className="mb-1.5 w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-[11.5px] text-ink outline-none placeholder:text-muted focus:border-accent/50"
        />
      ) : null}
      {visible.length === 0 ? <p className="px-2 py-3 text-[11.5px] text-muted">No match</p> : null}
      <ul className="space-y-0.5">
        {visible.map(item => {
          const checked = selected.includes(item);
          return (
            <li key={item}>
              <button
                type="button"
                aria-pressed={checked}
                onClick={() => onToggle(item)}
                title={label(item) === item ? undefined : item}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] text-ink-soft transition hover:bg-surface-3"
              >
                <span className={clsx("flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border", checked ? "border-accent bg-accent text-white" : "border-line-strong")}>
                  {checked ? <Check size={10} strokeWidth={3} /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate">{label(item)}</span>
                {counts && counts[item] !== undefined ? <span className="num shrink-0 text-muted">{counts[item]!.toLocaleString("en-US")}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function ProgressBar({ value, max = 1, tone = "accent", className }: { value: number; max?: number; tone?: "accent" | "bad" | "warn" | "info" | "violet"; className?: string }) {
  const tones: Record<string, string> = { accent: "bg-accent", bad: "bg-bad", warn: "bg-warn", info: "bg-info", violet: "bg-violet" };
  const percent = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  return (
    <div className={clsx("h-1.5 w-full overflow-hidden rounded-full bg-surface-3", className)}>
      <div className={clsx("h-full rounded-full transition-all", tones[tone])} style={{ width: `${percent}%` }} />
    </div>
  );
}

const LOADING_QUIPS = ["Counting tokens", "Asking the ledger nicely", "Reticulating splines", "Warming the cache", "Herding requests", "Doing token math"];

export const loadingQuip = () => `${LOADING_QUIPS[Math.floor(Math.random() * LOADING_QUIPS.length)]}…`;

export function StateBlock({ loading, error, empty, children, emptyLabel = "No data for this window" }: { loading?: boolean; error?: unknown; empty?: boolean; children: ReactNode; emptyLabel?: string }) {
  const [quip] = useState(loadingQuip);
  if (loading) {
    return (
      <div className="flex h-full min-h-[120px] items-center justify-center gap-2 text-[12px] text-muted">
        <Loader2 size={14} className="animate-spin" /> {quip}
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-full min-h-[120px] flex-col items-center justify-center gap-1.5 text-center text-[12px] text-bad">
        <AlertTriangle size={16} />
        <p className="font-medium">Could not load data</p>
        <p className="max-w-[260px] text-[11px] text-muted">{String((error as Error)?.message ?? error)}</p>
      </div>
    );
  }
  if (empty) {
    return <div className="flex h-full min-h-[120px] items-center justify-center text-[12px] text-muted">{emptyLabel}</div>;
  }
  return <>{children}</>;
}

export function TableShell({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx("table-shell -mx-4 min-w-0 max-w-[calc(100vw-2rem)] overflow-x-auto px-4", className)}><table className="w-full min-w-[560px] border-collapse text-[11.5px]">{children}</table></div>;
}

export function Th({ children, align = "left", className, onClick, active, asc }: { children: ReactNode; align?: "left" | "right" | "center"; className?: string; onClick?: () => void; active?: boolean; asc?: boolean }) {
  return (
    <th
      className={clsx(
        "whitespace-nowrap border-b border-line px-2 py-2 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-muted",
        align === "right" && "text-right",
        align === "center" && "text-center",
        onClick && "cursor-pointer select-none hover:text-ink-soft",
        active && "text-ink",
        className,
      )}
      onClick={onClick}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {active ? <ChevronDown size={10} className={clsx("transition", asc && "rotate-180")} /> : null}
      </span>
    </th>
  );
}

export function Td({ children, align = "left", className, colSpan }: { children: ReactNode; align?: "left" | "right" | "center"; className?: string; colSpan?: number }) {
  return (
    <td
      colSpan={colSpan}
      className={clsx(
        "num border-b border-line/70 px-2 py-1.5 text-ink-soft",
        align === "right" && "text-right",
        align === "center" && "text-center",
        className,
      )}
    >
      {children}
    </td>
  );
}

export function ModelTag({ model, provider, className }: { model: string; provider?: string; className?: string }) {
  const design = useChartStyle();
  const hue = [...model].reduce((acc, char) => acc + char.charCodeAt(0), 0) % 360;
  return (
    <span title={provider ? `${model} · ${provider}` : model} className={clsx("inline-flex min-w-0 items-center gap-1.5", className)}>
      <span className="model-dot h-2 w-2 shrink-0 rounded-full" style={{ background: design?.modelColor(model) ?? `hsl(${hue} 55% 52%)` }} />
      <span className="truncate font-medium text-ink">{model}</span>
      {provider ? <span className="shrink-0 text-[10px] text-muted">{provider}</span> : null}
    </span>
  );
}

export function OutcomeDot({ outcome }: { outcome: string }) {
  const tone = outcome === "ok" ? "bg-accent" : outcome === "cancelled" ? "bg-warn" : outcome === "unobserved" ? "bg-muted" : "bg-bad";
  return <span role="img" aria-label={outcome} title={outcome} className={clsx("inline-block h-1.5 w-1.5 rounded-full", tone)} />;
}

export function Legend({ items }: { items: { label: string; color: string; value?: ReactNode }[] }) {
  const design = useChartStyle();
  return (
    <ul className="legend space-y-1.5">
      {items.map(item => (
        <li key={item.label} className="flex items-center justify-between gap-3 text-[11.5px]">
          <span className="flex min-w-0 items-center gap-1.5 text-ink-soft">
            <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: design?.colorFor(item.label, item.color) ?? item.color }} />
            <span className="truncate">{item.label}</span>
          </span>
          {item.value !== undefined ? <span className="num shrink-0 font-medium text-ink">{item.value}</span> : null}
        </li>
      ))}
    </ul>
  );
}
