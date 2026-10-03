import { Link } from "react-router-dom";

import type { Plans } from "./api";

// Pieces shared by Export history and Credit usage.

export const TIME = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });
export const DAY = new Intl.DateTimeFormat("en", { dateStyle: "long" });

/** A file size in bytes, KB or MB (unit conversion only). */
export function fileSize(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A calm "this comes with a plan" note, with the plan's name from config and a link to Pricing. */
export function UpgradeNote({ what, plan, plans }: { what: string; plan: string; plans: Plans | null }) {
  const name = plans?.plans.find((p) => p.id === plan)?.name ?? null;
  return (
    <div className="billing__notice upgrade-note" role="status">
      <p>{what} comes with the {name ?? "paid"} plan{name ? "" : "s"}. Your designs and credits stay as they are.</p>
      <Link className="btn btn--ink" to="/pricing">See plans</Link>
    </div>
  );
}

/** Newer / Older for pages of rows, newest first. */
export function Pager({ page, hasMore, onPage }: { page: number; hasMore: boolean; onPage: (page: number) => void }) {
  if (page === 1 && !hasMore) return null;
  return (
    <nav className="pager" aria-label="Pages">
      <button className="btn btn--ghost" type="button" disabled={page === 1} onClick={() => onPage(page - 1)}>Newer</button>
      <span className="pager__page">Page {page}</span>
      <button className="btn btn--ghost" type="button" disabled={!hasMore} onClick={() => onPage(page + 1)}>Older</button>
    </nav>
  );
}
