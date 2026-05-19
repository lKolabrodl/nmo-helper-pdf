#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { extractNumbers, normalizeForSearch, tokenize } from "../src/normalize.js";
import { groupSplit, loadDataset } from "./cases.js";

const DEFAULT_SPLITS = ["dev", "holdout"];

type EvalError = {
  id: string;
  pdfGroup: string;
  mode: "single" | "multi";
  question: string;
  expected: string[];
  selected: string[];
  scores: Record<string, number>;
  rawScores: Record<string, number>;
  evidence: Array<{ answerId: string; page: number; text: string; score: number; kind: string }>;
  bucket: string;
};

type EvalArtifact = {
  summary: Record<string, unknown>;
  records: Array<Record<string, unknown>>;
  errors: EvalError[];
};

type DatasetCase = Awaited<ReturnType<typeof loadDataset>>["cases"][number];

const STRUCTURAL_EVIDENCE_PREFIXES = [
  "coordinate_",
  "visual_table_",
  "row_label_",
  "bounded_list_",
  "ordinal_",
  "answer_ordinal_",
  "classification_code_",
  "mkb_",
  "gene_sentence_",
  "clinical_feature_",
  "label_definition_",
  "term_definition_",
  "recommendation_item_",
  "explicit_recommendation_",
  "drug_dose_",
  "fibrosis_",
  "count_relation_",
  "cloze_",
];

const BROAD_EVIDENCE_KINDS = new Set([
  "bm25_question_answer",
  "question_chunk_answer",
  "answer_chunk_question",
  "answer_window",
  "answer_directional_window",
  "focused_answer_window",
  "shared_multi_segment",
]);

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function sameSet(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function round4(value: number) {
  return Math.round((Number.isFinite(value) ? value : 0) * 10000) / 10000;
}

function countBy<T>(items: T[], keyFn: (item: T) => string) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en")));
}

function topEntries(counts: Record<string, number>, limit = 12) {
  return Object.fromEntries(Object.entries(counts).slice(0, limit));
}

function isStructuralEvidence(kind: string) {
  return STRUCTURAL_EVIDENCE_PREFIXES.some((prefix) => kind.startsWith(prefix));
}

function normalizedIncludes(text: string, cue: string) {
  return normalizeForSearch(text).includes(normalizeForSearch(cue));
}

function hasAnyCue(text: string, cues: string[]) {
  const normalized = normalizeForSearch(text);
  return cues.some((cue) => normalized.includes(normalizeForSearch(cue)));
}

function optionStats(testCase: DatasetCase) {
  const optionTokens = testCase.answers.map((answer) => new Set(tokenize(answer.text).filter((token) => !/^\d/.test(token))));
  let maxTokenOverlap = 0;
  for (let left = 0; left < optionTokens.length; left += 1) {
    for (let right = left + 1; right < optionTokens.length; right += 1) {
      const union = new Set([...optionTokens[left], ...optionTokens[right]]);
      const intersection = [...optionTokens[left]].filter((token) => optionTokens[right].has(token));
      maxTokenOverlap = Math.max(maxTokenOverlap, union.size ? intersection.length / union.size : 0);
    }
  }

  const numericOptionCount = testCase.answers.filter((answer) => extractNumbers(answer.text).length > 0).length;
  const allShortNumeric =
    testCase.answers.length >= 3 &&
    testCase.answers.every((answer) => extractNumbers(answer.text).length > 0 && normalizeForSearch(answer.text).length <= 52 && tokenize(answer.text).length <= 7);

  return {
    optionCount: testCase.answers.length,
    numericOptionCount,
    allShortNumeric,
    maxTokenOverlap: round4(maxTokenOverlap),
    hasDenseOptionFamily: maxTokenOverlap >= 0.55,
  };
}

