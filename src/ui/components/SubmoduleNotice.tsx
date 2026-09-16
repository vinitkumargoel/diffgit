import { Notice } from "./Notice";

const short = (oid: string | null | undefined) => (oid ? oid.slice(0, 7) : "(none)");

/** `Subproject commit abc123 → def456` (Design §7.7). */
export function SubmoduleNotice({
  oldOid,
  newOid,
}: {
  oldOid: string | null | undefined;
  newOid: string | null | undefined;
}) {
  return (
    <Notice>
      <span className="font-mono">
        Subproject commit {short(oldOid)} → {short(newOid)}
      </span>
    </Notice>
  );
}
