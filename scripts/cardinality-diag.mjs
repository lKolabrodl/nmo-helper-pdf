#!/usr/bin/env node
// Read-only diagnostic for the multi-answer cardinality hypothesis.
//
// It reuses saved eval artifacts (.cache/eval/<split>-results.json), which already
// contain per-case rawScores and expected ids. It does NOT call the predictor and
// does NOT read answer-key/case source files, so it cannot leak into runtime.
//
// For every multi case it compares the exact-set accuracy of:
//   - current   : the predictor's actual selected set (selection.ts);
//   - oracle-k   : top-|expected| answers by rawScore (known cardinality ceiling);
//   - elbowRel-k : top-k where k is the largest RELATIVE drop in sorted rawScores;
//   - elbowZ-k   : top-k where k is the largest gap measured in stddevs of gaps.
//
// The point is to estimate how much of the multi gap is pure cardinality (which a
// distribution-shape estimator could capture) vs ranking (which it cannot), before
// changing any runtime code.
import fs from "node:fs";
import path from "node:path";

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}

function sortedByRaw(rawScores) {
  return Object.entries(rawScores)
    .map(([id, raw]) => ({ id, raw: Number(raw) }))
    .sort((p, q) => q.raw - p.raw);
}

// Largest relative drop r[k]/r[k-1] (smallest ratio = sharpest cliff), k in [minK, n-1].
function elbowRelK(sorted, minK) {
  let bestK = minK;
  let bestRatio = Infinity;
  for (let k = minK; k <= sorted.length - 1; k += 1) {
    const top = sorted[k - 1].raw;
    const next = sorted[k].raw;
    if (top <= 0) continue;
    const ratio = next / top; // lower => bigger relative drop after taking k
    if (ratio < bestRatio) {
      bestRatio = ratio;
      bestK = k;
    }
  }
  return bestK;
}

// Largest gap relative to the mean gap (z-like), k in [minK, n-1].
function elbowZK(sorted, minK) {
  const gaps = [];
  for (let k = 1; k <= sorted.length - 1; k += 1) gaps.push(sorted[k - 1].raw - sorted[k].raw);
  const mean = gaps.reduce((s, v) => s + v, 0) / Math.max(1, gaps.length);
  let bestK = minK;
  let bestScore = -Infinity;
  for (let k = minK; k <= sorted.length - 1; k += 1) {
    const gap = sorted[k - 1].raw - sorted[k].raw;
    const score = gap - mean;
    if (score > bestScore) {
      bestScore = score;
      bestK = k;
    }
  }
  return bestK;
}

function topK(sorted, k) {
  return sorted.slice(0, k).map((item) => item.id);
}

// Sorted relative drops (1 - r[k]/r[k-1]) for each split position, descending,
// with their k. Used to test whether one elbow dominates all others.
function rankedDrops(sorted) {
  const drops = [];
  for (let k = 1; k <= sorted.length - 1; k += 1) {
    const top = sorted[k - 1].raw;
    const next = sorted[k].raw;
    const rel = top > 0 ? 1 - next / top : 0;
    drops.push({ k, rel });
  }
  return drops.sort((a, b) => b.rel - a.rel);
}

// Conservative override: only propose elbow-k when ONE drop dominates, i.e. the
// best relative drop is at least `domFactor` times the second-best, and the best
// drop itself is sharp (>= minDrop). Otherwise return null (keep current).
function dominantElbowK(sorted, { domFactor, minDrop, minK }) {
  const drops = rankedDrops(sorted).filter((d) => d.k >= minK);
  if (!drops.length) return null;
  const best = drops[0];
  const second = drops[1];
  if (best.rel < minDrop) return null;
  if (second && second.rel > 0 && best.rel < domFactor * second.rel) return null;
  return best.k;
}

