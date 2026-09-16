import type { BadgeKind } from "../refGroups";

const LABEL: Record<BadgeKind, string> = { head: "HEAD", default: "default", remote: "remote" };

const CLASS: Record<BadgeKind, string> = {
  head: "bg-badge-head-bg text-badge-head-fg border-badge-head-border",
  default: "bg-badge-default-bg text-badge-default-fg border-badge-default-border",
  remote: "bg-badge-remote-bg text-badge-remote-fg border-badge-remote-border",
};

const TITLE: Record<BadgeKind, string> = {
  head: "Checked-out branch",
  default: "Default branch",
  remote: "Remote-tracking branch",
};

/** Branch badge (Design §3.3 / §7.1): 999 px pill, 11 px / 600, palette per kind. Shared primitive (Design §11). */
export function Badge({ kind }: { kind: BadgeKind }) {
  return (
    <span
      className={`inline-flex h-4 items-center rounded-full border px-1.5 font-sans text-[11px] font-semibold leading-4 ${CLASS[kind]}`}
      title={TITLE[kind]}
    >
      {LABEL[kind]}
    </span>
  );
}