function opposingFamily(testCase: DatasetCase) {
  const normalizedAnswers = testCase.answers.map((answer) => normalizeForSearch(answer.text));
  const tokenizedAnswers = testCase.answers.map((answer) => tokenize(answer.text, { keepStopwords: true }));
  const groups = [
    { name: "short_vs_long_acting", left: ["короткодейств"], right: ["длительнодейств"] },
    { name: "increase_vs_decrease", left: ["увелич", "повыш", "выше"], right: ["уменьш", "сниж", "ниже"] },
    { name: "upper_vs_lower", left: ["верхн"], right: ["нижн", "базальн"] },
    { name: "more_vs_less", left: ["более", "больше"], right: ["менее", "меньше"] },
  ];

  function answerHasCue(answerIndex: number, cue: string) {
    const normalizedCue = normalizeForSearch(cue);
    if (normalizedCue.length >= 4) return normalizedAnswers[answerIndex].includes(normalizedCue);
    return tokenizedAnswers[answerIndex].some((token) => token === normalizedCue || token.startsWith(normalizedCue));
  }

  return groups
    .filter((group) => {
      const hasLeft = normalizedAnswers.some((_, index) => group.left.some((cue) => answerHasCue(index, cue)));
      const hasRight = normalizedAnswers.some((_, index) => group.right.some((cue) => answerHasCue(index, cue)));
      return hasLeft && hasRight;
    })
    .map((group) => group.name);
}

function questionPatterns(question: string) {
  const patterns = [];
  if (hasAnyCue(question, ["таблиц", "шкал", "классифик", "степен", "стад", "класс", "категор"])) patterns.push("question_table_or_scale");
  if (hasAnyCue(question, ["рекоменду", "назнач", "показан", "провод", "терап", "лечен"])) patterns.push("question_recommendation_or_treatment");
  if (hasAnyCue(question, ["не ", "исключ", "не включ", "не типич", "не характер"])) patterns.push("question_negative_or_exception");
  if (hasAnyCue(question, ["называ", "счита", "понима", "является"])) patterns.push("question_definition_like");
  if (hasAnyCue(question, ["мкб", "код", "класс c", "icd"])) patterns.push("question_code_or_classification");
  if (hasAnyCue(question, ["ген", "мутац", "полиморф"])) patterns.push("question_gene_symbol");
  if (hasAnyCue(question, ["сколько", "количество", "число"])) patterns.push("question_count");
  return patterns;
}

function evidencePatterns(error: EvalError) {
  const kinds = error.evidence.map((item) => item.kind);
  const structural = kinds.filter(isStructuralEvidence);
  const broad = kinds.filter((kind) => BROAD_EVIDENCE_KINDS.has(kind));
  const patterns = [];
  if (structural.length) patterns.push("has_structural_evidence");
  if (broad.length && !structural.length) patterns.push("broad_evidence_only");
  if (kinds.some((kind) => kind.startsWith("coordinate_") || kind.startsWith("visual_table_"))) patterns.push("evidence_table_layout");
  if (kinds.some((kind) => kind.includes("recommendation"))) patterns.push("evidence_recommendation");
  if (kinds.includes("shared_multi_segment")) patterns.push("evidence_shared_multi");
  if (kinds.includes("bm25_question_answer") || kinds.includes("question_chunk_answer")) patterns.push("evidence_flat_retrieval");
  return { kinds, structural, broad, patterns };
}

function selectionPatterns(error: EvalError) {
  const missed = error.expected.filter((id) => !error.selected.includes(id));
  const extra = error.selected.filter((id) => !error.expected.includes(id));
  const patterns = [];
  if (error.mode === "multi" && error.selected.length < error.expected.length) patterns.push("multi_under_selected");
  if (error.mode === "multi" && error.selected.length > error.expected.length) patterns.push("multi_over_selected");
  if (error.mode === "multi" && error.selected.length === error.expected.length && !sameSet(error.selected, error.expected)) {
    patterns.push("multi_same_count_distractor");
  }
  if (error.mode === "single" && extra.length && missed.length) patterns.push("single_wrong_top_candidate");
  if (error.selected.length === 0) patterns.push("empty_selection");
  return { missed, extra, patterns };
}

