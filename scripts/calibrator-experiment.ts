#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

type FeatureRow = {
  meta: {
    caseId: string;
    pdfGroup: string;
    split: string;
    mode: "single" | "multi";
    answerId: string;
  };
  label: number;
  baselineSelected: number;
  caseCorrect: number;
  expectedCount: number;
  selectedCount: number;
  features: Record<string, any>;
};

type FeatureArtifact = {
  summary: {
    split: string;
    featureGuard?: {
      stringValuesInsideFeatures?: string[];
    };
  };
  rows: FeatureRow[];
};

type Dataset = {
  split: string;
  rows: FeatureRow[];
};

type PreparedRow = {
  row: FeatureRow;
  x: number[];
  y: number;
};

type LogisticModel = {
  featureNames: string[];
  mean: number[];
  scale: number[];
  weights: number[];
  bias: number;
};

const DEFAULT_FEATURE_DIR = path.join(process.cwd(), ".cache", "features");
const NUMERIC_EPSILON = 1e-8;

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

/**
 * Загружает offline feature artifact и останавливает эксперимент, если guardrail нашел строки внутри `features`.
 */
async function loadFeatureArtifact(split: string, featureDir = DEFAULT_FEATURE_DIR): Promise<Dataset> {
  const filePath = path.join(featureDir, `${split}-features.json`);
  const artifact = JSON.parse(await fs.readFile(filePath, "utf8")) as FeatureArtifact;
  const stringsInsideFeatures = artifact.summary?.featureGuard?.stringValuesInsideFeatures ?? [];
  if (stringsInsideFeatures.length) {
    throw new Error(`${split} features contain string values inside features: ${stringsInsideFeatures.join(", ")}`);
  }
  return { split, rows: artifact.rows };
}

/**
 * Разворачивает вложенные числовые признаки в плоский вектор.
 * Текстовые поля, id кейсов и названия PDF намеренно не попадают в модель.
 */
function flattenFeatures(row: FeatureRow) {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(row.features)) {
    if (key === "evidenceKindCounts") {
      for (const [kind, count] of Object.entries(value ?? {})) {
        out[`kind:${kind}`] = Number(count) || 0;
      }
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value ? 1 : 0;
  }

  // Stable nonlinear transforms of existing numeric features. They do not expose text or ids.
  out.rawScoreLog = Math.log1p(Math.max(0, out.rawScore ?? 0));
  out.rawGapToTopLog = Math.log1p(Math.max(0, out.rawGapToTop ?? 0));
  out.bestEvidenceScoreLog = Math.log1p(Math.max(0, out.bestEvidenceScore ?? 0));
  out.bestStructuralScoreLog = Math.log1p(Math.max(0, out.bestStructuralScore ?? 0));
  out.rawRankInverse = 1 / Math.max(1, out.rawRank ?? 1);
  out.answerCountInverse = 1 / Math.max(1, out.answerCount ?? 1);
  return out;
}

function collectFeatureNames(rows: FeatureRow[]) {
  const names = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(flattenFeatures(row))) names.add(key);
  }
  return [...names].sort();
}

function vectorize(row: FeatureRow, featureNames: string[]) {
  const flat = flattenFeatures(row);
  return featureNames.map((name) => flat[name] ?? 0);
}

function prepareRows(rows: FeatureRow[], featureNames: string[]): PreparedRow[] {
  return rows.map((row) => ({ row, x: vectorize(row, featureNames), y: row.label ? 1 : 0 }));
}

function normalizePreparedRows(rows: PreparedRow[], mean: number[], scale: number[]) {
  return rows.map((item) => ({
    ...item,
    x: item.x.map((value, index) => (value - mean[index]) / scale[index]),
  }));
}

function fitScaler(rows: PreparedRow[]) {
  const size = rows[0]?.x.length ?? 0;
  const mean = Array(size).fill(0);
  const scale = Array(size).fill(1);
  for (const row of rows) {
    for (let i = 0; i < size; i += 1) mean[i] += row.x[i];
  }
  for (let i = 0; i < size; i += 1) mean[i] /= Math.max(1, rows.length);
  for (const row of rows) {
    for (let i = 0; i < size; i += 1) scale[i] += (row.x[i] - mean[i]) ** 2;
  }
  for (let i = 0; i < size; i += 1) {
    scale[i] = Math.sqrt(scale[i] / Math.max(1, rows.length));
    if (scale[i] < NUMERIC_EPSILON) scale[i] = 1;
  }
  return { mean, scale };
}

/**
 * Обучает маленькую logistic regression только на train feature rows.
 * Модель используется как исследовательский отчет и не сохраняется в runtime predictor.
 */
