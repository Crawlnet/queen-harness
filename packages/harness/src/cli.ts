// Ask the harness one question from the terminal: `npm run ask -- "is <mint> a rug?"`. The research steps go to stderr as
// they run, the answer (markdown) and its sources to stdout. --json prints the whole answer object.

import { start } from "./run.ts";

const args = process.argv.slice(2);
const json = args.includes("--json");
const question = args.filter((a) => a !== "--json").join(" ").trim();
if (!question) {
  process.stderr.write('usage: npm run ask -- "your question" [--json]\n');
  process.exit(2);
}

const run = start({ env: undefined, log: process.env.HARNESS_LOG === "1" ? undefined : () => {}, background: false });
const t0 = Date.now();
const answer = await run.harness.ask({
  question,
  onStep: (name, phase) => {
    if (phase === "start" && name !== "thinking") process.stderr.write(`  reading ${name}\n`);
  },
});
if (json) process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
else {
  process.stdout.write(`\n${answer.answer}\n`);
  if (answer.sources.length) process.stdout.write(`\nsources:\n${answer.sources.map((s) => `  ${s.title ?? s.url}  ${s.url}`).join("\n")}\n`);
  if (answer.followups.length) process.stdout.write(`\nnext:\n${answer.followups.map((f) => `  ${f}`).join("\n")}\n`);
  process.stderr.write(`\n(${answer.by}, ${Math.round((Date.now() - t0) / 100) / 10} s, ${answer.tools.length} reads)\n`);
}
run.stop();
process.exit(0);
