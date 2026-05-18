import type { AnswerMode, AnswerScore } from "./types.js";
import type { PredictorConfig } from "./config.js";
import { normalizeForSearch, tokenize } from "../normalize.js";

const STRUCTURAL_EVIDENCE_WEIGHTS = new Map(
  Object.entries({
    coordinate_table_row: 1.25,
    coordinate_table_group: 1.25,
    coordinate_table_group_inverse: 1.25,
    coordinate_table_multicell_row: 1.25,
    visual_table_column: 1.2,
    exact_short_label_visual_row: 1.15,
    short_label_visual_row: 1.05,
    answer_ordinal_row: 1.05,
    fibrosis_stage_row: 1.2,
    gene_sentence_segment: 1.1,
    clinical_feature_segment: 1.0,
    mkb_class_exclusion_absent: 1.0,
    classification_code_segment: 1.15,
    label_number_proximity: 1.0,
    label_definition_segment: 1.0,
    row_label_segment: 0.95,
    bounded_list_segment: 0.95,
    ordinal_list_segment: 0.9,
    drug_dose_segment: 0.9,
    recommendation_item_segment: 0.85,
    explicit_recommendation_target_segment: 0.85,
    numeric_condition_less_than: 0.85,
    numeric_condition_more_than: 0.85,
    numeric_condition_equal: 0.85,
    conditioned_number_segment: 0.8,
    cloze_gap_local: 0.8,
  }),
);

const BROAD_EVIDENCE_KINDS = new Set([
  "bm25_question_answer",
  "question_chunk_answer",
  "answer_chunk_question",
  "answer_window",
  "focused_answer_window",
  "shared_multi_segment",
]);

const NOISY_SHARED_EVIDENCE_KINDS = new Set(["question_chunk_answer", "bm25_question_answer", "shared_multi_segment"]);

/**
 * Преобразует raw score вариантов в относительные confidence-like score.
 */
export function calibrateScores(answerScores: AnswerScore[]) {
  const rawValues = answerScores.map((item) => item.raw);
  const max = Math.max(...rawValues, 0.0001);
  const min = Math.min(...rawValues, 0);
  const span = Math.max(0.0001, max - min);
  const expValues = rawValues.map((value) => Math.exp((value - max) / 2.2));
  const expSum = expValues.reduce((sum, value) => sum + value, 0) || 1;

  return answerScores.map((item, index) => {
    const relative = (item.raw - min) / span;
    const probability = expValues[index] / expSum;
    const confidence = Math.max(probability, relative * 0.88);
    return { ...item, score: round4(confidence), relative };
  });
}

/**
 * Применяет зафиксированные post-scoring корректировки, оставленные после
 * валидационных прогонов.
 *
 * Это по-прежнему детерминированная non-LLM логика: она использует только
 * признаки score/evidence, полученные эвристическими scorers.
 */
export function applyFrozenFeatureRanker(answerScores: AnswerScore[], mode: AnswerMode, config: PredictorConfig, context: { question?: string } = {}) {
  if (!config.frozenFeatureRanker) return answerScores;
  const allowMultiPruning = mode === "multi" && multiPruningAllowed(context.question ?? "");

  const ranked = answerScores.map((item) => {
    const summary = summarizeEvidence(item);
    let raw = item.raw;

    if (summary.bestStructuralScore >= 10) {
      raw += Math.min(1.1, summary.bestStructuralScore * 0.035 * summary.structuralWeight);
    }
    if (allowMultiPruning && summary.broadOnly && item.raw >= 8) {
      raw *= 0.985;
    }
    if (allowMultiPruning && summary.noisySharedOnly && item.raw >= 8) {
      raw *= 0.975;
    }

    return { ...item, raw };
  });

  const contrasted = config.pairwiseContrastRanker ? applyPairwiseContrast(ranked, mode) : ranked;
  return config.structuralClusterAdjustments ? applyStructuralClusterAdjustments(contrasted, mode, allowMultiPruning) : contrasted;
}

/**
 * Выбирает финальные id ответов из калиброванных score для single/multi режима.
 */