function trainLogisticModel(rawRows: FeatureRow[], featureNames: string[], options: { epochs: number; learningRate: number; l2: number }) {
  const prepared = prepareRows(rawRows, featureNames);
  const { mean, scale } = fitScaler(prepared);
  const rows = normalizePreparedRows(prepared, mean, scale);
  const weights = Array(featureNames.length).fill(0);
  let bias = 0;
  const positives = rows.filter((item) => item.y === 1).length;
  const negatives = rows.length - positives;
  const positiveWeight = rows.length / Math.max(1, 2 * positives);
  const negativeWeight = rows.length / Math.max(1, 2 * negatives);

  for (let epoch = 0; epoch < options.epochs; epoch += 1) {
    const gradient = Array(weights.length).fill(0);
    let biasGradient = 0;

    for (const row of rows) {
      const probability = sigmoid(dot(weights, row.x) + bias);
      const classWeight = row.y ? positiveWeight : negativeWeight;
      const error = (probability - row.y) * classWeight;
      for (let i = 0; i < weights.length; i += 1) gradient[i] += error * row.x[i];
      biasGradient += error;
    }

    for (let i = 0; i < weights.length; i += 1) {
      const regularizedGradient = gradient[i] / rows.length + options.l2 * weights[i];
      weights[i] -= options.learningRate * regularizedGradient;
    }
    bias -= options.learningRate * (biasGradient / rows.length);
  }

  return { featureNames, mean, scale, weights, bias };
}

function probability(model: LogisticModel, row: FeatureRow) {
  const raw = vectorize(row, model.featureNames);
  const x = raw.map((value, index) => (value - model.mean[index]) / model.scale[index]);
  return sigmoid(dot(model.weights, x) + model.bias);
}

function dot(weights: number[], x: number[]) {
  let value = 0;
  for (let i = 0; i < weights.length; i += 1) value += weights[i] * x[i];
  return value;
}

