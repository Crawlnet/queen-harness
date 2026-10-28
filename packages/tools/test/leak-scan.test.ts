// Leak scan: with TOOLS_REDACT_TERMS set in the shell (the same comma list the server uses; any script,
// look-alike letters included), every file of the repo (read as UTF-8), every commit message and every branch name
// is searched for those terms, matched as the guard matches them (any case, look-alike letters, zero-width
// characters, separators swapped or slipped in). Whole words listed in TOOLS_REDACT_KEEP are skipped, as
// the guard skips them. The terms are never written down here; without them only the scanner's self-test
// runs. Set both lists as the server has them: without its TOOLS_REDACT_KEEP the ordinary words that hold
// a term are reported too.
//   TOOLS_REDACT_TERMS='term1,term2' TOOLS_REDACT_KEEP='word1,word2' npm test -w @crawlnet/tools

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { termHits } from "../src/redact.ts";

const REPO = new URL("../../../", import.meta.url).pathname;
const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
const terms = list(process.env.TOOLS_REDACT_TERMS);
const keep = list(process.env.TOOLS_REDACT_KEEP);

/** The numbers (1-based, never the text) of the terms a text holds outside the kept words */
export const termsIn = (text: string, scanTerms: string[], keepWords: string[]): number[] => termHits(text, scanTerms, keepWords);

/** Files (paths relative to `root`) holding a term, read as UTF-8 */
export function scanFiles(root: string, files: string[], scanTerms: string[], keepWords: string[]): string[] {
  const hits: string[] = [];
  for (const rel of files) {
    if (rel.includes("node_modules/")) continue;
    const path = join(root, rel);
    let text: string;
    try {
      if (statSync(path).size > 20_000_000) continue;
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const n of new Set([...termsIn(text, scanTerms, keepWords), ...termsIn(rel, scanTerms, keepWords)])) hits.push(`${rel} (term #${n})`);
  }
  return hits;
}

describe("leak scan: the scanner", () => {
  it("finds a term in any script and case, in a UTF-8 file, and skips kept whole words", () => {
    const dir = mkdtempSync(join(tmpdir(), "leak-scan-"));
    try {
      writeFileSync(join(dir, "a.txt"), "Απλό κείμενο: Παράδειγμα δεδομένων και άλλες λέξεις.\n", "utf8");
      writeFileSync(join(dir, "b.txt"), "acmeic chains, nothing else\n", "utf8");
      writeFileSync(join(dir, "c.txt"), "acmeic chains by Acme\n", "utf8");
      assert.deepEqual(scanFiles(dir, ["a.txt"], ["παράδειγμα"], []), ["a.txt (term #1)"]);
      assert.deepEqual(scanFiles(dir, ["a.txt"], ["acme", "παράδειγμα"], []), ["a.txt (term #2)"]);
      assert.deepEqual(scanFiles(dir, ["b.txt", "c.txt"], ["acme"], ["acmeic"]), ["c.txt (term #1)"]);
      assert.deepEqual(scanFiles(dir, ["b.txt"], ["acme"], []), ["b.txt (term #1)"]);
      // spelled variants are found too
      writeFileSync(join(dir, "d.txt"), "by Ac\u200bme-Data, see ａｃｍｅｄａｔａ and acme_data_set.\n", "utf8");
      assert.deepEqual(scanFiles(dir, ["d.txt"], ["acmedata"], []), ["d.txt (term #1)"]);
      assert.deepEqual(termsIn("by ACME DATA", ["acmedata"], []), [1]);
      assert.deepEqual(termsIn("by acme, data", ["acmedata"], []), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("leak scan (terms from TOOLS_REDACT_TERMS)", { skip: terms.length === 0 ? "TOOLS_REDACT_TERMS is not set" : false }, () => {
  it("no file of the repo holds a term", () => {
    const files = execFileSync("git", ["-C", REPO, "ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\n").filter(Boolean);
    assert.deepEqual(scanFiles(REPO, files, terms, keep), []);
  });

  it("no commit message, author line or branch name holds a term", () => {
    const log = execFileSync("git", ["-C", REPO, "log", "--all", "--format=%an %ae %s %b"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const branches = execFileSync("git", ["-C", REPO, "branch", "-a", "--format=%(refname)"], { encoding: "utf8" });
    assert.deepEqual(termsIn(log, terms, keep), [], "a commit message holds these terms (by number)");
    assert.deepEqual(termsIn(branches, terms, keep), [], "a branch name holds these terms (by number)");
  });
});
