/**
 * Tag listing (T10.1, docs/v2-contracts.md): `refs/tags/**` from loose refs and `packed-refs`,
 * with annotated tags read through `git.readTag` and peeled to the commit they name.
 *
 * Parity target: `git tag -l --format='%(refname) %(objecttype) %(objectname) %(*objectname)'`
 * (recorded per fixture in `expected/tag-list.txt` by T10.0).
 */
import type { Oid, Signature, TagInfo } from "../types";
import type { ObjectDb } from "./objectDb";

/** A tag chain deeper than this is a loop or an abuse; stop rather than spin. */
const MAX_PEEL = 10;

/** isomorphic-git reports git's raw timestamp in seconds; everything we export is milliseconds. */
export function toSignature(s: {
  name: string;
  email: string;
  timestamp: number;
  timezoneOffset: number;
}): Signature {
  return {
    name: s.name,
    email: s.email,
    timestamp: s.timestamp * 1000,
    tzOffsetMin: s.timezoneOffset,
  };
}

/**
 * Peels `oid` through any chain of annotated tag objects to the object they ultimately name.
 * Returns the target, its type and the first tag object seen (null for a lightweight tag).
 */
export async function peelTag(
  db: ObjectDb,
  oid: Oid,
): Promise<{
  target: Oid;
  targetType: TagInfo["targetType"];
  tagOid: Oid | null;
  message?: string;
  tagger?: Signature;
}> {
  let current = oid;
  let tagOid: Oid | null = null;
  let message: string | undefined;
  let tagger: Signature | undefined;
  /** The last tag object's `type` field is git's own answer for `%(*objecttype)`. */
  let targetType: TagInfo["targetType"] = "commit";
  let typeKnown = false;
  for (let i = 0; i < MAX_PEEL; i++) {
    const tag = await db.readTag(current);
    if (!tag) break;
    if (tagOid === null) {
      tagOid = tag.oid;
      message = tag.message;
      if (tag.tagger) tagger = toSignature(tag.tagger);
    }
    if (tag.type !== "tag") {
      targetType = tag.type;
      typeKnown = true;
    }
    current = tag.object;
  }
  if (!typeKnown) {
    // A lightweight tag: ask the object database what the ref actually names (T10.5b B1).
    const type = await db.objectType(current);
    targetType = type === null || type === "tag" ? "commit" : type;
  }
  const out: {
    target: Oid;
    targetType: TagInfo["targetType"];
    tagOid: Oid | null;
    message?: string;
    tagger?: Signature;
  } = {
    target: current,
    targetType,
    tagOid,
  };
  if (message !== undefined) out.message = message;
  if (tagger !== undefined) out.tagger = tagger;
  return out;
}

/** Every tag in the repository, sorted by ref name like `git tag -l`. */
export async function listTags(db: ObjectDb): Promise<TagInfo[]> {
  const out: TagInfo[] = [];
  for (const name of await db.listTagNames()) {
    const fullName = `refs/tags/${name}`;
    const oid = await db.tryResolveRef(fullName);
    if (oid === null) continue; // a dangling tag file: git ignores it too
    const peeled = await peelTag(db, oid);
    const info: TagInfo = {
      name,
      fullName,
      oid,
      targetOid: peeled.target,
      targetType: peeled.targetType,
      annotated: peeled.tagOid !== null,
    };
    if (peeled.message !== undefined) info.message = peeled.message;
    if (peeled.tagger !== undefined) {
      info.tagger = peeled.tagger;
      info.timestamp = peeled.tagger.timestamp;
    }
    out.push(info);
  }
  return out;
}