export function selectAnswers(scored: ReturnType<typeof calibrateScores>, mode: AnswerMode, config: PredictorConfig) {
  const sorted = [...scored].sort((a, b) => b.raw - a.raw);
  if (mode === "single") return selectSingleAnswer(sorted, config);

  const maxRaw = sorted[0]?.raw ?? 0;
  const minRaw = sorted[sorted.length - 1]?.raw ?? 0;
  const span = Math.max(0.0001, maxRaw - minRaw);
  const threshold = Math.max(config.multiAbsoluteThreshold, maxRaw * config.multiRelativeThreshold);
  let selected = sorted
    .filter((item) => {
      const gapRelative = (item.raw - minRaw) / span;
      return item.raw >= threshold || gapRelative >= config.multiGapThreshold;
    })
    .map((item) => item.answer.id);

  if (config.multiMinAnswers > 1 && selected.length < config.multiMinAnswers && sorted.length >= config.multiMinAnswers) {
    selected = sorted.slice(0, config.multiMinAnswers).map((item) => item.answer.id);
  }
  if (
    selected.length === 2 &&
    sorted.length >= 3 &&
    sorted[1].raw - sorted[2].raw <= config.multiThirdGapThreshold &&
    sorted[2].raw >= maxRaw * config.multiThirdRelativeThreshold
  ) {
    selected = sorted.slice(0, 3).map((item) => item.answer.id);
  }
  if (config.multiAllOptionsGuard) {
    selected = applyMultiAllOptionsGuard(sorted, selected, scored);
  }
  if (config.multiCrowdedTailGuard) {
    selected = applyMultiCrowdedTailGuard(sorted, selected);
  }
  if (config.multiCardinalityModel) {
    selected = applyMultiCardinalityModel(sorted, selected, scored);
  }
  if (config.multiCardinalityModel) {
    selected = applyStructuralEvidenceGroupCompletion(sorted, selected, scored);
  }
  selected = dedupeSelectedByAnswerText(selected, sorted);
  if (!selected.length && sorted.length) selected = [sorted[0].answer.id];
  return selected.sort((a, b) => scored.findIndex((item) => item.answer.id === a) - scored.findIndex((item) => item.answer.id === b));
}

function selectSingleAnswer(sorted: ReturnType<typeof calibrateScores>, config: PredictorConfig) {
  const top = sorted[0];
  const second = sorted[1];
  if (!top) return [];
  if (!config.singleSpecificityTieBreak || !second) return [top.answer.id];

  const rawGap = top.raw - second.raw;
  const rawRatio = second.raw / Math.max(0.001, top.raw);
  if (rawGap > config.singleTieMaxRawGap || rawRatio < config.singleTieMinRawRatio) return [top.answer.id];

  const specificityGap = answerSpecificityScore(second.answer.text) - answerSpecificityScore(top.answer.text);
  if (specificityGap >= config.singleTieSpecificityGap) return [second.answer.id];
  return [top.answer.id];
}

const SINGLE_TIE_NEGATION_CUES = ["\u043d\u0435", "\u043e\u0442\u0441\u0443\u0442\u0441\u0442", "\u043d\u0435\u0432\u044b\u043f"].map((item) =>
  normalizeForSearch(item),
);

function answerSpecificityScore(answerText: string) {
  const normalized = normalizeForSearch(answerText);
  const negation = SINGLE_TIE_NEGATION_CUES.some((cue) => normalized.includes(cue)) ? 0.5 : 0;
  return normalized.length * 0.02 + tokenize(answerText).length * 0.4 + negation;
}

function summarizeEvidence(item: AnswerScore) {
  let bestStructuralScore = 0;
  let structuralWeight = 0;
  let broadCount = 0;
  let noisySharedCount = 0;
  let bestKind = "";
  let bestScore = 0;

  for (const evidence of item.evidence ?? []) {
    const score = evidence.score ?? 0;
    if (score > bestScore) {
      bestScore = score;
      bestKind = evidence.kind;
    }
    const weight = STRUCTURAL_EVIDENCE_WEIGHTS.get(evidence.kind) ?? 0;
    if (weight > 0) {
      bestStructuralScore = Math.max(bestStructuralScore, score);
      structuralWeight = Math.max(structuralWeight, weight);
    }
    if (BROAD_EVIDENCE_KINDS.has(evidence.kind)) broadCount += 1;
    if (NOISY_SHARED_EVIDENCE_KINDS.has(evidence.kind)) noisySharedCount += 1;
  }

  return {
    bestKind,
    bestScore,
    bestStructuralScore,
    structuralWeight,
    broadCount,
    noisySharedCount,
    hasStructural: bestStructuralScore > 0,
    broadOnly: broadCount > 0 && bestStructuralScore <= 0,
    noisySharedOnly: noisySharedCount > 0 && bestStructuralScore <= 0,
  };
}

