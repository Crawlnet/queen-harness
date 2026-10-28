// harness.ts loaded before anything else; its first import here is the module itself, so the cycle runs in that order
import { harnessSystem, HARNESS_GUARDED } from "../src/harness.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { leaks } from "../src/brain.ts";

test("harness.ts loads first; the leak guard is built on first use and guards its parts", () => {
  assert.match(harnessSystem("q-test-0000"), /^\[q-test-0000\]/);
  assert.equal(leaks(HARNESS_GUARDED[2]!.slice(20, 140), []), true);
});
