#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { loadDataset, groupSplit } from "./cases.js";
import { extractNumbers, tokenize, uniqueTokens } from "../src/normalize.js";
import { predict } from "../src/predictor.js";
import {
  BROAD_EVIDENCE_KINDS,
  FEATURE_STRUCTURAL_EVIDENCE_KINDS as STRUCTURAL_EVIDENCE_KINDS,
  NOISY_SHARED_EVIDENCE_KINDS,
} from "../src/predictor/scorer-registry.js";

function parseArgs(argv) {
  const args = { split: "dev" };
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

function sameSet(left, right) {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function round4(value) {
  return Math.round((Number.isFinite(value) ? value : 0) * 10000) / 10000;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return round4(sorted[index]);
}

function answerIdIndex(id) {
  const code = String(id ?? "").charCodeAt(0);
  return Number.isFinite(code) ? code - 65 : 0;
}

function numericIntentFlags(intent) {
  return {
    intentNegative: intent?.negative ? 1 : 0,
    intentException: intent?.exception ? 1 : 0,
    intentNumeric: intent?.numeric ? 1 : 0,
    intentListLike: intent?.listLike ? 1 : 0,
  };
}

/**
 * Превращает диагностические evidence-данные predictor в числовые признаки без текста PDF,
 * вопроса или варианта ответа.
 */
function evidenceSummary(answerEvidence) {
  const kindCounts = answerEvidence?.kindCounts ?? {};
  const kindBestScores = answerEvidence?.kindBestScores ?? {};
  let structuralCount = 0;
  let broadCount = 0;
  let noisySharedCount = 0;
  let bestStructuralScore = 0;
  let bestBroadScore = 0;
  let bestNoisySharedScore = 0;
  let bestEvidenceScore = answerEvidence?.bestEvidenceScore ?? 0;
  let bestEvidenceKind = "";

  for (const [kind, count] of Object.entries(kindCounts)) {
    const numericCount = Number(count) || 0;
    const bestKindScore = Number(kindBestScores[kind] ?? 0) || 0;
    if (bestKindScore > bestEvidenceScore) bestEvidenceScore = bestKindScore;
    if (bestKindScore >= (Number(kindBestScores[bestEvidenceKind] ?? 0) || 0)) bestEvidenceKind = kind;

    if (STRUCTURAL_EVIDENCE_KINDS.has(kind)) {
      structuralCount += numericCount;
      bestStructuralScore = Math.max(bestStructuralScore, bestKindScore);
    }
    if (BROAD_EVIDENCE_KINDS.has(kind)) {
      broadCount += numericCount;
      bestBroadScore = Math.max(bestBroadScore, bestKindScore);
    }
    if (NOISY_SHARED_EVIDENCE_KINDS.has(kind)) {
      noisySharedCount += numericCount;
      bestNoisySharedScore = Math.max(bestNoisySharedScore, bestKindScore);
    }
  }

  const bestKindIsStructural = STRUCTURAL_EVIDENCE_KINDS.has(bestEvidenceKind) ? 1 : 0;
  const bestKindIsBroad = BROAD_EVIDENCE_KINDS.has(bestEvidenceKind) ? 1 : 0;
  const bestKindIsNoisyShared = NOISY_SHARED_EVIDENCE_KINDS.has(bestEvidenceKind) ? 1 : 0;

  return {
    evidenceCount: answerEvidence?.evidenceCount ?? 0,
    uniqueEvidencePages: answerEvidence?.uniqueEvidencePages ?? 0,
    bestEvidenceScore: round4(bestEvidenceScore),
    structuralEvidenceCount: structuralCount,
    broadEvidenceCount: broadCount,
    noisySharedEvidenceCount: noisySharedCount,
    bestStructuralScore: round4(bestStructuralScore),
    bestBroadScore: round4(bestBroadScore),
    bestNoisySharedScore: round4(bestNoisySharedScore),
    hasStructuralEvidence: structuralCount > 0 ? 1 : 0,
    hasBroadEvidence: broadCount > 0 ? 1 : 0,
    hasNoisySharedEvidence: noisySharedCount > 0 ? 1 : 0,
    broadOnlyEvidence: broadCount > 0 && structuralCount === 0 ? 1 : 0,
    noisySharedOnlyEvidence: noisySharedCount > 0 && structuralCount === 0 ? 1 : 0,
    bestKindIsStructural,
    bestKindIsBroad,
    bestKindIsNoisyShared,
    bestKindIsOther: bestEvidenceKind && !bestKindIsStructural && !bestKindIsBroad ? 1 : 0,
    evidenceKindCounts: Object.fromEntries(Object.entries(kindCounts).map(([kind, count]) => [kind, Number(count) || 0])),
  };
}

function evidenceRefs(diagnostics, answerId) {
  return (diagnostics?.answerEvidence?.[answerId]?.refs ?? []).filter((item) => Number.isFinite(item?.score));
}

function strongestKey(scoreMap) {
  let bestKey = null;
  let bestScore = 0;
  for (const [key, score] of scoreMap.entries()) {
    if (score > bestScore) {
      bestKey = key;
      bestScore = score;
    }
  }
  return { key: bestKey, score: bestScore };
}

function scoreMap(refs, keyFn) {
  const out = new Map();
  for (const ref of refs) {
    const key = keyFn(ref);
    out.set(key, (out.get(key) ?? 0) + Number(ref.score ?? 0));
  }
  return out;
}

function scoreOverlap(left, right) {
  let overlap = 0;
  let leftTotal = 0;
  for (const [key, value] of left.entries()) {
    leftTotal += value;
    overlap += Math.min(value, right.get(key) ?? 0);
  }
  return leftTotal > 0 ? overlap / leftTotal : 0;
}

/**
 * Собирает агрегаты по страницам и видам evidence для уже выбранных и верхних по raw-score ответов.
 * Эти признаки помогают исследовать multi-кейсы без доступа к строковым данным.
 */
function buildClusterContext(diagnostics, output, rawSorted) {
  const selectedIds = output.selected ?? [];
  const selectedRefs = selectedIds.flatMap((id) => evidenceRefs(diagnostics, id));
  const topRawRefs = rawSorted.slice(0, 1).flatMap((item) => evidenceRefs(diagnostics, item.id));
  const topTwoRefs = rawSorted.slice(0, 2).flatMap((item) => evidenceRefs(diagnostics, item.id));
  const selectedPageScores = scoreMap(selectedRefs, (ref) => ref.page);
  const selectedKindScores = scoreMap(selectedRefs, (ref) => ref.kind);
  const topRawPageScores = scoreMap(topRawRefs, (ref) => ref.page);
  const topRawKindScores = scoreMap(topRawRefs, (ref) => ref.kind);
  const topTwoPageScores = scoreMap(topTwoRefs, (ref) => ref.page);
  const topTwoKindScores = scoreMap(topTwoRefs, (ref) => ref.kind);
  const dominantSelectedPage = strongestKey(selectedPageScores);
  const dominantSelectedKind = strongestKey(selectedKindScores);

  return {
    selectedPageScores,
    selectedKindScores,
    topRawPageScores,
    topRawKindScores,
    topTwoPageScores,
    topTwoKindScores,
    dominantSelectedPage,
    dominantSelectedKind,
    selectedRefsTotalScore: selectedRefs.reduce((sum, ref) => sum + Number(ref.score ?? 0), 0),
    selectedRefsCount: selectedRefs.length,
  };
}

function clusterFeatureSummary(answerId, diagnostics, clusterContext) {
  const refs = evidenceRefs(diagnostics, answerId);
  const pageScores = scoreMap(refs, (ref) => ref.page);
  const kindScores = scoreMap(refs, (ref) => ref.kind);
  const bestPage = strongestKey(pageScores);
  const bestKind = strongestKey(kindScores);
  const totalScore = refs.reduce((sum, ref) => sum + Number(ref.score ?? 0), 0);
  const selectedTotal = Math.max(0.0001, clusterContext.selectedRefsTotalScore);

  return {
    evidenceRefCount: refs.length,
    evidenceRefTotalScore: round4(totalScore),
    evidenceBestPageScoreShare: round4(bestPage.score / Math.max(0.0001, totalScore)),
    evidenceBestKindScoreShare: round4(bestKind.score / Math.max(0.0001, totalScore)),
    candidateBestPageMatchesSelectedDominant: bestPage.key !== null && bestPage.key === clusterContext.dominantSelectedPage.key ? 1 : 0,
    candidateBestKindMatchesSelectedDominant: bestKind.key !== null && bestKind.key === clusterContext.dominantSelectedKind.key ? 1 : 0,
    candidatePageOverlapSelected: round4(scoreOverlap(pageScores, clusterContext.selectedPageScores)),
    candidateKindOverlapSelected: round4(scoreOverlap(kindScores, clusterContext.selectedKindScores)),
    candidatePageOverlapTopRaw: round4(scoreOverlap(pageScores, clusterContext.topRawPageScores)),
    candidateKindOverlapTopRaw: round4(scoreOverlap(kindScores, clusterContext.topRawKindScores)),
    candidatePageOverlapTopTwo: round4(scoreOverlap(pageScores, clusterContext.topTwoPageScores)),
    candidateKindOverlapTopTwo: round4(scoreOverlap(kindScores, clusterContext.topTwoKindScores)),
    candidateEvidenceScoreShareOfSelected: round4(totalScore / selectedTotal),
    selectedClusterEvidenceCount: clusterContext.selectedRefsCount,
  };
}

/**
 * Строит один feature-row для пары "кейс + вариант ответа".
 * В `features` попадают только абстрактные числовые и категориальные сигналы, пригодные для offline-калибровки.
 */
function buildAnswerFeature({ answer, mode, output, diagnostics, clusterContext, rawSorted, scoreSorted, testCase }) {
  const raw = Number(output.rawScores?.[answer.id] ?? 0);
  const score = Number(output.scores?.[answer.id] ?? 0);
  const rawRankIndex = rawSorted.findIndex((item) => item.id === answer.id);
  const scoreRankIndex = scoreSorted.findIndex((item) => item.id === answer.id);
  const rawRank = rawRankIndex >= 0 ? rawRankIndex + 1 : rawSorted.length;
  const scoreRank = scoreRankIndex >= 0 ? scoreRankIndex + 1 : scoreSorted.length;
  const topRaw = rawSorted[0]?.raw ?? 0;
  const secondRaw = rawSorted[1]?.raw ?? 0;
  const thirdRaw = rawSorted[2]?.raw ?? 0;
  const minRaw = rawSorted[rawSorted.length - 1]?.raw ?? 0;
  const rawSpan = Math.max(0.0001, topRaw - minRaw);
  const previousRaw = rawRankIndex > 0 ? rawSorted[rawRankIndex - 1].raw : raw;
  const nextRaw = rawRankIndex >= 0 && rawRankIndex + 1 < rawSorted.length ? rawSorted[rawRankIndex + 1].raw : raw;
  const answerTokens = uniqueTokens(answer.text);
  const answerTokensRaw = tokenize(answer.text, { keepStopwords: true, stem: false });
  const questionTokens = uniqueTokens(testCase.question);
  const answerNumberCount = extractNumbers(answer.text).length;
  const questionNumberCount = extractNumbers(testCase.question).length;
  const answerEvidence = diagnostics?.answerEvidence?.[answer.id];
  const summary = evidenceSummary(answerEvidence);

  return {
    modeSingle: mode === "single" ? 1 : 0,
    modeMulti: mode === "multi" ? 1 : 0,
    answerCount: testCase.answers.length,
    rawScore: round4(raw),
    calibratedScore: round4(score),
    rawRank,
    scoreRank,
    rawRankRatio: round4((rawRank - 1) / Math.max(1, testCase.answers.length - 1)),
    scoreRankRatio: round4((scoreRank - 1) / Math.max(1, testCase.answers.length - 1)),
    rawGapToTop: round4(topRaw - raw),
    rawGapFromPrevious: round4(previousRaw - raw),
    rawGapToNext: round4(raw - nextRaw),
    rawRatioToTop: round4(raw / Math.max(0.0001, topRaw)),
    rawRelativeToSpan: round4((raw - minRaw) / rawSpan),
    topRawScore: round4(topRaw),
    secondRawScore: round4(secondRaw),
    thirdRawScore: round4(thirdRaw),
    topSecondRawGap: round4(topRaw - secondRaw),
    secondThirdRawGap: round4(secondRaw - thirdRaw),
    selectedCount: output.selected?.length ?? 0,
    selectedCountRatio: round4((output.selected?.length ?? 0) / Math.max(1, testCase.answers.length)),
    questionTokenCount: questionTokens.length,
    answerTokenCount: answerTokens.length,
    answerRawTokenCount: answerTokensRaw.length,
    questionNumberCount,
    answerNumberCount,
    answerHasNumber: answerNumberCount > 0 ? 1 : 0,
    questionHasNumber: questionNumberCount > 0 ? 1 : 0,
    ...numericIntentFlags(output.meta?.intent),
    ...summary,
    ...clusterFeatureSummary(answer.id, diagnostics, clusterContext),
  };
}

function collectStringFeatureValues(value, pathParts = [], out = []) {
  if (typeof value === "string") {
    out.push(pathParts.join("."));
    return out;
  }
  if (!value || typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value)) {
    collectStringFeatureValues(child, [...pathParts, key], out);
  }
  return out;
}

/**
 * Формирует сводку экспорта и guardrail-проверки, включая запрет строковых значений внутри `features`.
 */
function summarize(caseRecords, rows, splitName, splitGroups, skippedNoExpected) {
  const currentCorrect = caseRecords.filter((record) => record.correct).length;
  const singleRecords = caseRecords.filter((record) => record.mode === "single");
  const multiRecords = caseRecords.filter((record) => record.mode === "multi");
  const oracleTopKCorrect = caseRecords.filter((record) => record.oracleTopKCorrect).length;
  const singleErrorExpectedRanks = singleRecords
    .filter((record) => !record.correct)
    .map((record) => record.expectedRanks[0])
    .filter((rank) => Number.isFinite(rank));
  const multiLengthPairs = new Map();
  for (const record of multiRecords) {
    const key = `${record.selectedCount}/${record.expectedCount}`;
    multiLengthPairs.set(key, (multiLengthPairs.get(key) ?? 0) + 1);
  }

  const featureStringValuePaths = rows.flatMap((row) => collectStringFeatureValues(row.features));
  const positiveRows = rows.filter((row) => row.label === 1).length;
  const selectedPositiveRows = rows.filter((row) => row.label === 1 && row.baselineSelected === 1).length;
  const selectedRows = rows.filter((row) => row.baselineSelected === 1).length;
  const evidenceKinds = new Set();
  for (const row of rows) {
    for (const kind of Object.keys(row.features.evidenceKindCounts ?? {})) evidenceKinds.add(kind);
  }

  return {
    split: splitName,
    groups: [...splitGroups].sort(),
    cases: caseRecords.length,
    answerRows: rows.length,
    positives: positiveRows,
    selectedRows,
    selectedPositiveRows,
    skippedNoExpected,
    exactAccuracy: round4(currentCorrect / Math.max(1, caseRecords.length)),
    singleAccuracy: round4(singleRecords.filter((record) => record.correct).length / Math.max(1, singleRecords.length)),
    multiExactAccuracy: round4(multiRecords.filter((record) => record.correct).length / Math.max(1, multiRecords.length)),
    oracleTopKByKnownCardinality: round4(oracleTopKCorrect / Math.max(1, caseRecords.length)),
    multiOracleTopKByKnownCardinality: round4(multiRecords.filter((record) => record.oracleTopKCorrect).length / Math.max(1, multiRecords.length)),
    singleErrorExpectedRankCounts: countValues(singleErrorExpectedRanks),
    singleErrorGapToTop: {
      p25: percentile(singleRecords.filter((record) => !record.correct).map((record) => record.expectedGapToTop), 0.25),
      p50: percentile(singleRecords.filter((record) => !record.correct).map((record) => record.expectedGapToTop), 0.5),
      p75: percentile(singleRecords.filter((record) => !record.correct).map((record) => record.expectedGapToTop), 0.75),
    },
    multiSelectedExpectedLengthPairs: Object.fromEntries([...multiLengthPairs.entries()].sort((a, b) => b[1] - a[1])),
    evidenceKindKeys: [...evidenceKinds].sort(),
    featureGuard: {
      featureRowsExcludeQuestionText: true,
      featureRowsExcludeAnswerText: true,
      featureRowsExcludePdfText: true,
      featureRowsExcludePdfGroup: true,
      featureRowsExcludeCaseId: true,
      stringValuesInsideFeatures: [...new Set(featureStringValuePaths)].sort(),
    },
  };
}

function countValues(values) {
  const out = new Map();
  for (const value of values) out.set(String(value), (out.get(String(value)) ?? 0) + 1);
  return Object.fromEntries([...out.entries()].sort((a, b) => Number(a[0]) - Number(b[0])));
}

/**
 * Экспортирует offline-признаки по выбранному split.
 * Метки сохраняются только для анализа в `scripts/`; runtime predictor их не получает.
 */
async function exportFeatures(splitName, options) {
  const root = process.cwd();
  const { groups, cases } = await loadDataset(root);
  const splits = groupSplit(groups);
  const splitGroups = splitName === "all" ? new Set(groups) : splits[splitName];
  if (!splitGroups) throw new Error(`Unknown split "${splitName}". Use train, dev, holdout, or all.`);

  const limit = options.limit ? Number(options.limit) : 0;
  const splitCases = cases.filter((testCase) => splitGroups.has(testCase.pdfGroup));
  const skippedNoExpected = splitCases.filter((testCase) => !testCase.expectedIds.length).length;
  const selectedCases = splitCases.filter((testCase) => testCase.expectedIds.length).slice(0, limit > 0 ? limit : undefined);
  const pdfBuffers = new Map();
  const rows = [];
  const caseRecords = [];

  async function readPdf(pdfPath) {
    if (!pdfBuffers.has(pdfPath)) {
      pdfBuffers.set(pdfPath, await fs.readFile(pdfPath));
    }
    return pdfBuffers.get(pdfPath);
  }

  for (let i = 0; i < selectedCases.length; i += 1) {
    const testCase = selectedCases[i];
    const output = await predict(
      {
        pdfData: await readPdf(testCase.pdfPath),
        cacheKey: testCase.pdfPath,
        question: testCase.question,
        answers: testCase.answers,
        mode: testCase.mode,
      },
      { diagnostics: true },
    );
    const expectedSet = new Set(testCase.expectedIds);
    const selectedSet = new Set(output.selected);
    const rawEntries = testCase.answers.map((answer, index) => ({
      id: answer.id,
      raw: Number(output.rawScores?.[answer.id] ?? 0),
      score: Number(output.scores?.[answer.id] ?? 0),
      index,
    }));
    const rawSorted = [...rawEntries].sort((a, b) => b.raw - a.raw || a.index - b.index);
    const scoreSorted = [...rawEntries].sort((a, b) => b.score - a.score || a.index - b.index);
    const clusterContext = buildClusterContext(output.diagnostics, output, rawSorted);
    const correct = sameSet(output.selected, testCase.expectedIds);
    const oracleTopK = rawSorted.slice(0, testCase.expectedIds.length).map((item) => item.id);
    const expectedRanks = testCase.expectedIds.map((id) => rawSorted.findIndex((item) => item.id === id) + 1);
    const expectedTopRaw = Math.max(...testCase.expectedIds.map((id) => Number(output.rawScores?.[id] ?? 0)), 0);

    caseRecords.push({
      id: testCase.id,
      pdfGroup: testCase.pdfGroup,
      mode: testCase.mode,
      correct,
      expectedCount: testCase.expectedIds.length,
      selectedCount: output.selected.length,
      expectedRanks,
      expectedGapToTop: round4((rawSorted[0]?.raw ?? 0) - expectedTopRaw),
      oracleTopKCorrect: sameSet(oracleTopK, testCase.expectedIds),
    });

    for (let answerIndex = 0; answerIndex < testCase.answers.length; answerIndex += 1) {
      const answer = testCase.answers[answerIndex];
      rows.push({
        meta: {
          caseId: testCase.id,
          pdfGroup: testCase.pdfGroup,
          split: splitName,
          mode: testCase.mode,
          answerId: answer.id,
          answerOrdinal: answerIdIndex(answer.id),
        },
        label: expectedSet.has(answer.id) ? 1 : 0,
        baselineSelected: selectedSet.has(answer.id) ? 1 : 0,
        caseCorrect: correct ? 1 : 0,
        expectedCount: testCase.expectedIds.length,
        selectedCount: output.selected.length,
        features: buildAnswerFeature({
          answer,
          mode: testCase.mode,
          output,
          diagnostics: output.diagnostics,
          clusterContext,
          rawSorted,
          scoreSorted,
          testCase,
        }),
      });
    }

    if ((i + 1) % 100 === 0) {
      process.stderr.write(`exported features for ${i + 1}/${selectedCases.length} ${splitName} cases\n`);
    }
  }

  const summary = summarize(caseRecords, rows, splitName, splitGroups, skippedNoExpected);
  const artifact = {
    generatedAt: new Date().toISOString(),
    split: splitName,
    guardrails: {
      runtimeUsesNoLabels: true,
      labelsAreOfflineOnly: true,
      featuresDoNotContainQuestionAnswerOrPdfText: true,
      pdfGroupAndCaseIdAreMetadataOnly: true,
      intendedValidation: ["group split by PDF", "holdout split", "leave-PDF-out sanity check before freezing weights"],
    },
    summary,
    rows,
  };

  const outputPath =
    typeof options.output === "string"
      ? path.resolve(root, options.output)
      : path.join(root, ".cache", "features", `${splitName}${limit > 0 ? `-limit-${limit}` : ""}-features.json`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(artifact, null, 2), "utf8");
  return { outputPath, summary };
}

/**
 * CLI-вход: выбирает split, запускает экспорт и печатает путь к созданному артефакту.
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const splitName = ["train", "dev", "holdout", "all"].includes(String(args.split)) ? String(args.split) : "dev";
  const result = await exportFeatures(splitName, args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
