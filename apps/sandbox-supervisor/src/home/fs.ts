import {
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Filesystem primitives for supervisor-managed files inside the
 * AGENT-WRITABLE home (step 9 lifted these out of the jcode adapter and
 * closed the parent-directory gap recorded in plans/v2-todo.md).
 *
 * SECURITY (symlink hardening): the agent controls its home, so any
 * path we touch may already be a symlink it planted — and a bare
 * write/mkdir/delete FOLLOWS links, letting the agent redirect our
 * filesystem effects onto any path this process can reach. Two rules close
 * it end to end:
 *
 *  - final component: unlink before write (`writeManagedFile`) — removing
 *    the LINK, never its target;
 *  - every PARENT component: `ensureManagedDir` walks segment by segment
 *    with lstat and a NON-recursive mkdir, replacing a planted
 *    symlink/non-directory with a real directory. `mkdirSync(recursive)` is
 *    banned on agent-controlled paths in this module family — it silently
 *    accepts a symlinked parent.
 */

export const writeManagedFile = (
  path: string,
  contents: string | Buffer,
  mode: number,
): void => {
  rmSync(path, { force: true });
  // "wx" = O_CREAT|O_EXCL: EXCL never follows a symlink on the final
  // component, so a link re-planted between the unlink and the write makes
  // this THROW (caught upstream, paced retry) instead of landing through it.
  writeFileSync(path, contents, { mode, flag: "wx" });
};

/**
 * Resolve-and-create `relDir` under `homeRoot`, one segment at a time.
 * A planted symlink or stray file at any directory position is replaced (the
 * renderer's self-heal posture — refusing would let an agent permanently
 * wedge its own sync). Throws on traversal segments as defense in depth
 * behind the wire schema. Returns the final absolute path.
 */
export const ensureManagedDir = (homeRoot: string, relDir: string): string => {
  let current = homeRoot;
  for (const segment of relDir.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`unsafe path segment in managed dir: ${relDir}`);
    }
    current = join(current, segment);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) {
      mkdirSync(current);
    } else if (!stat.isDirectory() || stat.isSymbolicLink()) {
      // lstat: a symlink reports as a symlink even when it points at a
      // directory — remove the LINK (or stray file), never what it targets.
      rmSync(current, { force: true });
      mkdirSync(current);
    }
  }
  return current;
};

/**
 * Prune a managed root to exactly `keep` (paths relative to homeRoot):
 * symlinks are unlinked AS LINKS (never followed, never recursed into),
 * files outside the manifest are removed, empty directories fold up
 * bottom-up. The walk only descends real directories under the root, so it
 * can never escape it. The root itself always survives.
 */
export const pruneManagedRoot = (
  homeRoot: string,
  relRoot: string,
  keep: ReadonlySet<string>,
): void => {
  const rootAbs = ensureManagedDir(homeRoot, relRoot);

  const walk = (dirAbs: string, dirRel: string): void => {
    for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
      const entryAbs = join(dirAbs, entry.name);
      const entryRel = `${dirRel}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        rmSync(entryAbs, { force: true });
      } else if (entry.isDirectory()) {
        walk(entryAbs, entryRel);
        if (readdirSync(entryAbs).length === 0) rmdirSync(entryAbs);
      } else if (!keep.has(entryRel)) {
        rmSync(entryAbs, { force: true });
      }
    }
  };

  walk(rootAbs, relRoot);
};