function analyze(split) {
  const file = path.join(".cache", "eval", `${split}-results.json`);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const records = (parsed.records ?? []).filter((r) => r.mode === "multi" && Array.isArray(r.expected) && r.expected.length);

  const tally = {
    total: records.length,
    current: 0,
    oracle: 0,
    elbowRel2: 0,
    elbowZ2: 0,
    rankCorrect: 0, // expected == top-|expected| by raw (ceiling reachable by any k-only method)
    cardCorrectAmongRank: 0, // among rank-correct, elbowRel picks right k
    elbowRelFixes: 0,
    elbowRelBreaks: 0,
    gates: Object.fromEntries(CONSERVATIVE_GATES.map((g) => [g.name, { correct: 0, fixes: 0, breaks: 0 }])),
  };

  for (const r of records) {
    const sorted = sortedByRaw(r.rawScores ?? {});
    if (!sorted.length) continue;
    const m = r.expected.length;
    const expectedSet = r.expected;

    const oracleSel = topK(sorted, m);
    const relK = elbowRelK(sorted, 2);
    const zK = elbowZK(sorted, 2);
    const elbowRelSel = topK(sorted, relK);
    const elbowZSel = topK(sorted, zK);

    const currentOk = sameSet(r.selected ?? [], expectedSet);
    const oracleOk = sameSet(oracleSel, expectedSet);
    const elbowRelOk = sameSet(elbowRelSel, expectedSet);
    const elbowZOk = sameSet(elbowZSel, expectedSet);

    if (currentOk) tally.current += 1;
    if (oracleOk) tally.oracle += 1;
    if (elbowRelOk) tally.elbowRel2 += 1;
    if (elbowZOk) tally.elbowZ2 += 1;
    if (oracleOk) {
      tally.rankCorrect += 1; // oracleOk means the top-m by raw are exactly expected
      if (elbowRelOk) tally.cardCorrectAmongRank += 1;
    }
    if (!currentOk && elbowRelOk) tally.elbowRelFixes += 1;
    if (currentOk && !elbowRelOk) tally.elbowRelBreaks += 1;

    // Conservative dominant-elbow hybrid: keep current selection unless a single
    // dominant elbow proposes a different count; then take top-(domK).
    for (const cfg of CONSERVATIVE_GATES) {
      const domK = dominantElbowK(sorted, cfg.params);
      let sel = r.selected ?? [];
      if (domK !== null && domK !== (r.selected ?? []).length) sel = topK(sorted, domK);
      const ok = sameSet(sel, expectedSet);
      const slot = tally.gates[cfg.name];
      if (ok) slot.correct += 1;
      if (!currentOk && ok) slot.fixes += 1;
      if (currentOk && !ok) slot.breaks += 1;
    }
  }

  return tally;
}

const CONSERVATIVE_GATES = [
  { name: "dom2.0/0.30", params: { domFactor: 2.0, minDrop: 0.3, minK: 2 } },
  { name: "dom2.5/0.40", params: { domFactor: 2.5, minDrop: 0.4, minK: 2 } },
  { name: "dom3.0/0.50", params: { domFactor: 3.0, minDrop: 0.5, minK: 2 } },
];

function pct(n, d) {
  return d ? (n / d).toFixed(4) : "n/a";
}

function report(split, t) {
  if (!t) {
    process.stdout.write(`\n[${split}] no results file\n`);
    return;
  }
  process.stdout.write(`\n=== ${split} multi cases: ${t.total} ===\n`);
  process.stdout.write(`current  exact: ${t.current}/${t.total} = ${pct(t.current, t.total)}\n`);
  process.stdout.write(`oracle-k exact: ${t.oracle}/${t.total} = ${pct(t.oracle, t.total)}   (ceiling: ranking correct + known count)\n`);
  process.stdout.write(`elbowRel exact: ${t.elbowRel2}/${t.total} = ${pct(t.elbowRel2, t.total)}\n`);
  process.stdout.write(`elbowZ   exact: ${t.elbowZ2}/${t.total} = ${pct(t.elbowZ2, t.total)}\n`);
  process.stdout.write(`rank-correct (oracle-reachable): ${t.rankCorrect}/${t.total} = ${pct(t.rankCorrect, t.total)}\n`);
  process.stdout.write(`  of those, elbowRel picks correct k: ${t.cardCorrectAmongRank}/${t.rankCorrect} = ${pct(t.cardCorrectAmongRank, t.rankCorrect)}\n`);
  process.stdout.write(`elbowRel vs current: +${t.elbowRelFixes} fixed / -${t.elbowRelBreaks} broken (net ${t.elbowRelFixes - t.elbowRelBreaks})\n`);
  process.stdout.write(`conservative dominant-elbow gates (start from current, override count only on a dominant gap):\n`);
  for (const [name, g] of Object.entries(t.gates)) {
    process.stdout.write(`  ${name}: exact ${g.correct}/${t.total} = ${pct(g.correct, t.total)}  (+${g.fixes} / -${g.breaks}, net ${g.fixes - g.breaks})\n`);
  }
}

for (const split of ["dev", "holdout"]) {
  report(split, analyze(split));
}