function applyPairwiseContrast(answerScores: AnswerScore[], mode: AnswerMode) {
  const sorted = [...answerScores].sort((a, b) => b.raw - a.raw);
  if (mode !== "single" || sorted.length < 2) return answerScores;
  const top = sorted[0];
  const second = sorted[1];
  const rawGap = top.raw - second.raw;
  const rawRatio = second.raw / Math.max(0.001, top.raw);
  if (rawGap > 0.85 || rawRatio < 0.965) return answerScores;

  const topSummary = summarizeEvidence(top);
  const secondSummary = summarizeEvidence(second);
  const structuralAdvantage =
    secondSummary.bestStructuralScore * Math.max(0.75, secondSummary.structuralWeight) -
    topSummary.bestStructuralScore * Math.max(0.75, topSummary.structuralWeight);
  if (structuralAdvantage < 3.8 || secondSummary.bestStructuralScore < 9) return answerScores;

  return answerScores.map((item) =>
    item.answer.id === second.answer.id ? { ...item, raw: item.raw + Math.min(0.7, structuralAdvantage * 0.08) } : item,
  );
}

function applyStructuralClusterAdjustments(answerScores: AnswerScore[], mode: AnswerMode, allowMultiPruning: boolean) {
  if (mode !== "multi" || !allowMultiPruning || answerScores.length < 4) return answerScores;
  const clusters = new Map<string, AnswerScore[]>();

  for (const item of answerScores) {
    const evidence = (item.evidence ?? []).find((entry) => NOISY_SHARED_EVIDENCE_KINDS.has(entry.kind) && (entry.text?.length ?? 0) >= 60);
    if (!evidence) continue;
    const key = `${evidence.page}:${evidence.kind}:${normalizeForSearch(evidence.text).slice(0, 180)}`;
    const list = clusters.get(key) ?? [];
    list.push(item);
    clusters.set(key, list);
  }

  const penalties = new Map<string, number>();
  for (const cluster of clusters.values()) {
    if (cluster.length < 3) continue;
    const sorted = [...cluster].sort((a, b) => b.raw - a.raw);
    const clusterTop = sorted[0]?.raw ?? 0;
    for (const item of sorted.slice(2)) {
      const summary = summarizeEvidence(item);
      if (summary.hasStructural) continue;
      if (item.raw < clusterTop * 0.92) continue;
      penalties.set(item.answer.id, Math.max(penalties.get(item.answer.id) ?? 0, 0.035));
    }
  }

  if (!penalties.size) return answerScores;
  return answerScores.map((item) => {
    const penalty = penalties.get(item.answer.id) ?? 0;
    return penalty ? { ...item, raw: item.raw * (1 - penalty) } : item;
  });
}

function multiPruningAllowed(question: string) {
  const normalized = normalizeForSearch(question);
  const recommendationLike =
    normalized.includes(normalizeForSearch("\u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434")) ||
    normalized.includes(normalizeForSearch("\u043d\u0430\u0437\u043d\u0430\u0447")) ||
    normalized.includes(normalizeForSearch("\u043f\u043e\u043a\u0430\u0437\u0430\u043d"));
  if (!recommendationLike) return false;
  const broadListLike = [
    "\u0432\u0441\u0435\u043c \u043f\u0430\u0446\u0438\u0435\u043d\u0442",
    "\u0432\u0441\u0435\u0445 \u043f\u0430\u0446\u0438\u0435\u043d\u0442",
    "\u0434\u0435\u043b\u044f\u0442\u0441\u044f",
    "\u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a",
    "\u0440\u0435\u0436\u0438\u043c \u0434\u043e\u0437\u0438\u0440\u043e\u0432\u0430\u043d",
    "\u0434\u0438\u0444\u0444\u0435\u0440\u0435\u043d\u0446\u0438\u0430\u043b\u044c\u043d\u043e\u0439 \u0434\u0438\u0430\u0433\u043d\u043e\u0441\u0442",
    "\u0438\u0441\u0441\u043b\u0435\u0434\u043e\u0432\u0430\u043d\u0438\u0435 \u0443\u0440\u043e\u0432\u043d\u044f",
  ].map((item) => normalizeForSearch(item));
  return !broadListLike.some((cue) => normalized.includes(cue));
}