function sigmoid(value: number) {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

function groupRowsByCase(rows: FeatureRow[], model?: LogisticModel) {
  const cases = new Map<string, Array<FeatureRow & { modelScore: number }>>();
  for (const row of rows) {
    const caseRows = cases.get(row.meta.caseId) ?? [];
    caseRows.push({ ...row, modelScore: model ? probability(model, row) : row.features.calibratedScore ?? 0 });
    cases.set(row.meta.caseId, caseRows);
  }
  return [...cases.values()].map((caseRows) => caseRows.sort((a, b) => a.meta.answerId.localeCompare(b.meta.answerId, "en")));
}

function baselineSelection(caseRows: FeatureRow[]) {
  return caseRows.filter((row) => row.baselineSelected).map((row) => row.meta.answerId);
}

function modelSelection(caseRows: Array<FeatureRow & { modelScore: number }>, strategy: SelectionStrategy) {
  if (strategy.mode === "baseline-postprocess") return postprocessBaselineSelection(caseRows, strategy);

  const sorted = [...caseRows].sort((a, b) => b.modelScore - a.modelScore || b.features.rawScore - a.features.rawScore);
  const mode = caseRows[0]?.meta.mode ?? "single";
  if (mode === "single") return [sorted[0]?.meta.answerId].filter(Boolean);

  let selected = sorted.filter((row) => row.modelScore >= strategy.multiThreshold).map((row) => row.meta.answerId);
  const minAnswers = Math.min(strategy.multiMinAnswers, sorted.length);
  if (selected.length < minAnswers) selected = sorted.slice(0, minAnswers).map((row) => row.meta.answerId);
  if (strategy.maxByBaselineSelected && selected.length > Math.max(minAnswers, caseRows[0].selectedCount + strategy.maxByBaselineSlack)) {
    selected = selected.slice(0, Math.max(minAnswers, caseRows[0].selectedCount + strategy.maxByBaselineSlack));
  }
  if (strategy.allOptionsGuard && selected.length === sorted.length && sorted.length >= 3 && sorted.length <= 4) {
    selected = sorted.slice(0, 2).map((row) => row.meta.answerId);
  }
  return selected.sort((a, b) => caseRows.findIndex((row) => row.meta.answerId === a) - caseRows.findIndex((row) => row.meta.answerId === b));
}

function postprocessBaselineSelection(caseRows: Array<FeatureRow & { modelScore: number }>, strategy: SelectionStrategy) {
  const mode = caseRows[0]?.meta.mode ?? "single";
  const sorted = [...caseRows].sort((a, b) => b.modelScore - a.modelScore || b.features.rawScore - a.features.rawScore);
  const selected = new Set(baselineSelection(caseRows));

  if (mode === "single") {
    const baselineRow = caseRows.find((row) => selected.has(row.meta.answerId));
    const top = sorted[0];
    const margin = strategy.singleSwitchMargin ?? Number.POSITIVE_INFINITY;
    if (top && baselineRow && top.meta.answerId !== baselineRow.meta.answerId && top.modelScore >= baselineRow.modelScore + margin) {
      return [top.meta.answerId];
    }
    return [...selected];
  }

  const minAnswers = Math.min(strategy.multiMinAnswers, caseRows.length);
  const pruneThreshold = strategy.pruneThreshold ?? -1;
  const selectedByWeakest = [...caseRows].filter((row) => selected.has(row.meta.answerId)).sort((a, b) => a.modelScore - b.modelScore);
  for (const row of selectedByWeakest) {
    if (selected.size <= minAnswers) break;
    if (row.modelScore < pruneThreshold) selected.delete(row.meta.answerId);
  }

  const addThreshold = strategy.addThreshold ?? 2;
  const addMargin = strategy.addMargin ?? 0;
  for (const row of sorted) {
    if (selected.has(row.meta.answerId)) continue;
    const weakestSelectedScore = Math.min(...caseRows.filter((item) => selected.has(item.meta.answerId)).map((item) => item.modelScore));
    if (row.modelScore >= addThreshold && row.modelScore >= weakestSelectedScore + addMargin) {
      selected.add(row.meta.answerId);
    }
  }

  if (strategy.allOptionsGuard && selected.size === caseRows.length && caseRows.length >= 3 && caseRows.length <= 4) {
    return sorted.slice(0, 2).map((row) => row.meta.answerId);
  }
  return [...selected].sort((a, b) => caseRows.findIndex((row) => row.meta.answerId === a) - caseRows.findIndex((row) => row.meta.answerId === b));
}

type SelectionStrategy = {
  name: string;
  mode: "model" | "baseline-postprocess";
  multiThreshold: number;
  multiMinAnswers: number;
  allOptionsGuard: boolean;
  maxByBaselineSelected: boolean;
  maxByBaselineSlack: number;
  pruneThreshold?: number;
  addThreshold?: number;
  addMargin?: number;
  singleSwitchMargin?: number;
};

function expectedSelection(caseRows: FeatureRow[]) {
  return caseRows.filter((row) => row.label).map((row) => row.meta.answerId);
}

function sameSet(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

/**
 * Считает exact-метрики для baseline или экспериментальной стратегии выбора ответов.
 */
function evaluateRows(rows: FeatureRow[], strategy?: SelectionStrategy, model?: LogisticModel) {
  const cases = model ? groupRowsByCase(rows, model) : groupRowsByCase(rows);
  const records = cases.map((caseRows) => {
    const selected = strategy && model ? modelSelection(caseRows, strategy) : baselineSelection(caseRows);
    const expected = expectedSelection(caseRows);
    return {
      id: caseRows[0].meta.caseId,
      pdfGroup: caseRows[0].meta.pdfGroup,
      mode: caseRows[0].meta.mode,
      selected,
      expected,
      correct: sameSet(selected, expected),
    };
  });
  return summarizeRecords(records);
}

function summarizeRecords(records: Array<{ mode: string; correct: boolean; selected: string[]; expected: string[] }>) {
  const singles = records.filter((record) => record.mode === "single");
  const multis = records.filter((record) => record.mode === "multi");
  return {
    total: records.length,
    correct: records.filter((record) => record.correct).length,
    exactAccuracy: round4(records.filter((record) => record.correct).length / Math.max(1, records.length)),
    singleAccuracy: round4(singles.filter((record) => record.correct).length / Math.max(1, singles.length)),
    multiExactAccuracy: round4(multis.filter((record) => record.correct).length / Math.max(1, multis.length)),
    multiLengthErrors: countValues(
      multis
        .filter((record) => !record.correct)
        .map((record) => `${record.selected.length}/${record.expected.length}`),
    ),
  };
}

function countValues(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]));
}

function round4(value: number) {
  return Math.round((Number.isFinite(value) ? value : 0) * 10000) / 10000;
}

/**
 * Генерирует сетку безопасных стратегий: полная замена selector и осторожный postprocess baseline.
 */
