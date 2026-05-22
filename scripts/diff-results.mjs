#!/usr/bin/env node
// Read-only verification tool for behavior-preserving refactors.
// Compares two eval result JSON files case-by-case and reports any case
// whose selected-answer set changed. Used to prove zero-delta refactors.
import fs from "node:fs/promises";

function sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((value, index) => value === y[index]);
}

async function load(path) {
  const parsed = JSON.parse(await fs.readFile(path, "utf8"));
  const map = new Map();
  for (const record of parsed.records ?? []) map.set(record.id, record);
  return { summary: parsed.summary, map };
}

async function main() {
  const [, , baselinePath, currentPath] = process.argv;
  if (!baselinePath || !currentPath) {
    process.stderr.write("usage: node scripts/diff-results.mjs <baseline.json> <current.json>\n");
    process.exit(1);
  }
  const baseline = await load(baselinePath);
  const current = await load(currentPath);

  const diffs = [];
  for (const [id, base] of baseline.map) {
    const now = current.map.get(id);
    if (!now) {
      diffs.push({ id, kind: "missing_in_current" });
      continue;
    }
    if (!sameSet(base.selected, now.selected)) {
      diffs.push({ id, kind: "selected_changed", before: base.selected, after: now.selected });
    }
  }
  for (const id of current.map.keys()) {
    if (!baseline.map.has(id)) diffs.push({ id, kind: "new_in_current" });
  }

  const b = baseline.summary ?? {};
  const c = current.summary ?? {};
  process.stdout.write(
    `baseline ${b.correct}/${b.total} exact=${b.exactAccuracy} | current ${c.correct}/${c.total} exact=${c.exactAccuracy}\n`,
  );
  if (!diffs.length) {
    process.stdout.write(`ZERO-DELTA: all ${baseline.map.size} cases have identical selected sets\n`);
    process.exit(0);
  }
  process.stdout.write(`DELTA: ${diffs.length} case(s) changed selected set\n`);
  for (const diff of diffs.slice(0, 50)) {
    if (diff.kind === "selected_changed") {
      process.stdout.write(`  ${diff.id}: [${diff.before}] -> [${diff.after}]\n`);
    } else {
      process.stdout.write(`  ${diff.id}: ${diff.kind}\n`);
    }
  }
  process.exit(2);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