function applyMultiCardinalityModel(sorted: ReturnType<typeof calibrateScores>, selectedIds: string[], scored: ReturnType<typeof calibrateScores>) {
  let selected = [...selectedIds];
  const selectedSet = new Set(selected);
  if (selected.length >= 3) {
    const selectedSorted = sorted.filter((item) => selectedSet.has(item.answer.id));
    const weakest = selectedSorted[selectedSorted.length - 1];
    const previous = selectedSorted[selectedSorted.length - 2];
    if (weakest && previous) {
      const weakestSummary = summarizeEvidence(weakest);
      const topRaw = selectedSorted[0]?.raw ?? 0;
      const weakGap = previous.raw - weakest.raw;
      if (!weakestSummary.hasStructural && weakest.raw < topRaw * 0.74 && weakGap > 0.32) {
        selected = selected.filter((id) => id !== weakest.answer.id);
      }
    }
  }

  if (selected.length === 2 && sorted.length >= 3) {
    const third = sorted[2];
    const thirdSummary = summarizeEvidence(third);
    const topRaw = sorted[0]?.raw ?? 0;
    if (thirdSummary.bestStructuralScore >= 11 && third.raw >= topRaw * 0.46 && sorted[1].raw - third.raw <= 1.2) {
      selected = sorted.slice(0, 3).map((item) => item.answer.id);
    }
  }

  return selected.sort((a, b) => scored.findIndex((item) => item.answer.id === a) - scored.findIndex((item) => item.answer.id === b));
}

const STRUCTURAL_GROUP_COMPLETION_KINDS = new Set(["coordinate_table_multicell_row"]);

function structuralGroupEvidenceKey(evidence: AnswerScore["evidence"][number]) {
  if (!STRUCTURAL_GROUP_COMPLETION_KINDS.has(evidence.kind)) return "";
  if ((evidence.score ?? 0) < 24 || (evidence.text?.length ?? 0) < 80) return "";
  return `${evidence.kind}:${evidence.page}:${normalizeForSearch(evidence.text).slice(0, 520)}`;
}

function applyStructuralEvidenceGroupCompletion(
  sorted: ReturnType<typeof calibrateScores>,
  selectedIds: string[],
  scored: ReturnType<typeof calibrateScores>,
) {
  if (selectedIds.length < 2 || sorted.length < 3) return selectedIds;
  const selected = new Set(selectedIds);
  const selectedGroupCounts = new Map<string, number>();

  for (const item of sorted) {
    if (!selected.has(item.answer.id)) continue;
    const keys = new Set((item.evidence ?? []).map(structuralGroupEvidenceKey).filter(Boolean));
    for (const key of keys) selectedGroupCounts.set(key, (selectedGroupCounts.get(key) ?? 0) + 1);
  }

  const strongGroups = new Set([...selectedGroupCounts.entries()].filter(([, count]) => count >= 2).map(([key]) => key));
  if (!strongGroups.size) return selectedIds;

  const topRaw = sorted[0]?.raw ?? 0;
  const additions = [];
  for (const item of sorted) {
    if (selected.has(item.answer.id)) continue;
    if (item.raw < Math.max(12, topRaw * 0.42)) continue;
    const evidence = (item.evidence ?? []).find((entry) => strongGroups.has(structuralGroupEvidenceKey(entry)));
    if (!evidence) continue;
    additions.push(item.answer.id);
    if (additions.length >= 2) break;
  }

  if (!additions.length) return selectedIds;
  return [...selectedIds, ...additions].sort((a, b) => scored.findIndex((item) => item.answer.id === a) - scored.findIndex((item) => item.answer.id === b));
}

function applyMultiAllOptionsGuard(sorted: ReturnType<typeof calibrateScores>, selectedIds: string[], scored: ReturnType<typeof calibrateScores>) {
  if (selectedIds.length !== scored.length) return selectedIds;
  if (scored.length < 3 || scored.length > 4) return selectedIds;
  return sorted.slice(0, 2).map((item) => item.answer.id);
}

function applyMultiCrowdedTailGuard(sorted: ReturnType<typeof calibrateScores>, selectedIds: string[]) {
  if (sorted.length !== 4 || selectedIds.length !== 3) return selectedIds;

  const topGap = sorted[0].raw - sorted[1].raw;
  const tailGap = sorted[2].raw - sorted[3].raw;
  if (topGap <= 0 || tailGap >= 0.3) return selectedIds;

  return sorted.slice(0, 2).map((item) => item.answer.id);
}

function dedupeSelectedByAnswerText(selectedIds: string[], sorted: ReturnType<typeof calibrateScores>) {
  if (selectedIds.length < 2) return selectedIds;
  const selected = new Set(selectedIds);
  const seenText = new Set<string>();
  const kept = [];
  for (const item of sorted) {
    if (!selected.has(item.answer.id)) continue;
    const key = normalizeForSearch(item.answer.text);
    if (key && seenText.has(key)) continue;
    if (key) seenText.add(key);
    kept.push(item.answer.id);
  }
  return kept.length ? kept : selectedIds;
}

/**
 * Округляет числовой score до четырех знаков после запятой.
 */
export function round4(value: number) {
  return Math.round((Number.isFinite(value) ? value : 0) * 10000) / 10000;
}