function likelyNextWork(patterns: string[]) {
  const set = new Set(patterns);
  if (set.has("question_table_or_scale") || set.has("evidence_table_layout")) return "table_or_layout_parser";
  if (set.has("question_recommendation_or_treatment") || set.has("evidence_recommendation")) return "recommendation_block_parser";
  if (set.has("option_numeric_family") || set.has("option_dense_family") || set.has("option_opposing_family")) return "option_family_resolver";
  if (set.has("multi_over_selected") || set.has("multi_under_selected") || set.has("multi_same_count_distractor")) return "multi_set_selection";
  if (set.has("question_negative_or_exception")) return "negative_exception_semantics";
  if (set.has("question_definition_like")) return "definition_binding";
  if (set.has("broad_evidence_only")) return "retrieval_precision";
  return "manual_error_review";
}

function enrichError(error: EvalError, testCase: DatasetCase) {
  const option = optionStats(testCase);
  const opposing = opposingFamily(testCase);
  const evidence = evidencePatterns(error);
  const selection = selectionPatterns(error);
  const qPatterns = questionPatterns(error.question);
  const optionPatterns = [];
  if (option.numericOptionCount >= 2) optionPatterns.push("option_numeric_family");
  if (option.allShortNumeric) optionPatterns.push("option_all_short_numeric");
  if (option.hasDenseOptionFamily) optionPatterns.push("option_dense_family");
  if (opposing.length) optionPatterns.push("option_opposing_family");

  const patterns = [...new Set([...selection.patterns, ...qPatterns, ...optionPatterns, ...evidence.patterns])];
  const topRaw = Object.entries(error.rawScores ?? {}).sort((a, b) => Number(b[1]) - Number(a[1]));
  const expectedRanks = error.expected.map((id) => topRaw.findIndex(([candidateId]) => candidateId === id) + 1);

  return {
    id: error.id,
    pdfGroup: error.pdfGroup,
    mode: error.mode,
    bucket: error.bucket,
    expectedCount: error.expected.length,
    selectedCount: error.selected.length,
    missedCount: selection.missed.length,
    extraCount: selection.extra.length,
    selected: error.selected,
    expected: error.expected,
    expectedRanks,
    topRaw: topRaw.slice(0, 5).map(([id, raw]) => ({ id, raw: round4(Number(raw)) })),
    topEvidenceKinds: error.evidence.map((item) => item.kind),
    structuralEvidenceKinds: [...new Set(evidence.structural)],
    broadEvidenceKinds: [...new Set(evidence.broad)],
    option,
    opposingFamilies: opposing,
    patterns,
    likelyNextWork: likelyNextWork(patterns),
    question: error.question,
    answers: testCase.answers.map((answer) => ({ id: answer.id, text: answer.text })),
  };
}

function summarizeEnriched(split: string, artifact: EvalArtifact, enrichedErrors: ReturnType<typeof enrichError>[]) {
  const byMode = countBy(enrichedErrors, (item) => item.mode);
  const byBucket = countBy(enrichedErrors, (item) => item.bucket);
  const byLikelyNextWork = countBy(enrichedErrors, (item) => item.likelyNextWork);
  const byPattern = countBy(enrichedErrors.flatMap((item) => item.patterns), (pattern) => pattern);
  const byPdf = countBy(enrichedErrors, (item) => item.pdfGroup);
  const byTopEvidenceKind = countBy(enrichedErrors.flatMap((item) => item.topEvidenceKinds.slice(0, 1)), (kind) => kind);
  const multiErrors = enrichedErrors.filter((item) => item.mode === "multi");
  const singleErrors = enrichedErrors.filter((item) => item.mode === "single");

  return {
    split,
    sourceSummary: artifact.summary,
    errors: enrichedErrors.length,
    byMode,
    byBucket,
    byLikelyNextWork,
    byPattern: topEntries(byPattern, 24),
    byPdf,
    byTopEvidenceKind: topEntries(byTopEvidenceKind, 16),
    multi: {
      errors: multiErrors.length,
      byBucket: countBy(multiErrors, (item) => item.bucket),
      byLikelyNextWork: countBy(multiErrors, (item) => item.likelyNextWork),
      cardinality: countBy(multiErrors, (item) =>
        item.selectedCount < item.expectedCount ? "under_selected" : item.selectedCount > item.expectedCount ? "over_selected" : "same_count_distractor",
      ),
    },
    single: {
      errors: singleErrors.length,
      byBucket: countBy(singleErrors, (item) => item.bucket),
      byLikelyNextWork: countBy(singleErrors, (item) => item.likelyNextWork),
    },
  };
}

