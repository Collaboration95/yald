import { Link } from "react-router-dom";
import { conversationLink, sourceLabel, useSessionTitles } from "../api";
import { formatShortDate, sessionLabel } from "../lib/format";
import type { Source } from "../types";

export function SessionLink({ session, search, date = false }: { session: { id: string; source: Source; project?: string | null; startedAt?: number }; search: string; date?: boolean }) {
  const titles = useSessionTitles();
  const title = session.source === "claude-code" ? titles[session.id] : undefined;
  const label = title ?? sessionLabel({ ...session, project: session.project ?? null });
  return <Link to={conversationLink(session, search)} className="session-link inline-block max-w-full min-w-0 truncate text-[11.5px]" title={`${label} · ${sourceLabel(session.source)}`}>
    {label}{date && session.startedAt !== undefined ? <span className="text-[10.5px] text-muted"> · {formatShortDate(session.startedAt)}</span> : null}<span aria-hidden="true" className="session-arrow"> →</span>
  </Link>;
}