function makeStrategies() {
  const strategies: SelectionStrategy[] = [];
  for (const threshold of range(0.2, 0.85, 0.025)) {
    for (const allOptionsGuard of [false, true]) {
      strategies.push({
        name: `p>=${threshold.toFixed(3)} min2 allGuard=${allOptionsGuard}`,
        mode: "model",
        multiThreshold: round4(threshold),
        multiMinAnswers: 2,
        allOptionsGuard,
        maxByBaselineSelected: false,
        maxByBaselineSlack: 0,
      });
      strategies.push({
        name: `p>=${threshold.toFixed(3)} min2 allGuard=${allOptionsGuard} maxBase+1`,
        mode: "model",
        multiThreshold: round4(threshold),
        multiMinAnswers: 2,
        allOptionsGuard,
        maxByBaselineSelected: true,
        maxByBaselineSlack: 1,
      });
    }
  }
  for (const pruneThreshold of range(0.2, 0.8, 0.025)) {
    for (const addThreshold of [1.01, 0.9, 0.85, 0.8, 0.75, 0.7]) {
      for (const addMargin of [0, 0.05, 0.1, 0.15]) {
        for (const singleSwitchMargin of [Number.POSITIVE_INFINITY, 0.15, 0.25]) {
          strategies.push({
            name: `baseline post prune<${pruneThreshold.toFixed(3)} add>=${addThreshold.toFixed(2)} margin=${addMargin.toFixed(2)} single=${Number.isFinite(singleSwitchMargin) ? singleSwitchMargin.toFixed(2) : "off"}`,
            mode: "baseline-postprocess",
            multiThreshold: 0,
            multiMinAnswers: 2,
            allOptionsGuard: false,
            maxByBaselineSelected: false,
            maxByBaselineSlack: 0,
            pruneThreshold: round4(pruneThreshold),
            addThreshold,
            addMargin,
            singleSwitchMargin,
          });
        }
      }
    }
  }
  return strategies;
}

function range(start: number, end: number, step: number) {
  const values: number[] = [];
  for (let value = start; value <= end + 1e-9; value += step) values.push(round4(value));
  return values;
}

function topWeights(model: LogisticModel, limit = 16) {
  return model.weights
    .map((weight, index) => ({ feature: model.featureNames[index], weight: round4(weight) }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, limit);
}

function validateFeatureNameSafety(featureNames: string[]) {
  const forbidden = /case|pdf|group|answerid|questiontext|answertext|variant|expected/i;
  const bad = featureNames.filter((name) => forbidden.test(name));
  if (bad.length) throw new Error(`Forbidden feature-like names detected: ${bad.join(", ")}`);
}

async function writeReport(report: any) {
  const outputPath = path.join(process.cwd(), ".cache", "features", "calibrator-experiment.json");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
  return outputPath;
}

/**
 * CLI-вход эксперимента: обучает модель на train, выбирает стратегию по dev и пишет отчет.
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const featureDir = typeof args.featureDir === "string" ? path.resolve(args.featureDir) : DEFAULT_FEATURE_DIR;
  const [train, dev, holdout] = await Promise.all([
    loadFeatureArtifact("train", featureDir),
    loadFeatureArtifact("dev", featureDir),
    loadFeatureArtifact("holdout", featureDir),
  ]);

  const featureNames = collectFeatureNames(train.rows);
  validateFeatureNameSafety(featureNames);
  const model = trainLogisticModel(train.rows, featureNames, {
    epochs: Number(args.epochs ?? 900),
    learningRate: Number(args.learningRate ?? 0.18),
    l2: Number(args.l2 ?? 0.008),
  });

  const baseline = {
    train: evaluateRows(train.rows),
    dev: evaluateRows(dev.rows),
    holdout: evaluateRows(holdout.rows),
  };

  const strategies = makeStrategies();
  const scoredStrategies = strategies
    .map((strategy) => ({
      strategy,
      train: evaluateRows(train.rows, strategy, model),
      dev: evaluateRows(dev.rows, strategy, model),
    }))
    .sort((a, b) => b.dev.exactAccuracy - a.dev.exactAccuracy || b.dev.multiExactAccuracy - a.dev.multiExactAccuracy || b.train.exactAccuracy - a.train.exactAccuracy);

  const bestByDev = scoredStrategies[0];
  const bestByTrain = [...scoredStrategies].sort(
    (a, b) => b.train.exactAccuracy - a.train.exactAccuracy || b.train.multiExactAccuracy - a.train.multiExactAccuracy || b.dev.exactAccuracy - a.dev.exactAccuracy,
  )[0];
  const report = {
    generatedAt: new Date().toISOString(),
    guardrails: {
      trainedOn: "train",
      selectedBy: "dev",
      holdoutUse: "report-only; do not tune on this split",
      featureNamesExcludeTextAndIds: true,
      featureCount: featureNames.length,
    },
    baseline,
    bestByDev: {
      strategy: bestByDev.strategy,
      train: bestByDev.train,
      dev: bestByDev.dev,
      holdoutReportOnly: evaluateRows(holdout.rows, bestByDev.strategy, model),
    },
    bestByTrain: {
      strategy: bestByTrain.strategy,
      train: bestByTrain.train,
      dev: bestByTrain.dev,
      holdoutReportOnly: evaluateRows(holdout.rows, bestByTrain.strategy, model),
    },
    topDevStrategies: scoredStrategies.slice(0, 8),
    topWeights: topWeights(model),
  };
  const outputPath = await writeReport(report);
  process.stdout.write(`${JSON.stringify({ outputPath, ...report }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