function markdownTable(rows: Array<Array<string | number>>) {
  if (!rows.length) return "";
  const header = rows[0];
  const separator = header.map(() => "---");
  return [header, separator, ...rows.slice(1)].map((row) => `| ${row.join(" | ")} |`).join("\n");
}

function topCountRows(title: string, counts: Record<string, number>, limit = 10) {
  const rows = Object.entries(counts).slice(0, limit);
  if (!rows.length) return `### ${title}\n\nNo rows.\n`;
  return `### ${title}\n\n${markdownTable([["Item", "Count"], ...rows])}\n`;
}

function renderMarkdown(report: Record<string, any>) {
  const lines = ["# Error Diagnostics", "", "Generated from `.cache/eval/*-results.json`; this report is analysis-only and is not used by runtime predictor.", ""];
  for (const split of Object.keys(report.splits)) {
    const summary = report.splits[split].summary;
    lines.push(`## ${split}`, "");
    lines.push(
      `Errors: ${summary.errors}. Source exact accuracy: ${summary.sourceSummary?.exactAccuracy ?? "n/a"}; single: ${summary.sourceSummary?.singleAccuracy ?? "n/a"}; multi: ${summary.sourceSummary?.multiExactAccuracy ?? "n/a"}.`,
      "",
    );
    lines.push(topCountRows("Likely Next Work", summary.byLikelyNextWork));
    lines.push(topCountRows("Patterns", summary.byPattern, 14));
    lines.push(topCountRows("Top Evidence Kind", summary.byTopEvidenceKind, 10));
    lines.push("### Representative Errors", "");
    const examples = report.splits[split].errors.slice(0, 12);
    lines.push(
      markdownTable([
        ["ID", "Mode", "Bucket", "Next Work", "Patterns"],
        ...examples.map((item: ReturnType<typeof enrichError>) => [
          item.id,
          item.mode,
          item.bucket,
          item.likelyNextWork,
          item.patterns.slice(0, 4).join(", "),
        ]),
      ]),
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

async function readEvalArtifact(root: string, split: string): Promise<EvalArtifact> {
  const filePath = path.join(root, ".cache", "eval", `${split}-results.json`);
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${filePath}. Run npm run eval${split === "holdout" ? ":holdout" : ""} first. ${error}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const requestedSplits = typeof args.split === "string" ? args.split.split(",").map((item) => item.trim()).filter(Boolean) : DEFAULT_SPLITS;
  const outputDir = typeof args.outputDir === "string" ? path.resolve(root, args.outputDir) : path.join(root, ".cache", "eval");
  const { groups, cases } = await loadDataset(root);
  const splits = groupSplit(groups);
  const caseById = new Map(cases.map((testCase) => [testCase.id, testCase]));
  const report = {
    generatedAt: new Date().toISOString(),
    splitGroups: Object.fromEntries(Object.entries(splits).filter(([, value]) => value instanceof Set).map(([key, value]) => [key, [...(value as Set<string>)].sort()])),
    splits: {},
  };

  for (const split of requestedSplits) {
    const artifact = await readEvalArtifact(root, split);
    const enrichedErrors = artifact.errors.map((error) => {
      const testCase = caseById.get(error.id);
      if (!testCase) throw new Error(`Case ${error.id} from ${split} eval artifact was not found in dataset`);
      return enrichError(error, testCase);
    });
    report.splits[split] = {
      summary: summarizeEnriched(split, artifact, enrichedErrors),
      errors: enrichedErrors,
    };
  }

  await fs.mkdir(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "diagnostics.json");
  const mdPath = path.join(outputDir, "diagnostics.md");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(mdPath, renderMarkdown(report), "utf8");
  process.stdout.write(`${JSON.stringify({ jsonPath, mdPath, splits: requestedSplits, summaries: Object.fromEntries(Object.entries(report.splits).map(([split, value]) => [split, (value as any).summary])) }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
