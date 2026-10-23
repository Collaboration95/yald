import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ProgressBar, InfoTip } from "../../components/ui";
import { YaldiFindingArtwork } from "../../components/YaldiArtwork";
import { Expandable } from "../../components/ui";
import { useFilters } from "../../lib/useFilters";
import type { Filters } from "../../api";

/** The four investigations, in tab order, each with the window it reads best in. */
export const LAB_TABS = [
  { path: "spend-spikes", label: "Spikes", range: "30d" },
  { path: "project-radar", label: "Projects", range: "7d" },
  { path: "cache-detective", label: "Cache savings", range: "7d" },
  { path: "context-replay", label: "Context growth", range: "30d" },
] as const;

export type LabPath = (typeof LAB_TABS)[number]["path"];
const WINDOW_PARAMS = ["range", "from", "to", "last"];

export const labRange = (path: string): string => LAB_TABS.find(tab => tab.path === path)?.range ?? "30d";

/** True once the person has chosen a window themselves; until then each investigation uses its own. */
export function useExplicitWindow(): boolean {
  const [params] = useSearchParams();
  return WINDOW_PARAMS.some(key => params.has(key));
}

/** The toolbar filters, with the investigation's own window unless one was picked. */
export function useLabsFilters(path: LabPath): Filters {
  const { filters } = useFilters();
  const explicit = useExplicitWindow();
  return explicit ? filters : { ...filters, range: labRange(path) };
}

/** One template for every investigation: a one-line verdict with a big number, and the method behind an (i). */
export function Verdict({ headline, detail, big, bigLabel, info, action, found = true }: {
  headline: ReactNode;
  detail?: ReactNode;
  big?: string;
  bigLabel?: string;
  info?: ReactNode;
  action?: { href: string; label: string } | null;
  found?: boolean;
}) {
  return (
    <section className="card flex flex-wrap items-center gap-x-5 gap-y-3 p-4" data-finding-summary aria-live="polite">
      <YaldiFindingArtwork evidenceSufficient={found} />
      <div className="min-w-0 flex-1">
        <h2 className="flex items-center gap-1.5 text-[15px] font-semibold text-ink">
          <span>{headline}</span>
          {info ? <InfoTip label="How this was measured">{info}</InfoTip> : null}
        </h2>
        {detail ? <p className="mt-1 text-[12px] leading-5 text-ink-soft">{detail}</p> : null}
        {action ? <Link to={action.href} className="mt-2 inline-block rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-surface-2">{action.label}</Link> : null}
      </div>
      {big ? <div className="text-right">
        <p className="num text-[30px] font-bold leading-none tracking-tight text-ink">{big}</p>
        {bigLabel ? <p className="mt-1 text-[11px] text-muted">{bigLabel}</p> : null}
      </div> : null}
    </section>
  );
}

export interface TopRow { key: string; label: string; title?: string; value: string; amount: number; note?: string; href?: string; onSelect?: () => void; selected?: boolean }

/** A short ranked list with proportional bars: the top five, then "Show all". */
export function TopList({ rows, limit = 5, tone = "accent" }: { rows: TopRow[]; limit?: number; tone?: "accent" | "bad" }) {
  const max = Math.max(...rows.map(row => Math.abs(row.amount)), 1);
  return (
    <Expandable items={rows} limit={limit}>
      {visible => (
        <ul className="space-y-2.5">
          {visible.map(row => (
            <li key={row.key}>
              <div className="flex items-baseline justify-between gap-3 text-[12px]">
                <span className="min-w-0 truncate text-ink" title={row.title ?? row.label}>
                  {row.onSelect ? <button type="button" aria-pressed={row.selected} onClick={row.onSelect} className={row.selected ? "font-semibold text-accent" : "hover:text-accent hover:underline"}>{row.label}</button>
                    : row.href ? <Link to={row.href} className="hover:text-accent hover:underline">{row.label}</Link> : row.label}
                  {row.note ? <span className="ml-1.5 text-[10.5px] text-muted">{row.note}</span> : null}
                </span>
                <span className="num shrink-0 font-semibold text-ink">{row.value}</span>
              </div>
              <ProgressBar value={Math.abs(row.amount)} max={max} tone={tone} className="mt-1" />
            </li>
          ))}
        </ul>
      )}
    </Expandable>
  );
}

/** "the last 7 days" for a resolved window, instead of two full timestamps. */
export function periodPhrase(window: { from: number; to: number }): string {
  const days = Math.round((window.to - window.from) / 86_400_000);
  return days <= 1 ? "the last 24 hours" : `the last ${days} days`;
}
