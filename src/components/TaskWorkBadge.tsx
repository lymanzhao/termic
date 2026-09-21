// The agent work badge: bell, bullet, or spinner.
//
// Was `TabBadge`, local to Sidebar.tsx. Shared now because the dashboard draws
// the same badge for the same task, and a second copy would be free to drift.
//
// `data-testid="work-badge"` is NOT unique on the page any more: the sidebar is
// always mounted and the dashboard is an overlay over it, so a task with a live
// agent renders two. Specs must scope through `[data-dashboard-task-id]` or the
// sidebar's `[data-sidebar-task-id]` rather than querying the testid globally.

import { useTranslation } from "react-i18next";
import { Bell } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import type { WorkBadgeReason } from "@/lib/taskWorkState";

export function TaskWorkBadge({ reason }: { reason: WorkBadgeReason }) {
  const { t } = useTranslation("chrome");
  if (reason === "working") {
    return (
      <span
        data-testid="work-badge"
        data-work-state="working"
        className="shrink-0 text-[var(--color-fg-faint)]"
        title={t("taskWorkBadge.working")}
        aria-label={t("taskWorkBadge.workingAria")}
      >
        <Spinner size={12} />
      </span>
    );
  }
  if (reason === "attention") {
    return (
      <span
        data-testid="work-badge"
        data-work-state="attention"
        className="shrink-0 text-[var(--color-warn)]"
        title={t("taskWorkBadge.attention")}
      >
        <Bell className="h-3 w-3" strokeWidth={2.5} />
      </span>
    );
  }
  // done — solid blue bullet, iTerm2-style, in --color-info (defined in
  // @theme; themes can override). h-3.5 visually matches the bell + spinner.
  return (
    <span
      data-testid="work-badge"
      data-work-state="done"
      className="shrink-0 flex items-center justify-center"
      title={t("taskWorkBadge.done")}
      aria-label={t("taskWorkBadge.doneAria")}
    >
      <span
        className="block h-2 w-2 rounded-full"
        style={{ backgroundColor: "var(--color-info)" }}
      />
    </span>
  );
}
