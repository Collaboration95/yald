import type { AccountScope } from "../types";

/** This notice belongs beside every account observation, including inside a scoped dashboard. */
export function AccountScopeNotice({ scope }: { scope: AccountScope }) {
  return <p className="rounded-lg border border-line px-2.5 py-2 text-[11px] leading-4 text-muted">
    {scope.available ? <>
      <span className="font-medium text-ink">Account-wide opencodex observation.</span> Quota and send accounting are not a project's own usage.
      {scope.ignored.length ? ` These filters do not narrow them: ${scope.ignored.join(", ")}.` : " Request filters do not narrow them."}
      {" History uses the selected time window; current quota and send-accounting totals are the latest available account observations."}
    </> : <>
      <span className="font-medium text-ink">Quota and send ledger unavailable for Claude Code.</span> Claude Code transcripts record neither. Select opencodex or both sources to see account observations.
    </>}
  </p>;
}
