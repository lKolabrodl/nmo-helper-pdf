import {
  coverage,
  detectQuestionIntent,
  extractNumbers,
  jaccard,
  normalizeText,
  normalizeForSearch,
  phraseTokens,
  stemToken,
  tokenize,
  uniqueTokens,
} from "./normalize.js";
import { FOCUS_STOPWORDS, LABEL_CUES } from "./predictor/constants.js";
import { DEFAULT_CONFIG } from "./predictor/config.js";
import { clearPdfRuntimeCache, getPdfRuntime, normalizeAnswers } from "./predictor/runtime.js";
import { bestDrugDoseSupport } from "./predictor/scorers/drug-dose.js";
import { bestExactAnswerSupport } from "./predictor/scorers/exact-answer.js";
import { bestFibrosisStageSupport } from "./predictor/scorers/fibrosis-stage.js";
import { bestFrequencyRecommendationSupport, frequencyAnswer, frequencySearchPhrases } from "./predictor/scorers/frequency.js";
import { bestGeneSentenceSupport, bestLatinFuzzySupport, geneMutationQuestion, latinAnswerTokens, sentenceSegments } from "./predictor/scorers/biomedical-symbols.js";
import {
  bestCoordinateMultiCellRowSupport,
  bestCoordinateTableMembershipSupport,
  bestCoordinateTableGroupSupport,
  bestCoordinateTableRowSupport,
  buildCoordinateMultiCellRowsByPage,
  buildCoordinateTableMembershipsByPage,
  buildCoordinateTableGroupsByPage,
  buildCoordinateTableRowsByPage,
  hasCoordinateTableCue,
  hasCoordinateTableGroupCue,
} from "./predictor/scorers/coordinate-table.js";
import { bestFocusedSupport, bestLineTokenSupport, cachedLineTokenSegments, questionFocusTokens } from "./predictor/scorers/focused.js";
import { bestRecommendationItemSupport, explicitRecommendationTargetAdjustment } from "./predictor/scorers/recommendation-item.js";
import { optionFamilyCompactComboAdjustment, optionFamilyComparatorAdjustment } from "./predictor/scorers/option-family.js";
import {
  contrastCueMismatchAdjustment,
  excludedConditionMismatchAdjustment,
  polarityAdjustment,
  temporalCueAdjustment,
} from "./predictor/scorers/direction.js";
import {
  bestClozeGapSupport,
  bestConditionedNumberSupport,
  bestCountRelationSupport,
  bestExactHourAliasOptionSupport,
  bestExactNumericOptionSupport,
  bestNumericConditionSupport,
  conditionPairAdjustment,
} from "./predictor/scorers/numeric.js";
import {
  bestAnchorSupport,
  bestPhraseSupport,
  bestPrecedingQuestionLabelSupport,
  bestRowLabelSupport,
  bestSectionSupport,
  findAnchorSegments,
  findRowSegments,
  findSectionSegments,
} from "./predictor/scorers/search.js";
import { applyFrozenFeatureRanker, calibrateScores, round4, selectAnswers } from "./predictor/selection.js";
import {
  answerSearchPhrases,
  betterEvidence,
  cachedLineWindowSegments,
  cachedPageTokens,
  containsNormalizedPhrase,
  containsPhrase,
  escapeRegExp,
  evidenceFromChunk,
  evidenceSnippet,
  expandNumberToken,
  findPhraseOccurrences,
  focusedAnswerSearchPhrases,
  hasSearchBoundaries,
  nearestCueName,
  numberCoverage,
  pageWindow,
  proximityBonus,
  rawSoftCoverage,
  rawTokens,
  softCoverage,
  strictSoftCoverage,
  tokenBoundaryIncludes,
  tokenizeNormalized,
  tokenHitCount,
  tokenProximity,
  tokenSequenceIncludes,
} from "./predictor/text-utils.js";

const CLINICAL_FEATURE_GENERIC_TOKENS = new Set(
  [
    "\u0438\u043c\u0435\u0435\u0442",
    "\u0441\u043b\u0435\u0434\u0443\u044e\u0449\u0438\u0435",
    "\u043a\u043b\u0438\u043d\u0438\u0447\u0435\u0441\u043a\u0438\u0435",
    "\u043a\u043b\u0438\u043d\u0438\u0447\u0435\u0441\u043a\u0438",
    "\u043f\u0440\u0438\u0437\u043d\u0430\u043a\u0438",
    "\u043f\u0440\u0438\u0437\u043d\u0430\u043a",
    "\u0441\u0438\u043c\u043f\u0442\u043e\u043c\u044b",
    "\u0441\u0438\u043c\u043f\u0442\u043e\u043c",
    "\u043f\u0440\u043e\u044f\u0432\u043b\u0435\u043d\u0438\u044f",
    "\u043f\u0440\u043e\u044f\u0432\u043b\u0435\u043d\u0438\u0435",
    "\u0444\u043e\u0440\u043c\u0430",
    "\u0444\u043e\u0440\u043c\u044b",
  ].flatMap((item) => uniqueTokens(item)),
);

const CLINICAL_FEATURE_ANSWER_GENERIC_TOKENS = new Set(
  ["\u043e\u0431\u044b\u0447\u043d\u043e", "\u0442\u0438\u043f\u0438\u0447\u043d\u043e", "\u0446\u0432\u0435\u0442\u0430", "\u0446\u0432\u0435\u0442"].flatMap((item) => uniqueTokens(item)),
);

function clinicalFeatureQuestion({ mode, question, intent }) {
  if (mode !== "multi" || intent.negative || intent.exception) return false;
  const normalized = normalizeForSearch(question);
  return (
    containsNormalizedPhrase(normalized, "\u0438\u043c\u0435") &&
    containsNormalizedPhrase(normalized, "\u0441\u043b\u0435\u0434\u0443\u044e") &&
    containsNormalizedPhrase(normalized, "\u043a\u043b\u0438\u043d\u0438\u0447") &&
    containsNormalizedPhrase(normalized, "\u043f\u0440\u0438\u0437\u043d")
  );
}

function clinicalFeatureFocusTokens(question) {
  return uniqueTokens(question).filter((token) => token.length >= 4 && !CLINICAL_FEATURE_GENERIC_TOKENS.has(token) && !FOCUS_STOPWORDS.has(token));
}

function clinicalFeatureAnswerTokens(answerText) {
  return uniqueTokens(answerText).filter((token) => token.length >= 4 && !CLINICAL_FEATURE_ANSWER_GENERIC_TOKENS.has(token) && !FOCUS_STOPWORDS.has(token));
}

function answerHasNegativeClinicalCue(answerText) {
  const normalized = normalizeForSearch(answerText);
  return (
    containsNormalizedPhrase(normalized, "\u043d\u0435 ") ||
    containsNormalizedPhrase(normalized, "\u0431\u0435\u0437 ") ||
    containsNormalizedPhrase(normalized, "\u043e\u0442\u0441\u0443\u0442") ||
    containsNormalizedPhrase(normalized, "\u043d\u0435\u0442\u0438\u043f\u0438\u0447")
  );
}

function clinicalFeatureSentenceNegative(normalizedSentence) {
  return (
    containsNormalizedPhrase(normalizedSentence, "\u043d\u0435 \u0442\u0438\u043f\u0438\u0447") ||
    containsNormalizedPhrase(normalizedSentence, "\u043d\u0435\u0442\u0438\u043f\u0438\u0447") ||
    containsNormalizedPhrase(normalizedSentence, "\u043d\u0435 \u0445\u0430\u0440\u0430\u043a\u0442\u0435\u0440") ||
    containsNormalizedPhrase(normalizedSentence, "\u043d\u0435 \u044f\u0432\u043b\u044f") ||
    containsNormalizedPhrase(normalizedSentence, "\u043e\u0442\u0441\u0443\u0442") ||
    containsNormalizedPhrase(normalizedSentence, "\u0431\u0435\u0437 ")
  );
}

function clinicalFeatureCandidateSentences(pageText, focusTokens) {
  const sentences = sentenceSegments(pageText).map((sentence) => {
    const normalized = normalizeForSearch(sentence);
    const tokens = tokenizeNormalized(normalized);
    return { sentence, normalized, tokens, focusHits: tokenHitCount(focusTokens, tokens) };
  });
  const anchors = sentences.map((item, index) => (item.focusHits > 0 ? index : -1)).filter((index) => index >= 0);
  if (!anchors.length) return [];

  return sentences
    .map((item, index) => {
      const distance = Math.min(...anchors.map((anchor) => (index >= anchor ? index - anchor : Infinity)));
      return { ...item, distance };
    })
    .filter((item) => item.focusHits > 0 || item.distance <= 4);
}

function clinicalFeatureAdjustment(context) {
  const { pages, topQuestionPages, mode, question, answer, intent } = context;
  if (!clinicalFeatureQuestion({ mode, question, intent })) return { support: null, adjustment: 0, evidence: null };
  const focusTokens = clinicalFeatureFocusTokens(question);
  if (!focusTokens.length) return { support: null, adjustment: 0, evidence: null };
  const answerTokens = clinicalFeatureAnswerTokens(answer.text);
  if (answerTokens.length < 2) return { support: null, adjustment: 0, evidence: null };
  const answerNegative = answerHasNegativeClinicalCue(answer.text);
  let bestSupport = null;
  let bestNegated = null;

  for (const page of pages) {
    for (const item of clinicalFeatureCandidateSentences(page.text, focusTokens)) {
      const answerCoverage = Math.max(strictSoftCoverage(answerTokens, item.tokens), softCoverage(answerTokens, item.tokens), rawSoftCoverage(answerTokens, item.tokens));
      if (answerCoverage < 0.5) continue;
      const negated = clinicalFeatureSentenceNegative(item.normalized);
      const focusBonus = Math.min(2, item.focusHits) * 1.1;
      const distanceBonus = Math.max(0, 4 - item.distance) * 0.35;
      const score = 12.4 + answerCoverage * 5.2 + focusBonus + distanceBonus;
      const evidence = {
        answerId: answer.id,
        page: page.page,
        text: item.sentence,
        score,
        kind: negated && !answerNegative ? "clinical_feature_negated" : "clinical_feature_segment",
      };
      if (negated && !answerNegative) bestNegated = betterEvidence(bestNegated, evidence);
      else bestSupport = betterEvidence(bestSupport, evidence);
    }
  }

  if (bestNegated && (!bestSupport || bestNegated.score >= bestSupport.score - 0.8)) {
    return { support: null, adjustment: -8.4, evidence: bestNegated };
  }
  return bestSupport ? { support: bestSupport, adjustment: 0, evidence: null } : { support: null, adjustment: 0, evidence: null };
}

function questionLabelCues(question) {
  const normalized = normalizeForSearch(question);
  return LABEL_CUES.filter((cue) => normalized.includes(cue));
}

function bestLabelNumberSupport({ pages, topQuestionPages, question, answer }) {
  const labels = questionLabelCues(question);
  if (/мкб/u.test(normalizeText(question))) return null;
  if (!labels.length || !extractNumbers(answer.text).length) return null;
  const answerPhrases = answerSearchPhrases(answer.text).slice(0, 12);
  let best = null;
  for (const page of pages) {
    if (topQuestionPages?.size && !topQuestionPages.has(page.page)) continue;
    const pageNorm = page.normalized;
    const labelHits = [];
    for (const label of labels) {
      let start = 0;
      while (start < pageNorm.length) {
        const index = pageNorm.indexOf(label, start);
        if (index < 0) break;
        const around = pageNorm.slice(Math.max(0, index - 24), index + 48);
        if (!containsNormalizedPhrase(around, "степени тяжести")) labelHits.push(index);
        start = index + Math.max(1, label.length);
      }
    }
    if (!labelHits.length) continue;
    for (const phrase of answerPhrases) {
      const hits = findPhraseOccurrences(pageNorm, phrase, { textIsNormalized: true });
      for (const hit of hits) {
        const forwardDistances = labelHits.map((labelHit) => hit - labelHit).filter((distance) => distance >= 0);
        if (!forwardDistances.length) continue;
        const distance = Math.min(...forwardDistances);
        if (distance > 150) continue;
        const local = pageWindow(page, hit, 180);
        const score = 6.6 + proximityBonus(distance, 150) * 4.4 + numberCoverage(answer.text, local) * 1.4;
        best = betterEvidence(best, {
          answerId: answer.id,
          page: page.page,
          text: evidenceSnippet(page.text, phrase, question),
          score,
          kind: "label_number_proximity",
        });
      }
    }
  }
  return best;
}

const CLASSIFICATION_CODE_QUESTION_CUES = [
  "\u043a\u043e\u0434",
  "\u043a\u043e\u0434\u0438\u0440",
  "\u043c\u043a\u0431",
].map((item) => normalizeForSearch(item));

const CLASSIFICATION_CODE_GENERIC_TOKENS = new Set(
  [
    "\u043a\u043e\u0434",
    "\u043a\u043e\u0434\u0438\u0440\u0443\u0435\u0442\u0441\u044f",
    "\u043a\u043e\u0434\u0438\u0440\u043e\u0432\u043a\u0430",
    "\u043c\u043a\u0431",
    "\u043c\u0435\u0436\u0434\u0443\u043d\u0430\u0440\u043e\u0434\u043d\u043e\u0439",
    "\u0441\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u0447\u0435\u0441\u043a\u043e\u0439",
    "\u043a\u043b\u0430\u0441\u0441\u0438\u0444\u0438\u043a\u0430\u0446\u0438\u0438",
    "\u0431\u043e\u043b\u0435\u0437\u043d\u0435\u0439",
    "\u043f\u0440\u043e\u0431\u043b\u0435\u043c",
    "\u0441\u0432\u044f\u0437\u0430\u043d\u043d\u044b\u0445",
    "\u0437\u0434\u043e\u0440\u043e\u0432\u044c\u0435\u043c",
    "\u043a\u0440\u0438\u0442\u0435\u0440\u0438\u0439",
    "\u043a\u0440\u0438\u0442\u0435\u0440\u0438\u0438",
    "\u0443\u043a\u0430\u0437\u044b\u0432\u0430\u0435\u0442",
    "\u0441\u0432\u0438\u0434\u0435\u0442\u0435\u043b\u044c\u0441\u0442\u0432\u0443\u0435\u0442",
    "\u043e\u0442\u0440\u0430\u0436\u0430\u0435\u0442",
    "\u043f\u0440\u0438\u0437\u043d\u0430\u043a\u0438",
    "\u0441\u0442\u0430\u0434\u0438\u044f",
  ].flatMap((item) => uniqueTokens(item)),
);

const CYRILLIC_CODE_LETTERS = new Map([
  ["\u0410", "a"],
  ["\u0412", "b"],
  ["\u0421", "c"],
  ["\u0415", "e"],
  ["\u041d", "h"],
  ["\u041a", "k"],
  ["\u041c", "m"],
  ["\u041e", "o"],
  ["\u0420", "p"],
  ["\u0422", "t"],
  ["\u0425", "x"],
  ["\u0430", "a"],
  ["\u0432", "b"],
  ["\u0441", "c"],
  ["\u0435", "e"],
  ["\u043d", "h"],
  ["\u043a", "k"],
  ["\u043c", "m"],
  ["\u043e", "o"],
  ["\u0440", "p"],
  ["\u0442", "t"],
  ["\u0445", "x"],
]);

function canonicalClassificationCode(text) {
  const normalized = String(text ?? "").normalize("NFKC");
  const match = normalized.match(/(?:^|[^\p{L}\p{N}])([A-Za-z\u0410-\u042f\u0430-\u044f])\s*\.?\s*(\d{1,3})(?:\s*[.]\s*(\d{1,2}))?(?![\p{L}\p{N}])/u);
  if (!match) return null;
  const letter = (CYRILLIC_CODE_LETTERS.get(match[1]) ?? match[1]).toLowerCase();
  if (!/[a-z]/.test(letter)) return null;
  const main = match[2].replace(/^0+(?=\d)/, "");
  const sub = match[3]?.replace(/^0+(?=\d)/, "");
  return sub ? `${letter}${main}.${sub}` : `${letter}${main}`;
}

function canonicalClassificationCodes(text) {
  const normalized = String(text ?? "").normalize("NFKC");
  const codes = [];
  const pattern = /(?:^|[^\p{L}\p{N}])([A-Za-z\u0410-\u042f\u0430-\u044f])\s*\.?\s*(\d{1,3})(?:\s*[.]\s*(\d{1,2}))?(?![\p{L}\p{N}])/gu;
  let match;
  while ((match = pattern.exec(normalized))) {
    const code = canonicalClassificationCode(match[0]);
    if (code) codes.push(code);
  }
  const ocrJPattern = /(?:^|[^\p{L}\p{N}])(?:[.\u041b\u043b])\s*\.?\s*(\d{2,3})(?:\s*[.]\s*(\d{1,2}))?(?![\p{L}\p{N}])/gu;
  while ((match = ocrJPattern.exec(normalized))) {
    const main = match[1].length === 3 && match[1].startsWith("1") ? match[1].slice(1) : match[1];
    if (/^\d{2}$/.test(main)) {
      const sub = match[2]?.replace(/^0+(?=\d)/, "");
      codes.push(sub ? `j${main}.${sub}` : `j${main}`);
    }
  }
  return codes;
}

function classificationCodeWindows(page) {
  const lines = page.lines ?? [];
  const windows = [];
  for (let index = 0; index < lines.length; index += 1) {
    const parts = [lines[index], lines[index + 1], lines[index + 2]].filter(Boolean);
    const one = parts[0]?.trim();
    const two = parts.slice(0, 2).join(" ").replace(/\s+/g, " ").trim();
    const three = parts.join(" ").replace(/\s+/g, " ").trim();
    if (one && one.length >= 4) windows.push(one);
    if (two.length >= 12) windows.push(two);
    if (three.length >= 24) windows.push(three);
  }
  return [...new Set(windows)];
}

function bestClassificationCodeSupport({ pages, topQuestionPages, question, answer, questionTokens, focusTokens }) {
  const code = canonicalClassificationCode(answer.text);
  if (!code) return null;
  const normalizedQuestion = normalizeForSearch(question);
  const isCodeQuestion = CLASSIFICATION_CODE_QUESTION_CUES.some((cue) => normalizedQuestion.includes(cue));
  if (!isCodeQuestion) return null;

  const filteredFocus = focusTokens
    .filter((token) => token.length >= 3 && !CLASSIFICATION_CODE_GENERIC_TOKENS.has(token) && !/^\d/.test(token))
    .slice(0, 12);
  const filteredQuestion = questionTokens
    .filter((token) => token.length >= 3 && !CLASSIFICATION_CODE_GENERIC_TOKENS.has(token) && !/^\d/.test(token))
    .slice(0, 18);
  if (!filteredFocus.length && !filteredQuestion.length) return null;

  let best = null;
  for (const page of pages) {
    if (topQuestionPages?.size && !topQuestionPages.has(page.page)) continue;
    for (const windowText of classificationCodeWindows(page)) {
      const codes = canonicalClassificationCodes(windowText);
      if (!codes.includes(code)) continue;
      const tokens = tokenize(windowText);
      const focusCoverage = filteredFocus.length ? coverage(filteredFocus, tokens) : 0;
      const questionCoverage = filteredQuestion.length ? coverage(filteredQuestion, tokens) : 0;
      if (focusCoverage < 0.22 && questionCoverage < 0.18) continue;
      const codeCountPenalty = Math.max(0, new Set(codes).size - 1) * 0.9;
      const score = 12.8 + focusCoverage * 11 + questionCoverage * 6 + (codes[0] === code ? 1.2 : 0) - codeCountPenalty;
      best = betterEvidence(best, {
        answerId: answer.id,
        page: page.page,
        text: evidenceSnippet(page.text, answer.text, question),
        score,
        kind: "classification_code_segment",
      });
    }
  }
  return best;
}

const MKB_CLASS_EXCLUSION_GENERIC_TOKENS = new Set(
  [
    "\u0437\u043b\u043e\u043a\u0430\u0447\u0435\u0441\u0442\u0432\u0435\u043d\u043d\u044b\u0435",
    "\u0437\u043b\u043e\u043a\u0430\u0447\u0435\u0441\u0442\u0432\u0435\u043d\u043d\u0430\u044f",
    "\u043d\u043e\u0432\u043e\u043e\u0431\u0440\u0430\u0437\u043e\u0432\u0430\u043d\u0438\u044f",
    "\u043d\u043e\u0432\u043e\u043e\u0431\u0440\u0430\u0437\u043e\u0432\u0430\u043d\u0438\u0435",
    "\u043a\u043e\u0436\u0438",
    "\u043a\u043e\u0436\u0430",
    "\u0434\u0440\u0443\u0433\u0438\u0435",
    "\u043a\u043b\u0430\u0441\u0441",
    "\u043c\u043a\u0431",
  ].flatMap((item) => uniqueTokens(item)),
);

function mkbClassExclusionQuestion(mode, question) {
  if (mode !== "multi") return false;
  const normalized = normalizeForSearch(question);
  const hasMkb = containsNormalizedPhrase(normalized, "\u043c\u043a\u0431");
  const hasClass = containsNormalizedPhrase(normalized, "\u043a\u043b\u0430\u0441\u0441");
  const asksExcluded =
    containsNormalizedPhrase(normalized, "\u043d\u0435 \u0432\u043a\u043b\u044e\u0447") ||
    containsNormalizedPhrase(normalized, "\u0438\u0441\u043a\u043b\u044e\u0447") ||
    containsNormalizedPhrase(normalized, "\u043d\u0435 \u043e\u0442\u043d\u043e\u0441");
  return hasMkb && hasClass && asksExcluded && Boolean(questionMkbClassCode(question));
}

function questionMkbClassCode(question) {
  return canonicalClassificationCodes(question).find((code) => !code.includes(".")) ?? null;
}

function sameMkbClass(code, classCode) {
  return code === classCode || code.startsWith(`${classCode}.`);
}

function lineHasMkbClass(line, classCode) {
  return canonicalClassificationCodes(line).some((code) => sameMkbClass(code, classCode));
}

function mkbClassSectionLines(pages, topQuestionPages, classCode) {
  let startPageIndex = -1;
  let startLineIndex = -1;
  const candidates = topQuestionPages?.size ? pages.filter((page) => topQuestionPages.has(page.page) || topQuestionPages.has(page.page - 1) || topQuestionPages.has(page.page + 1)) : pages;

  for (const page of candidates) {
    const lines = page.lines ?? [];
    for (let index = 0; index < lines.length; index += 1) {
      if (!lineHasMkbClass(lines[index], classCode)) continue;
      startPageIndex = pages.findIndex((candidate) => candidate.page === page.page);
      startLineIndex = index;
      break;
    }
    if (startPageIndex >= 0) break;
  }
  if (startPageIndex < 0) return [];

  const out = [];
  for (let pageIndex = startPageIndex; pageIndex < Math.min(pages.length, startPageIndex + 3); pageIndex += 1) {
    const lines = pages[pageIndex].lines ?? [];
    const from = pageIndex === startPageIndex ? startLineIndex : 0;
    for (let index = from; index < lines.length; index += 1) {
      const line = lines[index];
      if (out.length && /^\s*\d+(?:\.\d+)+\s+/u.test(normalizeText(line)) && !lineHasMkbClass(line, classCode)) return out;
      out.push(line);
      if (out.length >= 90) return out;
    }
  }
  return out;
}

function mkbClassIncludedRows(sectionLines, classCode) {
  const rows = [];
  for (let index = 0; index < sectionLines.length; index += 1) {
    const line = sectionLines[index];
    const codes = canonicalClassificationCodes(line);
    if (!codes.some((code) => code.startsWith(`${classCode}.`))) continue;
    const row = [line];
    for (let next = index + 1; next < Math.min(sectionLines.length, index + 4); next += 1) {
      const nextLine = sectionLines[next];
      const nextCodes = canonicalClassificationCodes(nextLine);
      if (nextCodes.some((code) => sameMkbClass(code, classCode))) break;
      if (containsNormalizedPhrase(normalizeForSearch(nextLine), "\u0438\u0441\u043a\u043b\u044e\u0447")) break;
      row.push(nextLine);
      if (/[.;:]$/u.test(normalizeText(nextLine))) break;
    }
    rows.push(row.join(" ").replace(/\s+/g, " ").trim());
  }
  return rows;
}

function mkbClassAnswerTokens(answerText) {
  return uniqueTokens(answerText).filter((token) => token.length >= 4 && !MKB_CLASS_EXCLUSION_GENERIC_TOKENS.has(token) && !FOCUS_STOPWORDS.has(token));
}

function mkbClassIncludedRowHit(row, answerText) {
  const tokens = mkbClassAnswerTokens(answerText);
  if (!tokens.length) return false;
  const rowTokens = tokenize(row);
  const strict = strictSoftCoverage(tokens, rowTokens);
  const soft = softCoverage(tokens, rowTokens);
  const raw = rawSoftCoverage(tokens, tokenize(row, { keepStopwords: true, stem: false }));
  const threshold = tokens.length <= 1 ? 1 : 0.58;
  return Math.max(strict, soft, raw) >= threshold;
}

function bestMkbClassExclusionSupport({ pages, topQuestionPages, mode, question, answer }) {
  if (!mkbClassExclusionQuestion(mode, question)) return { support: null, adjustment: 0, evidence: null };
  const classCode = questionMkbClassCode(question);
  if (!classCode) return { support: null, adjustment: 0, evidence: null };
  const sectionLines = mkbClassSectionLines(pages, topQuestionPages, classCode);
  if (sectionLines.length < 3) return { support: null, adjustment: 0, evidence: null };
  const includedRows = mkbClassIncludedRows(sectionLines, classCode);
  if (includedRows.length < 2) return { support: null, adjustment: 0, evidence: null };
  const includedRow = includedRows.find((row) => mkbClassIncludedRowHit(row, answer.text));
  if (includedRow) {
    return {
      support: null,
      adjustment: -9.4,
      evidence: {
        answerId: answer.id,
        page: topQuestionPages?.values().next().value ?? 0,
        text: includedRow,
        score: 17.2,
        kind: "mkb_class_included_mismatch",
      },
    };
  }
  const sectionText = sectionLines.join(" ").replace(/\s+/g, " ").trim();
  return {
    support: {
      answerId: answer.id,
      page: topQuestionPages?.values().next().value ?? 0,
      text: sectionText.slice(0, 900),
      score: 15.8,
      kind: "mkb_class_exclusion_absent",
    },
    adjustment: 0,
    evidence: null,
  };
}

function canonicalShortLabel(value) {
  const compact = String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[.\s_\-–—]+/g, "")
    .replace(/[тТ]/g, "t")
    .replace(/[мМ]/g, "m")
    .replace(/[хХ]/g, "x")
    .replace(/[оОoO]/g, "0")
    .replace(/[аА]/g, "a")
    .replace(/[вВ]/g, "b");
  return compact.replace(/[^a-z0-9]/g, "");
}

function questionShortLabels(question) {
  const text = String(question ?? "").normalize("NFKC");
  const labels = new Set<string>();
  const patterns = [
    /(?<![\p{L}\p{N}])[TТ]\s*(?:is|[0-4xхoо])\s*[abаАвВ]?(?![\p{L}\p{N}])/giu,
    /(?<![\p{L}\p{N}])[NН]\s*(?:[0-3xхoо])\s*[abаАвВ]?(?![\p{L}\p{N}])/giu,
    /(?<![\p{L}\p{N}])[MМ]\s*(?:[0-1xхoо])\s*[abаАвВ]?(?![\p{L}\p{N}])/giu,
    /(?<![\p{L}\p{N}])(?:I|II|III|IV|V|VI|VII|VIII|IX|X)\s*[abаАвВ]?(?![\p{L}\p{N}])/giu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const label = canonicalShortLabel(match[0]);
      if (label.length >= 2 && label.length <= 5) labels.add(label);
    }
  }
  return [...labels];
}

function lineShortLabels(text) {
  const raw = String(text ?? "").normalize("NFKC");
  const labels = new Set<string>(questionShortLabels(raw));
  const compact = canonicalShortLabel(raw);
  if (/^[tnm](?:is|[0-4x])(?:[ab])?$/.test(compact)) labels.add(compact);
  if (/^(?:i|ii|iii|iv|v|vi|vii|viii|ix|x)(?:[ab])?$/.test(compact)) labels.add(compact);
  return [...labels];
}

function visualRowText(lines, index) {
  const start = Math.max(0, index - 2);
  const end = Math.min(lines.length, index + 4);
  return lines
    .slice(start, end)
    .map((line) => line.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

const VISUAL_TABLE_COLUMN_GENERIC_FOCUS = new Set(
  uniqueTokens(
    [
      "признаки критерии относятся следующие показатель показатели таблица согласно классификация",
      "значение значения характерны является являются включает включают",
    ].join(" "),
  ),
);

const VISUAL_TABLE_METRIC_STOP = new Set(uniqueTokens("мм мг мл г л ч мин сутки день дней раз более менее выше ниже или норма"));
const VISUAL_TABLE_COLUMN_CUE_TOKENS = new Set(
  uniqueTokens("легкая легкой средняя средней среднетяжелая среднетяжелой тяжелая тяжелой степень степени стадия стадии класс класса категория категории группа тип форма"),
);

function hasVisualTableColumnCue(question, focusTokens) {
  const tokens = [...new Set([...(focusTokens ?? []), ...uniqueTokens(question)])];
  return tokens.some((token) => VISUAL_TABLE_COLUMN_CUE_TOKENS.has(token));
}

function visualTableColumnFocusTokens(focusTokens, question) {
  const out = [];
  for (const token of [...(focusTokens ?? []), ...uniqueTokens(question)]) {
    if (!token || token.length < 4) continue;
    if (FOCUS_STOPWORDS.has(token) || VISUAL_TABLE_COLUMN_GENERIC_FOCUS.has(token)) continue;
    if (!out.includes(token)) out.push(token);
  }
  return out.slice(0, 10);
}

function lineXSpread(line) {
  const xs = (line?.items ?? []).map((item) => item.x ?? 0);
  if (xs.length < 2) return 0;
  return Math.max(...xs) - Math.min(...xs);
}

function visualTableColumnTargets(page, question, focusTokens) {
  const focus = visualTableColumnFocusTokens(focusTokens, question);
  if (!focus.length) return [];
  const targets = [];
  const lines = page?.lineItems ?? [];
  for (const line of lines) {
    if ((line.items?.length ?? 0) < 3 || lineXSpread(line) < 140) continue;
    if (String(line.text ?? "").length > 220) continue;
    const lineNorm = normalizeForSearch(line.text);
    if (containsNormalizedPhrase(lineNorm, "рекоменду") || /pekom/iu.test(lineNorm)) continue;
    for (const item of line.items ?? []) {
      if (String(item.text ?? "").length > 90) continue;
      const itemTokens = uniqueTokens(item.text);
      const hits = tokenHitCount(focus, itemTokens);
      const required = focus.length >= 2 ? 2 : 1;
      if (hits < required) continue;
      targets.push({
        x: item.x ?? 0,
        text: line.text,
        page: page.page,
      });
    }
  }
  return targets;
}

function visualTableTargetsNearPage(pages, page, question, focusTokens) {
  const out = [];
  for (const candidate of pages) {
    if (candidate.page !== page.page && candidate.page !== page.page - 1) continue;
    out.push(...visualTableColumnTargets(candidate, question, focusTokens));
  }
  return out;
}

function buildVisualTableColumnTargetsByPage(pages, question, focusTokens, topQuestionPages) {
  const byPage = new Map();
  for (const page of pages) {
    const nearTopPage =
      !topQuestionPages?.size || topQuestionPages.has(page.page) || topQuestionPages.has(page.page - 1) || topQuestionPages.has(page.page + 1);
    if (!nearTopPage) continue;
    const targets = visualTableTargetsNearPage(pages, page, question, focusTokens);
    if (targets.length) byPage.set(page.page, targets);
  }
  return byPage;
}

function answerMetricTokens(answerText) {
  return uniqueTokens(answerText).filter((token) => {
    if (!token || token.length < 3) return false;
    if (/^\d/u.test(token)) return false;
    if (VISUAL_TABLE_METRIC_STOP.has(token) || FOCUS_STOPWORDS.has(token)) return false;
    return true;
  });
}

function comparatorSigns(text) {
  const signs = new Set<string>();
  const raw = String(text ?? "");
  if (/[<≤]/u.test(raw)) signs.add("<");
  if (/[>≥]/u.test(raw)) signs.add(">");
  return signs;
}

function visualValueMatchesAnswer(itemText, answerText) {
  const numericCoverage = numberCoverage(answerText, normalizeForSearch(itemText));
  if (numericCoverage <= 0) return false;
  const expandedAnswerNumbers = [...new Set(extractNumbers(answerText).flatMap(expandNumberToken))];
  if (expandedAnswerNumbers.length > 1 && numericCoverage < 0.99) return false;
  const answerSigns = comparatorSigns(answerText);
  if (!answerSigns.size) return true;
  const itemSigns = comparatorSigns(itemText);
  return [...answerSigns].some((sign) => itemSigns.has(sign));
}

function targetCellText(line, targetX) {
  return (line.items ?? [])
    .filter((item) => Math.abs((item.x ?? 0) - targetX) <= 52)
    .map((item) => item.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function nearbyMetricText(lines, index, targetX) {
  const baseY = lines[index]?.y ?? 0;
  const parts = [];
  for (let offset = -2; offset <= 2; offset += 1) {
    const line = lines[index + offset];
    if (!line) continue;
    if (Math.abs((line.y ?? baseY) - baseY) > 28) continue;
    for (const item of line.items ?? []) {
      if ((item.x ?? 0) < targetX - 45) parts.push(item.text);
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function bestVisualTableColumnSupport({ mode, pages, topQuestionPages, question, answer, focusTokens, visualTableColumnTargetsByPage }) {
  if (mode !== "multi" || !extractNumbers(answer.text).length) return null;
  if (!visualTableColumnTargetsByPage) return null;
  const metricTokens = answerMetricTokens(answer.text);
  if (!metricTokens.length) return null;
  let best = null;

  for (const page of pages) {
    const nearTopPage =
      !topQuestionPages?.size || topQuestionPages.has(page.page) || topQuestionPages.has(page.page - 1) || topQuestionPages.has(page.page + 1);
    if (!nearTopPage) continue;
    const targets = visualTableColumnTargetsByPage.get(page.page) ?? [];
    if (!targets.length) continue;
    const lines = page.lineItems ?? [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const target of targets) {
        for (const item of line.items ?? []) {
          const xDistance = Math.abs((item.x ?? 0) - target.x);
          if (xDistance > 48) continue;
          const cellText = targetCellText(line, target.x) || item.text;
          if (!visualValueMatchesAnswer(cellText, answer.text)) continue;
          const metricText = nearbyMetricText(lines, index, target.x);
          const metricDocTokens = uniqueTokens(metricText);
          const metricHits = tokenHitCount(metricTokens, metricDocTokens);
          const metricCoverage = coverage(metricTokens, metricDocTokens);
          if (metricHits < 1 && metricCoverage < 0.34) continue;
          const score =
            15.2 +
            proximityBonus(xDistance, 48) * 3.0 +
            Math.min(3, metricHits) * 1.8 +
            Math.min(0.8, metricCoverage) * 4.2 +
            numberCoverage(answer.text, normalizeForSearch(cellText)) * 2.2;
          best = betterEvidence(best, {
            answerId: answer.id,
            page: page.page,
            text: `${target.text} ${metricText} ${cellText}`.replace(/\s+/g, " ").trim(),
            score,
            kind: "visual_table_column",
          });
        }
      }
    }
  }

  return best;
}

function lineStartX(line) {
  return line?.items?.[0]?.x ?? 0;
}

function linePrefixShortLabels(line) {
  const prefix = (line?.items ?? [])
    .slice(0, 3)
    .map((item) => item.text)
    .join(" ");
  return lineShortLabels(prefix || String(line?.text ?? "").slice(0, 24));
}

function lineStartsWithShortLabelStem(line) {
  const first = canonicalShortLabel(line?.items?.[0]?.text ?? "");
  return /^[tnm]$/.test(first) || /^(?:i|ii|iii|iv|v|vi|vii|viii|ix|x)$/.test(first);
}

function splitShortLabelSuffix(line) {
  const compact = canonicalShortLabel(line?.items?.[0]?.text ?? line?.text ?? "");
  if (/^(?:is|[0-4x]|[0-4][ab]?)$/.test(compact)) return compact;
  if (/^(?:i|ii|iii|iv|v|vi|vii|viii|ix|x)[ab]?$/.test(compact)) return compact;
  return null;
}

function lineExactShortLabels(lines, index) {
  const labels = new Set(linePrefixShortLabels(lines[index]));
  if (lineStartsWithShortLabelStem(lines[index]) && index + 1 < lines.length) {
    const suffix = splitShortLabelSuffix(lines[index + 1]);
    if (suffix && Math.abs(lineStartX(lines[index + 1]) - lineStartX(lines[index])) <= 18) {
      const stem = lines[index]?.items?.[0]?.text ?? "";
      for (const label of lineShortLabels(`${stem} ${suffix}`)) labels.add(label);
    }
  }
  return [...labels];
}

function visualExactLabelRowText(lines, index) {
  const row = [];
  const first = lines[index];
  if (!first?.text) return "";
  const startX = lineStartX(first);
  let previousY = first.y ?? 0;

  for (let current = index; current < lines.length && row.length < 8; current += 1) {
    const line = lines[current];
    const text = String(line?.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;

    if (current > index) {
      const gap = Math.abs((line?.y ?? previousY) - previousY);
      if (gap > 32) break;
      const startsNewLabel =
        (linePrefixShortLabels(line).length > 0 || lineStartsWithShortLabelStem(line)) && Math.abs(lineStartX(line) - startX) <= 18;
      if (startsNewLabel) break;
      if (lineStartX(line) < startX + 18 && row.length > 1) break;
    }

    previousY = line?.y ?? previousY;
    if (/^\d{1,2}$/.test(text) && lineStartX(line) > startX + 120) continue;
    row.push(text);
  }

  return row.join(" ").replace(/\s+/g, " ").trim();
}

function bestExactShortLabelRowSupport({ pages, topQuestionPages, question, answer, answerTokens, focusTokens }) {
  const labels = questionShortLabels(question);
  if (!labels.length || !answerTokens.length) return null;
  const answerPhrases = answerSearchPhrases(answer.text);
  const usefulFocusTokens = (focusTokens?.length ? focusTokens : uniqueTokens(question)).filter((token) => token.length > 2);
  const numericAnswer = extractNumbers(answer.text).length > 0;
  const minSupport = numericAnswer ? 0.48 : answerTokens.length <= 2 ? 0.84 : 0.4;
  let best = null;

  for (const page of pages) {
    const nearTopPage =
      !topQuestionPages?.size || topQuestionPages.has(page.page) || topQuestionPages.has(page.page - 1) || topQuestionPages.has(page.page + 1);
    if (!nearTopPage) continue;
    const lines = page.lineItems ?? [];
    for (let index = 0; index < lines.length; index += 1) {
      const localLabels = lineExactShortLabels(lines, index);
      if (!labels.some((label) => localLabels.includes(label))) continue;

      const text = visualExactLabelRowText(lines, index);
      const normalized = normalizeForSearch(text);
      const tokens = tokenizeNormalized(normalized);
      const answerCoverage = strictSoftCoverage(answerTokens, tokens);
      const numericCoverage = numberCoverage(answer.text, normalized);
      const phraseHit = answerPhrases.some((phrase) => containsNormalizedPhrase(normalized, phrase));
      const answerSupport = Math.max(answerCoverage, numericCoverage, phraseHit ? 1 : 0);
      if (answerSupport < minSupport) continue;

      const focusCoverage = usefulFocusTokens.length ? coverage(usefulFocusTokens, tokens) : 0;
      const score =
        15.8 +
        answerSupport * 8.6 +
        Math.min(0.42, focusCoverage) * 3.1 +
        numericCoverage * 1.6 +
        (phraseHit ? 1.8 : 0);
      best = betterEvidence(best, {
        answerId: answer.id,
        page: page.page,
        text,
        score,
        kind: "short_label_exact_row",
      });
    }
  }

  return best;
}

function bestShortLabelRowSupport({ pages, topQuestionPages, question, answer, answerTokens, focusTokens }) {
  const labels = questionShortLabels(question);
  if (!labels.length || !answerTokens.length) return null;
  const answerPhrases = answerSearchPhrases(answer.text);
  const usefulFocusTokens = (focusTokens?.length ? focusTokens : uniqueTokens(question)).filter((token) => token.length > 2);
  const numericAnswer = extractNumbers(answer.text).length > 0;
  const minSupport = numericAnswer ? 0.55 : answerTokens.length <= 2 ? 0.86 : 0.34;
  let best = null;

  for (const page of pages) {
    const nearTopPage =
      !topQuestionPages?.size || topQuestionPages.has(page.page) || topQuestionPages.has(page.page - 1) || topQuestionPages.has(page.page + 1);
    if (!nearTopPage) continue;
    const lines = page.lineItems ?? [];
    for (let index = 0; index < lines.length; index += 1) {
      const localLabels = new Set<string>(lineShortLabels(lines[index]?.text));
      if (index + 1 < lines.length) {
        for (const label of lineShortLabels(`${lines[index].text} ${lines[index + 1].text}`)) localLabels.add(label);
      }
      if (!labels.some((label) => localLabels.has(label))) continue;

      const text = visualRowText(lines, index);
      const normalized = normalizeForSearch(text);
      const tokens = tokenizeNormalized(normalized);
      const answerCoverage = strictSoftCoverage(answerTokens, tokens);
      const numericCoverage = numberCoverage(answer.text, normalized);
      const phraseHit = answerPhrases.some((phrase) => containsNormalizedPhrase(normalized, phrase));
      const answerSupport = Math.max(answerCoverage, numericCoverage, phraseHit ? 1 : 0);
      if (answerSupport < minSupport) continue;

      const focusCoverage = usefulFocusTokens.length ? coverage(usefulFocusTokens, tokens) : 0;
      const score =
        10.4 +
        answerSupport * 7.2 +
        Math.min(0.35, focusCoverage) * 3.0 +
        numericCoverage * 1.2 +
        (phraseHit ? 1.2 : 0);
      best = betterEvidence(best, {
        answerId: answer.id,
        page: page.page,
        text,
        score,
        kind: "short_label_visual_row",
      });
    }
  }

  return best;
}

function questionPrefixes(question) {
  const tokens = phraseTokens(question);
  const prefixes = new Set<string>();
  for (const length of [14, 11, 8, 6]) {
    if (tokens.length >= length) prefixes.add(tokens.slice(0, length).join(" "));
  }
  if (tokens.length > 12) {
    prefixes.add(tokens.slice(Math.max(0, tokens.length - 10)).join(" "));
  }
  return [...prefixes].filter((prefix) => prefix.length >= 18);
}

function bestPrefixSupport({ pages, question, answer, answerTokens, intent }) {
  const prefixes = questionPrefixes(question);
  if (!prefixes.length) return null;
  const answerPhrases = answerSearchPhrases(answer.text);
  let best = null;
  for (const page of pages) {
    for (const prefix of prefixes) {
      const normalizedPrefix = normalizeForSearch(prefix);
      let start = 0;
      while (start < page.normalized.length) {
        const index = page.normalized.indexOf(normalizedPrefix, start);
        if (index < 0) break;
        const afterStart = index + normalizedPrefix.length;
        const after = page.normalized.slice(afterStart, afterStart + 850);
        for (const phrase of answerPhrases) {
          const normalizedPhrase = normalizeForSearch(phrase);
          if (!normalizedPhrase) continue;
          const answerIndex = after.indexOf(normalizedPhrase);
          if (answerIndex < 0) continue;
          const local = after.slice(Math.max(0, answerIndex - 120), answerIndex + normalizedPhrase.length + 180);
          const score =
            5.8 +
            proximityBonus(answerIndex, 850) * 3.0 +
            coverage(answerTokens, tokenize(local)) * 1.2 +
            numberCoverage(answer.text, local) * 0.6 +
            (intent.numeric ? 0.25 : 0);
          best = betterEvidence(best, {
            answerId: answer.id,
            page: page.page,
            text: evidenceSnippet(page.text, question, answer.text),
            score,
            kind: "question_prefix_continuation",
          });
        }
        start = index + normalizedPrefix.length;
      }
    }
  }
  return best;
}

function bestChunkSupport({ index, chunks, question, answer, questionTokens, answerTokens }) {
  const qaTokens = tokenize(`${question} ${answer.text}`);
  const answerOnlyTokens = tokenize(answer.text);
  const qResults = index.search(questionTokens, { limit: DEFAULT_CONFIG.topQuestionChunks });
  const qaResults = index.search(qaTokens, { limit: 8 });
  const aResults = index.search(answerOnlyTokens, { limit: 8 });

  const topQScore = qResults[0]?.score || 0;
  const topQaScore = qaResults[0]?.score || 0;
  const topAScore = aResults[0]?.score || 0;
  let best = null;

  for (const result of qaResults) {
    const chunk = result.chunk;
    const answerCoverage = coverage(answerTokens, chunk.tokens);
    const questionCoverage = coverage(questionTokens, chunk.tokens);
    const exact = containsNormalizedPhrase(chunk.normalized, answer.text) ? 1 : 0;
    const score =
      normalizeBm25(result.score, topQaScore) * 2.4 +
      questionCoverage * 1.7 +
      answerCoverage * 1.4 +
      exact * 2.4 +
      numberCoverage(answer.text, chunk.normalized) * 0.9 +
      tokenProximity(questionTokens, answerTokens, chunk.tokens) * 1.1;
    best = betterEvidence(best, evidenceFromChunk(answer.id, chunk, score, "bm25_question_answer"));
  }

  for (const result of qResults) {
    const chunk = result.chunk;
    const answerCoverage = coverage(answerTokens, chunk.tokens);
    if (answerCoverage <= 0 && !containsNormalizedPhrase(chunk.normalized, answer.text)) continue;
    const exact = containsNormalizedPhrase(chunk.normalized, answer.text) ? 1 : 0;
    const lineBoost =
      chunk.kind === "line" || chunk.kind === "line_pair" || chunk.kind === "layout_line" || chunk.kind === "layout_line_pair"
        ? 0.55
        : chunk.kind === "list"
          ? 0.35
          : chunk.kind === "heading"
            ? 0.2
            : 0;
    const score =
      normalizeBm25(result.score, topQScore) * 1.6 +
      answerCoverage * 3.2 +
      exact * 3.4 +
      lineBoost +
      jaccard(answerTokens, chunk.tokens) * 0.8 +
      numberCoverage(answer.text, chunk.normalized) * 1.2 +
      tokenProximity(questionTokens, answerTokens, chunk.tokens) * 1.4;
    best = betterEvidence(best, evidenceFromChunk(answer.id, chunk, score, "question_chunk_answer"));
  }

  for (const result of aResults) {
    const chunk = result.chunk;
    const questionCoverage = coverage(questionTokens, chunk.tokens);
    if (questionCoverage <= 0.06) continue;
    const score =
      normalizeBm25(result.score, topAScore) * 0.8 +
      questionCoverage * 2.2 +
      numberCoverage(answer.text, chunk.normalized) * 0.7 +
      tokenProximity(questionTokens, answerTokens, chunk.tokens) * 0.8;
    best = betterEvidence(best, evidenceFromChunk(answer.id, chunk, score, "answer_chunk_question"));
  }

  if (!best && chunks.length) {
    const fallback = qResults[0]?.chunk ?? chunks[0];
    best = evidenceFromChunk(answer.id, fallback, 0, "fallback");
  }

  return best;
}

function normalizeBm25(score, topScore) {
  if (!score || !topScore) return 0;
  return Math.min(1, score / topScore);
}

function numberSpecificity(answer) {
  const count = extractNumbers(answer).length;
  return Math.min(1, count / 3);
}

function lineTokenApplicable({ mode, question, answer, intent }) {
  if (mode !== "single") return false;
  if (intent.numeric || extractNumbers(answer.text).length) return false;
  const raw = normalizeText(question);
  return (
    /является\s+заболеванием/u.test(raw) ||
    /переда[а-яa-z0-9-]*\s+пут/u.test(raw) ||
    /рекоменду[а-яa-z0-9-]*\s+(?:применение|назначение|применять|назначать)/u.test(raw) ||
    /конкурентно\s+ингибирует/u.test(raw) ||
    /фермент/u.test(raw)
  );
}

function questionRiskCondition(question) {
  const raw = normalizeText(question);
  if (/(?:не\s+имеющ|без|отсутств)[а-яa-z0-9-\s]{0,80}фактор[а-яa-z0-9-\s]{0,40}риска/u.test(raw)) return "risk_absent";
  if (/(?:имеющ|налич)[а-яa-z0-9-\s]{0,80}фактор[а-яa-z0-9-\s]{0,40}риска/u.test(raw)) return "risk_present";
  return null;
}

function windowRiskCondition(normalizedWindow) {
  if (containsNormalizedPhrase(normalizedWindow, "не имеющих факторов риска") || containsNormalizedPhrase(normalizedWindow, "без факторов риска")) {
    return "risk_absent";
  }
  if (containsNormalizedPhrase(normalizedWindow, "при наличии") && containsNormalizedPhrase(normalizedWindow, "фактор")) {
    return "risk_present";
  }
  if (containsNormalizedPhrase(normalizedWindow, "имеющих") && containsNormalizedPhrase(normalizedWindow, "факторов риска")) {
    return "risk_present";
  }
  return null;
}

function primaryNumberPhrase(answerText) {
  const first = extractNumbers(answerText)[0];
  if (!first) return null;
  return String(first).replace(",", ".");
}

function riskConditionAdjustment({ pages, topQuestionPages, question, answer }) {
  const target = questionRiskCondition(question);
  const value = primaryNumberPhrase(answer.text);
  if (!target || !value) return { adjustment: 0, evidence: null };
  let bestMatch = null;
  let bestMismatch = null;

  for (const page of pages) {
    if (topQuestionPages?.size && !topQuestionPages.has(page.page)) continue;
    const hits = findPhraseOccurrences(page.normalized, value, { textIsNormalized: true });
    for (const hit of hits) {
      const beforeNumber = page.normalized.slice(Math.max(0, hit - 50), hit);
      if (!containsNormalizedPhrase(beforeNumber, "уровн")) continue;
      const levelIndex = beforeNumber.lastIndexOf(normalizeForSearch("уровн"));
      if (levelIndex >= 0 && extractNumbers(beforeNumber.slice(levelIndex)).length) continue;
      const window = page.normalized.slice(Math.max(0, hit - 70), hit + value.length + 240);
      if (!containsNormalizedPhrase(window, "фактор") || !containsNormalizedPhrase(window, "риск")) continue;
      const after = page.normalized.slice(hit, hit + value.length + 240);
      const actual = windowRiskCondition(after) ?? windowRiskCondition(window);
      if (!actual) continue;
      const evidence = {
        answerId: answer.id,
        page: page.page,
        text: evidenceSnippet(page.text, value, question),
        score: actual === target ? 8.4 : 2.2,
        kind: actual === target ? "risk_condition_match" : "risk_condition_mismatch",
      };
      if (actual === target) bestMatch = betterEvidence(bestMatch, evidence);
      else bestMismatch = betterEvidence(bestMismatch, evidence);
    }
  }

  if (bestMatch) return { adjustment: 4.2, evidence: bestMatch };
  if (bestMismatch) return { adjustment: -2.1, evidence: bestMismatch };
  return { adjustment: 0, evidence: null };
}

function genericPopulationAnswer(answerText) {
  const raw = normalizeText(answerText);
  return /^(?:всем|все)\s+(?:пациент|больн|пострадав)/u.test(raw);
}

function genericPopulationConditionAdjustment({ mode, pages, topQuestionPages, question, answer, focusTokens }) {
  if (mode !== "single" || !genericPopulationAnswer(answer.text)) return { adjustment: 0, evidence: null };
  if (/^(?:всем|все)\s+(?:пациент|больн|пострадав)/u.test(normalizeText(question))) return { adjustment: 0, evidence: null };
  const answerPhrases = answerSearchPhrases(answer.text).slice(0, 8);
  let best = null;

  for (const page of pages) {
    if (topQuestionPages?.size && !topQuestionPages.has(page.page)) continue;
    for (const phrase of answerPhrases) {
      const phraseNorm = normalizeForSearch(phrase);
      if (!phraseNorm || phraseNorm.length < 5) continue;
      const hits = findPhraseOccurrences(page.normalized, phrase, { textIsNormalized: true });
      for (const hit of hits) {
        const after = page.normalized.slice(hit + phraseNorm.length, hit + phraseNorm.length + 520);
        const hasCondition =
          containsNormalizedPhrase(after, "при") ||
          containsNormalizedPhrase(after, "с целью") ||
          containsNormalizedPhrase(after, "при наличии") ||
          containsNormalizedPhrase(after, "при развитии");
        if (!hasCondition) continue;
        const focusCoverage = coverage(focusTokens, tokenizeNormalized(after));
        if (focusCoverage < 0.12) continue;
        best = betterEvidence(best, {
          answerId: answer.id,
          page: page.page,
          text: evidenceSnippet(page.text, answer.text, question),
          score: 3.0 + focusCoverage * 4.0,
          kind: "generic_population_condition_penalty",
        });
      }
    }
  }

  return best ? { adjustment: -10.4, evidence: best } : { adjustment: 0, evidence: null };
}

function genericPopulationConditionAdjustmentForMode(context) {
  const { mode, pages, topQuestionPages, question, answer, answers, focusTokens } = context;
  if (mode !== "multi") return genericPopulationConditionAdjustment(context);
  if (!genericPopulationAnswer(answer.text)) return { adjustment: 0, evidence: null };
  if (genericPopulationAnswer(question)) return { adjustment: 0, evidence: null };
  if (!containsNormalizedPhrase(normalizeForSearch(question), "\u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434")) return { adjustment: 0, evidence: null };
  if (!hasSpecificPopulationAlternative(answers, answer)) return { adjustment: 0, evidence: null };
  const answerPhrases = answerSearchPhrases(answer.text).slice(0, 8);
  let best = null;

  for (const page of pages) {
    if (topQuestionPages?.size && !topQuestionPages.has(page.page)) continue;
    for (const phrase of answerPhrases) {
      const phraseNorm = normalizeForSearch(phrase);
      if (!phraseNorm || phraseNorm.length < 5) continue;
      const hits = findPhraseOccurrences(page.normalized, phrase, { textIsNormalized: true });
      for (const hit of hits) {
        const after = page.normalized.slice(hit + phraseNorm.length, hit + phraseNorm.length + 520);
        const hasCondition =
          containsNormalizedPhrase(after, "\u043f\u0440\u0438") ||
          containsNormalizedPhrase(after, "\u0441 \u0446\u0435\u043b\u044c\u044e") ||
          containsNormalizedPhrase(after, "\u0434\u043b\u044f") ||
          containsNormalizedPhrase(after, "\u0441\u0442\u0435\u043f\u0435\u043d") ||
          containsNormalizedPhrase(after, "\u0442\u044f\u0436\u0435\u043b");
        if (!hasCondition) continue;
        const focusCoverage = coverage(focusTokens, tokenizeNormalized(after));
        if (focusCoverage < 0.12) continue;
        best = betterEvidence(best, {
          answerId: answer.id,
          page: page.page,
          text: evidenceSnippet(page.text, answer.text, question),
          score: 3.0 + focusCoverage * 4.0,
          kind: "generic_population_condition_penalty",
        });
      }
    }
  }

  return best ? { adjustment: -5.2, evidence: best } : { adjustment: 0, evidence: null };
}

function populationStem(answerText) {
  const tokens = uniqueTokens(answerText);
  const stems = ["\u043f\u0430\u0446\u0438\u0435\u043d\u0442", "\u043f\u043e\u0441\u0442\u0440\u0430\u0434", "\u0431\u043e\u043b\u044c\u043d"].map((item) => normalizeForSearch(item));
  return tokens.find((token) => stems.some((stem) => token.startsWith(stem.slice(0, Math.min(8, stem.length))))) ?? null;
}

function hasSpecificPopulationAlternative(answers, genericAnswer) {
  const stem = populationStem(genericAnswer.text);
  if (!stem) return false;
  return (answers ?? []).some((candidate) => {
    if (candidate.id === genericAnswer.id) return false;
    const normalized = normalizeForSearch(candidate.text);
    const candidateTokens = uniqueTokens(candidate.text);
    if (!candidateTokens.some((token) => token.startsWith(stem.slice(0, Math.min(8, stem.length))))) return false;
    return (
      containsNormalizedPhrase(normalized, "\u0441\u0440\u0435\u0434\u043d") ||
      containsNormalizedPhrase(normalized, "\u0442\u044f\u0436\u0435\u043b") ||
      containsNormalizedPhrase(normalized, "\u0441\u0442\u0435\u043f\u0435\u043d") ||
      containsNormalizedPhrase(normalized, "\u043f\u0440\u0438 \u043d\u0430\u043b\u0438\u0447") ||
      containsNormalizedPhrase(normalized, "\u0441 \u043d\u0430\u043b\u0438\u0447")
    );
  });
}

function questionClassSubject(question) {
  const raw = normalizeText(question);
  const match = raw.match(/^(.+?)\s+относят\s+к\s+классу/u);
  if (!match?.[1]) return null;
  const subject = match[1].trim();
  return subject.length >= 4 ? subject : null;
}

function romanClassVariants(answerText) {
  const raw = normalizeText(answerText).replace(/\s+/g, "");
  const variants = new Set();
  const romanMap = new Map([
    ["i", "1"],
    ["ii", "2"],
    ["iii", "3"],
    ["iv", "4"],
    ["v", "5"],
  ]);
  if (romanMap.has(raw)) {
    variants.add(raw);
    variants.add(romanMap.get(raw));
  }
  const numeric = extractNumbers(answerText)[0];
  if (numeric) {
    variants.add(numeric);
    for (const [roman, value] of romanMap.entries()) if (value === numeric) variants.add(roman);
  }
  return [...variants].map((item) => normalizeForSearch(item)).filter(Boolean);
}

function bestClassSubjectSupport({ pages, question, answer }) {
  const subject = questionClassSubject(question);
  const variants = romanClassVariants(answer.text);
  if (!subject || !variants.length) return null;
  const subjectTokens = uniqueTokens(subject);
  let best = null;

  for (const page of pages) {
    for (const segment of cachedLineTokenSegments(page)) {
      if (!containsNormalizedPhrase(segment.normalized, "класс")) continue;
      const subjectCoverage = coverage(subjectTokens, segment.tokens);
      if (subjectCoverage < 0.65) continue;
      const hasAnswerClass = variants.some((variant) => tokenBoundaryIncludes(segment.normalized, variant));
      if (!hasAnswerClass) continue;
      const score = 10.8 + subjectCoverage * 4.0;
      best = betterEvidence(best, {
        answerId: answer.id,
        page: page.page,
        text: segment.text,
        score,
        kind: "subject_class_line",
      });
    }
  }

  return best;
}

function negativeLocalAnswerAdjustment({ pages, topQuestionPages, question, answer, intent }) {
  const questionRaw = normalizeText(question);
  if (intent.negative || intent.exception || /редк/u.test(questionRaw)) return { adjustment: 0, evidence: null };
  const phrases = answerSearchPhrases(answer.text).slice(0, 12);
  let best = null;

  for (const page of pages) {
    for (const phrase of phrases) {
      const phraseNorm = normalizeForSearch(phrase);
      if (!phraseNorm || phraseNorm.length < 5) continue;
      const hits = findPhraseOccurrences(page.normalized, phrase, { textIsNormalized: true });
      for (const hit of hits) {
        const local = page.normalized.slice(Math.max(0, hit - 80), hit + phraseNorm.length + 120);
        const negativeCue =
          containsNormalizedPhrase(local, "крайне ред") ||
          containsNormalizedPhrase(local, "редк") ||
          containsNormalizedPhrase(local, "не характер") ||
          containsNormalizedPhrase(local, "не рекоменд") ||
          containsNormalizedPhrase(local, "не показ") ||
          containsNormalizedPhrase(local, "исключ");
        if (!negativeCue) continue;
        best = betterEvidence(best, {
          answerId: answer.id,
          page: page.page,
          text: evidenceSnippet(page.text, answer.text, question),
          score: 6.6,
          kind: "negative_local_answer_penalty",
        });
      }
    }
  }

  return best ? { adjustment: -5.2, evidence: best } : { adjustment: 0, evidence: null };
}

function boundedListQuestion({ mode, question, intent }) {
  if (mode !== "multi" || intent.negative || intent.exception) return false;
  const normalized = normalizeForSearch(question);
  return (
    (containsNormalizedPhrase(normalized, "\u043a\u043b\u0438\u043d\u0438\u0447") &&
      containsNormalizedPhrase(normalized, "\u043f\u0440\u043e\u044f\u0432\u043b")) ||
    containsNormalizedPhrase(normalized, "\u0441\u0438\u043c\u043f\u0442\u043e\u043c") ||
    containsNormalizedPhrase(normalized, "\u0441\u043e\u043f\u0440\u043e\u0432\u043e\u0436\u0434") ||
    (containsNormalizedPhrase(normalized, "\u043e\u0441\u043d\u043e\u0432\u043d") && containsNormalizedPhrase(normalized, "\u044d\u0444\u0444\u0435\u043a\u0442")) ||
    containsNormalizedPhrase(normalized, "\u0432 \u043e\u0441\u043d\u043e\u0432\u0435")
  );
}

function boundedListAnchors(question) {
  const tokens = rawTokens(question);
  const anchors = new Set();
  const addTokens = (items) => {
    const cleaned = items.filter(Boolean).join(" ").trim();
    if (cleaned.length >= 3) anchors.add(cleaned);
  };

  const syndromeIndex = tokens.findIndex((token) => token.startsWith("\u0441\u0438\u043d\u0434\u0440\u043e\u043c"));
  if (syndromeIndex >= 0) {
    const stopPrefixes = [
      "\u044f\u0432\u043b\u044f",
      "\u0441\u043e\u043f\u0440\u043e\u0432\u043e\u0436\u0434",
      "\u0445\u0430\u0440\u0430\u043a\u0442\u0435\u0440",
      "\u043e\u0441\u043d\u043e\u0432\u043d",
      "\u043e\u0442\u043d\u043e\u0441",
    ];
    const anchor = [];
    for (let index = syndromeIndex + 1; index < Math.min(tokens.length, syndromeIndex + 6); index += 1) {
      if (stopPrefixes.some((prefix) => tokens[index].startsWith(prefix))) break;
      anchor.push(tokens[index]);
    }
    addTokens(anchor);
  }

  const ageIndex = tokens.findIndex((token) => token === "\u0432\u043e\u0437\u0440\u0430\u0441\u0442\u0435");
  if (ageIndex >= 0) {
    const next = tokens.slice(ageIndex, Math.min(tokens.length, ageIndex + 12));
    const directionIndex = next.findIndex(
      (token) => token.startsWith("\u043c\u043e\u043b\u043e\u0436") || token.startsWith("\u0441\u0442\u0430\u0440\u0448") || token.startsWith("\u043c\u043b\u0430\u0434\u0448"),
    );
    if (next.some((token) => /^\d/.test(token)) && directionIndex >= 0) {
      addTokens(next.slice(0, directionIndex + 1));
    }
  }

  return [...anchors].slice(0, 6);
}

function boundedListBoundary(after) {
  const boundaries = [
    "\u0438 \u0441",
    "\u043e\u0431\u0449\u0438\u0435 \u0441\u0438\u043c\u043f\u0442\u043e\u043c\u044b",
    "\u044d\u0442\u043e \u0440\u0430\u0437\u0434\u0435\u043b\u0435\u043d\u0438\u0435",
    "\u0443\u0440\u043e\u0432\u0435\u043d\u044c \u0443\u0431\u0435\u0434\u0438\u0442\u0435\u043b\u044c\u043d\u043e\u0441\u0442\u0438",
    "\u043a\u043e\u043c\u043c\u0435\u043d\u0442\u0430\u0440\u0438\u0438",
    "\u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434\u0430\u0446\u0438\u0438",
  ].map((item) => normalizeForSearch(item));
  let end = Math.min(after.length, 900);
  for (const boundary of boundaries) {
    const index = after.indexOf(` ${boundary} `, 70);
    if (index > 0) end = Math.min(end, index);
  }
  return Math.max(90, end);
}

function findBoundedListSegments(pages, question, topQuestionPages, mode, intent) {
  if (!boundedListQuestion({ mode, question, intent })) return [];
  const anchors = boundedListAnchors(question);
  if (!anchors.length) return [];
  const segments = [];
  const seen = new Set();
  const triadCue = normalizeForSearch("\u0434\u043e\u043c\u0438\u043d\u0438\u0440\u0443\u0435\u0442 \u0442\u0440\u0438\u0430\u0434\u0430");

  for (const page of pages) {
    for (const source of cachedLineWindowSegments(page)) {
      for (const anchor of anchors) {
        const anchorNorm = normalizeForSearch(anchor);
        const anchorIndex = source.normalized.indexOf(anchorNorm);
        if (anchorIndex < 0) continue;
        let start = anchorIndex;
        const afterAnchor = source.normalized.slice(anchorIndex);
        const triadIndex = afterAnchor.indexOf(triadCue);
        if (triadIndex >= 0 && triadIndex <= 260) {
          start = anchorIndex + triadIndex + triadCue.length;
        }
        const after = source.normalized.slice(start);
        const end = start + boundedListBoundary(after);
        const included = source.normalized.slice(start, end);
        const outside = `${source.normalized.slice(0, start)} ${source.normalized.slice(end)}`.trim();
        const key = `${page.page}:${included.slice(0, 220)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        segments.push({
          page: page.page,
          text: source.text,
          normalized: included,
          outside,
          anchor,
          priority: topQuestionPages?.has(page.page) ? 1 : 0,
        });
      }
    }
  }

  return segments.sort((a, b) => b.priority - a.priority).slice(0, 40);
}

function bestBoundedListSupport({ boundedListSegments, answer, answerTokens }) {
  if (!boundedListSegments?.length) return { support: null, adjustment: 0, evidence: null };
  const answerPhrases = answerSearchPhrases(answer.text).slice(0, 16);
  let bestSupport = null;
  let bestPenalty = null;

  for (const segment of boundedListSegments) {
    const segmentTokens = tokenizeNormalized(segment.normalized);
    const outsideTokens = tokenizeNormalized(segment.outside);
    const answerCoverage = strictSoftCoverage(answerTokens, segmentTokens);
    const outsideCoverage = strictSoftCoverage(answerTokens, outsideTokens);
    const insidePhrase = answerPhrases.some((phrase) => containsNormalizedPhrase(segment.normalized, phrase));
    const outsidePhrase = answerPhrases.some((phrase) => containsNormalizedPhrase(segment.outside, phrase));
    const hasInside = insidePhrase || answerCoverage >= 0.66;
    const hasOutside = outsidePhrase || outsideCoverage >= 0.72;

    if (hasInside) {
      const score = 10.8 + (insidePhrase ? 2.6 : 0) + answerCoverage * 3.2 + numberCoverage(answer.text, segment.normalized) * 0.8;
      bestSupport = betterEvidence(bestSupport, {
        answerId: answer.id,
        page: segment.page,
        text: segment.text,
        score,
        kind: "bounded_list_segment",
      });
    } else if (hasOutside) {
      bestPenalty = betterEvidence(bestPenalty, {
        answerId: answer.id,
        page: segment.page,
        text: segment.text,
        score: 6.0 + outsideCoverage * 2.0,
        kind: "bounded_list_outside_penalty",
      });
    }
  }

  if (bestSupport) return { support: bestSupport, adjustment: 0, evidence: null };
  return bestPenalty ? { support: null, adjustment: -4.8, evidence: bestPenalty } : { support: null, adjustment: 0, evidence: null };
}

function ordinalTarget(question) {
  const normalized = normalizeForSearch(question);
  const hasStage = containsNormalizedPhrase(normalized, "\u044d\u0442\u0430\u043f");
  const hasLine = containsNormalizedPhrase(normalized, "\u043b\u0438\u043d\u0438");
  const hasStep = containsNormalizedPhrase(normalized, "\u0441\u0442\u0443\u043f\u0435\u043d");
  const hasDegree = containsNormalizedPhrase(normalized, "\u0441\u0442\u0435\u043f\u0435\u043d");
  if (!hasStage && !hasLine && !hasStep && !hasDegree) return null;
  if (hasStep) {
    const stepCue = normalizeForSearch("\u0441\u0442\u0443\u043f\u0435\u043d");
    const stepMatch = normalized.match(new RegExp(`(?:^|\\s)(\\d{1,2})(?:\\s*-?\\s*\\S{0,2})?\\s+${escapeRegExp(stepCue)}`, "iu"));
    if (stepMatch) return { number: Number(stepMatch[1]), kind: "step" };
  }
  if (hasDegree) {
    const degreeCue = normalizeForSearch("\u0441\u0442\u0435\u043f\u0435\u043d");
    const degreeMatch = normalized.match(new RegExp(`(?:^|\\s)(\\d{1,2}|[ivx]{1,7})(?:\\s*-?\\s*\\S{0,2})?\\s+${escapeRegExp(degreeCue)}`, "iu"));
    if (degreeMatch) {
      const number = ordinalValueToNumber(degreeMatch[1]);
      if (number) return { number, kind: "degree" };
    }
  }
  const candidates = [
    { number: 1, cues: ["\u043f\u0435\u0440\u0432"] },
    { number: 2, cues: ["\u0432\u0442\u043e\u0440"] },
    { number: 3, cues: ["\u0442\u0440\u0435\u0442", "\u0442\u0440\u0435\u0442\u044c"] },
    { number: 4, cues: ["\u0447\u0435\u0442\u0432\u0435\u0440"] },
  ];
  for (const candidate of candidates) {
    if (candidate.cues.some((cue) => containsNormalizedPhrase(normalized, cue))) {
      return { number: candidate.number, kind: hasDegree ? "degree" : hasStage ? "stage" : "line" };
    }
  }
  return null;
}

function ordinalWordForms(number, kind = "line") {
  const formsByKind = {
    line: {
      1: [
      "\u043f\u0435\u0440\u0432\u043e\u0439 \u043b\u0438\u043d\u0438\u0438",
      "\u043f\u0435\u0440\u0432\u0430\u044f \u043b\u0438\u043d\u0438\u044f",
      "\u043f\u0435\u0440\u0432\u0443\u044e \u043b\u0438\u043d\u0438\u044e",
      ],
      2: [
      "\u0432\u0442\u043e\u0440\u043e\u0439 \u043b\u0438\u043d\u0438\u0438",
      "\u0432\u0442\u043e\u0440\u0430\u044f \u043b\u0438\u043d\u0438\u044f",
      "\u0432\u0442\u043e\u0440\u0443\u044e \u043b\u0438\u043d\u0438\u044e",
      ],
      3: [
    "\u0442\u0440\u0435\u0442\u044c\u0435\u0439 \u043b\u0438\u043d\u0438\u0438",
    "\u0442\u0440\u0435\u0442\u044c\u044f \u043b\u0438\u043d\u0438\u044f",
    "\u0442\u0440\u0435\u0442\u044c\u044e \u043b\u0438\u043d\u0438\u044e",
      ],
      4: [
        "\u0447\u0435\u0442\u0432\u0435\u0440\u0442\u043e\u0439 \u043b\u0438\u043d\u0438\u0438",
        "\u0447\u0435\u0442\u0432\u0435\u0440\u0442\u0430\u044f \u043b\u0438\u043d\u0438\u044f",
        "\u0447\u0435\u0442\u0432\u0435\u0440\u0442\u0443\u044e \u043b\u0438\u043d\u0438\u044e",
      ],
    },
    degree: {
      1: [
        "\u043f\u0435\u0440\u0432\u043e\u0439 \u0441\u0442\u0435\u043f\u0435\u043d\u0438",
        "\u043f\u0435\u0440\u0432\u0430\u044f \u0441\u0442\u0435\u043f\u0435\u043d\u044c",
        "\u043f\u0435\u0440\u0432\u0443\u044e \u0441\u0442\u0435\u043f\u0435\u043d\u044c",
      ],
      2: [
        "\u0432\u0442\u043e\u0440\u043e\u0439 \u0441\u0442\u0435\u043f\u0435\u043d\u0438",
        "\u0432\u0442\u043e\u0440\u0430\u044f \u0441\u0442\u0435\u043f\u0435\u043d\u044c",
        "\u0432\u0442\u043e\u0440\u0443\u044e \u0441\u0442\u0435\u043f\u0435\u043d\u044c",
      ],
      3: [
        "\u0442\u0440\u0435\u0442\u044c\u0435\u0439 \u0441\u0442\u0435\u043f\u0435\u043d\u0438",
        "\u0442\u0440\u0435\u0442\u044c\u044f \u0441\u0442\u0435\u043f\u0435\u043d\u044c",
        "\u0442\u0440\u0435\u0442\u044c\u044e \u0441\u0442\u0435\u043f\u0435\u043d\u044c",
      ],
      4: [
        "\u0447\u0435\u0442\u0432\u0435\u0440\u0442\u043e\u0439 \u0441\u0442\u0435\u043f\u0435\u043d\u0438",
        "\u0447\u0435\u0442\u0432\u0435\u0440\u0442\u0430\u044f \u0441\u0442\u0435\u043f\u0435\u043d\u044c",
        "\u0447\u0435\u0442\u0432\u0435\u0440\u0442\u0443\u044e \u0441\u0442\u0435\u043f\u0435\u043d\u044c",
      ],
    },
  };
  return formsByKind[kind]?.[number] ?? formsByKind.line[number] ?? [];
}

function nextOrdinalIndex(normalized, start, number) {
  let best = -1;
  for (const nextNumber of [number + 1, number + 2]) {
    const pattern = new RegExp(`(?:^|[ .])${nextNumber}(?:[ .]|$)`, "u");
    const match = normalized.slice(start).match(pattern);
    if (match?.index != null) {
      const index = start + match.index;
      if (best < 0 || index < best) best = index;
    }
  }
  return best;
}

function nextStepOrdinalIndex(normalized, start, number) {
  const stepCue = normalizeForSearch("\u0441\u0442\u0443\u043f\u0435\u043d");
  let best = -1;
  for (const nextNumber of [number + 1, number + 2, number + 3]) {
    const pattern = new RegExp(`(?:^|\\s)${nextNumber}(?:\\s*-?\\s*\\S{0,2})?\\s+${escapeRegExp(stepCue)}`, "iu");
    const match = normalized.slice(start).match(pattern);
    if (match?.index != null) {
      const index = start + match.index;
      if (best < 0 || index < best) best = index;
    }
  }
  return best;
}

function ordinalValueToNumber(value) {
  const normalized = normalizeForSearch(value);
  if (/^\d{1,2}$/.test(normalized)) return Number(normalized);
  const roman = new Map([
    ["i", 1],
    ["ii", 2],
    ["iii", 3],
    ["iv", 4],
    ["v", 5],
    ["vi", 6],
    ["vii", 7],
    ["viii", 8],
    ["ix", 9],
    ["x", 10],
  ]);
  return roman.get(normalized) ?? null;
}

function nextDegreeOrdinalIndex(normalized, start, number) {
  const degreeCue = normalizeForSearch("\u0441\u0442\u0435\u043f\u0435\u043d");
  let best = -1;
  for (const nextNumber of [number + 1, number + 2, number + 3]) {
    for (const variant of romanStageVariants(String(nextNumber))) {
      const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(variant)}(?:\\s|-|$)`, "iu");
      const match = normalized.slice(start).match(pattern);
      if (!match?.index && match?.index !== 0) continue;
      const index = start + match.index;
      const before = normalized.slice(Math.max(0, index - 180), index);
      const after = normalized.slice(index, Math.min(normalized.length, index + 80));
      if (!before.includes(degreeCue) && !after.includes(degreeCue)) continue;
      if (best < 0 || index < best) best = index;
    }
  }
  return best;
}

function ordinalWindows(source, target) {
  const normalized = source.normalized;
  const windows = [];
  if (target.kind === "degree") {
    const degreeCue = normalizeForSearch("\u0441\u0442\u0435\u043f\u0435\u043d");
    for (const variant of romanStageVariants(String(target.number))) {
      const directPatterns = [
        new RegExp(`(?:^|\\s)${escapeRegExp(variant)}(?:\\s*-?\\s*\\S{0,3})?\\s+${escapeRegExp(degreeCue)}`, "giu"),
        new RegExp(`${escapeRegExp(degreeCue)}\\s+(?:\\S+\\s+){0,2}${escapeRegExp(variant)}(?:\\s|$)`, "giu"),
      ];
      for (const pattern of directPatterns) {
        for (const match of normalized.matchAll(pattern)) {
          const index = match.index ?? 0;
          const afterStart = index + match[0].length;
          const afterLimit = nextDegreeOrdinalIndex(normalized, afterStart + 8, target.number);
          const end = afterLimit > 0 ? afterLimit : Math.min(normalized.length, afterStart + 520);
          windows.push(normalized.slice(Math.max(0, index - 160), end));
        }
      }

      let start = 0;
      while (start < normalized.length) {
        const index = normalized.indexOf(variant, start);
        if (index < 0) break;
        if (!hasSearchBoundaries(normalized, index, variant.length)) {
          start = index + Math.max(1, variant.length);
          continue;
        }
        const before = normalized.slice(Math.max(0, index - 220), index);
        if (!before.includes(degreeCue)) {
          start = index + Math.max(1, variant.length);
          continue;
        }
        const afterLimit = nextDegreeOrdinalIndex(normalized, index + variant.length + 8, target.number);
        const end = afterLimit > 0 ? afterLimit : Math.min(normalized.length, index + 520);
        windows.push(normalized.slice(Math.max(0, index - 160), end));
        start = index + Math.max(1, variant.length);
      }
    }
    for (const form of ordinalWordForms(target.number, "degree")) {
      const formNorm = normalizeForSearch(form);
      let start = 0;
      while (start < normalized.length) {
        const index = normalized.indexOf(formNorm, start);
        if (index < 0) break;
        windows.push(normalized.slice(Math.max(0, index - 220), Math.min(normalized.length, index + formNorm.length + 480)));
        start = index + formNorm.length;
      }
    }
    return windows;
  }
  if (target.kind === "step") {
    const stepCue = normalizeForSearch("\u0441\u0442\u0443\u043f\u0435\u043d");
    const pattern = new RegExp(`(?:^|\\s)${target.number}(?:\\s*-?\\s*\\S{0,2})?\\s+${escapeRegExp(stepCue)}`, "giu");
    for (const match of normalized.matchAll(pattern)) {
      const index = match.index ?? 0;
      const afterStart = index + match[0].length;
      const afterLimit = nextStepOrdinalIndex(normalized, afterStart + 12, target.number);
      const end = afterLimit > 0 ? afterLimit : Math.min(normalized.length, afterStart + 700);
      windows.push(normalized.slice(index, end));
    }
    return windows;
  }
  if (target.kind === "stage") {
    if (!containsNormalizedPhrase(normalized, "\u044d\u0442\u0430\u043f")) return windows;
    const pattern = new RegExp(`(?:^|[ .])${target.number}(?:[ .]|$)`, "gu");
    for (const match of normalized.matchAll(pattern)) {
      const index = match.index ?? 0;
      const before = normalized.slice(Math.max(0, index - 180), index);
      const afterStart = index + match[0].length;
      const afterLimit = nextOrdinalIndex(normalized, afterStart + 12, target.number);
      const end = afterLimit > 0 ? afterLimit : Math.min(normalized.length, afterStart + 520);
      const local = normalized.slice(index, end);
      if (!containsNormalizedPhrase(`${before} ${local}`, "\u044d\u0442\u0430\u043f")) continue;
      windows.push(local);
    }
    return windows;
  }

  for (const form of ordinalWordForms(target.number, "line")) {
    const formNorm = normalizeForSearch(form);
    let start = 0;
    while (start < normalized.length) {
      const index = normalized.indexOf(formNorm, start);
      if (index < 0) break;
      windows.push(normalized.slice(lineOrdinalWindowStart(normalized, index), Math.min(normalized.length, index + formNorm.length + 420)));
      start = index + formNorm.length;
    }
  }
  return windows;
}

function lineOrdinalWindowStart(normalized, index) {
  const before = normalized.slice(Math.max(0, index - 80), index);
  if (containsNormalizedPhrase(before, "\u0442\u0435\u0440\u0430\u043f")) return Math.max(0, index - 24);
  return Math.max(0, index - 110);
}

function abbreviationSupport(answerText, window) {
  const answerNorm = normalizeForSearch(answerText);
  if (containsNormalizedPhrase(window, "\u0441\u0433\u043a\u0441") && containsNormalizedPhrase(answerNorm, "\u043a\u043e\u0440\u0442\u0438\u043a\u043e\u0441\u0442\u0435\u0440\u043e\u0438\u0434")) return 1;
  return 0;
}

const ORDINAL_GENERIC_FOCUS = new Set(
  [
    "\u043f\u0435\u0440\u0432\u044b\u0439",
    "\u0432\u0442\u043e\u0440\u043e\u0439",
    "\u0442\u0440\u0435\u0442\u0438\u0439",
    "\u0447\u0435\u0442\u0432\u0435\u0440\u0442\u044b\u0439",
    "\u0441\u0442\u0430\u0434\u0438\u044f",
    "\u0441\u0442\u0430\u0434\u0438\u0438",
    "\u0441\u0442\u0435\u043f\u0435\u043d\u044c",
    "\u0441\u0442\u0435\u043f\u0435\u043d\u0438",
    "\u043a\u043b\u0430\u0441\u0441",
    "\u043a\u043b\u0430\u0441\u0441\u0430",
    "\u043b\u0438\u043d\u0438\u044f",
    "\u043b\u0438\u043d\u0438\u0438",
    "\u044d\u0442\u0430\u043f",
    "\u044d\u0442\u0430\u043f\u043e\u043c",
    "\u0442\u0435\u0440\u0430\u043f\u0438\u044f",
    "\u0442\u0435\u0440\u0430\u043f\u0438\u0438",
    "\u043b\u0435\u0447\u0435\u043d\u0438\u0435",
    "\u043b\u0435\u0447\u0435\u043d\u0438\u044f",
    "\u043f\u0440\u0435\u043f\u0430\u0440\u0430\u0442",
    "\u043f\u0440\u0435\u043f\u0430\u0440\u0430\u0442\u043e\u043c",
    "\u043f\u0440\u0435\u043f\u0430\u0440\u0430\u0442\u0430\u043c\u0438",
    "\u044f\u0432\u043b\u044f\u0435\u0442\u0441\u044f",
    "\u044f\u0432\u043b\u044f\u044e\u0442\u0441\u044f",
    "\u0441\u0430\u0440\u043a\u043e\u0438\u0434\u043e\u0437",
    "\u0441\u0430\u0440\u043a\u043e\u0438\u0434\u043e\u0437\u0430",
  ].flatMap((item) => uniqueTokens(item)),
);

function specificOrdinalFocusTokens(focusTokens) {
  return (focusTokens ?? []).filter((token) => token.length >= 4 && !/^\d/.test(token) && !ORDINAL_GENERIC_FOCUS.has(token));
}

function ordinalWindowNegatesSpecificFocus(window, specificTokens) {
  for (const token of specificTokens ?? []) {
    if (token.length < 6) continue;
    const stem = token.slice(0, Math.min(8, token.length));
    let start = 0;
    while (start < window.length) {
      const index = window.indexOf(stem, start);
      if (index < 0) break;
      const before = window.slice(Math.max(0, index - 58), index);
      if (
        containsNormalizedPhrase(before, "\u0431\u0435\u0437") ||
        containsNormalizedPhrase(before, "\u043e\u0442\u0441\u0443\u0442") ||
        containsNormalizedPhrase(before, "\u043d\u0435\u0442")
      ) {
        return true;
      }
      start = index + stem.length;
    }
  }
  return false;
}

function bestOrdinalListSupport({ mode, pages, question, answer, answerTokens, focusTokens }) {
  const target = ordinalTarget(question);
  if (!target) return null;
  if (mode !== "single" && target.kind !== "degree") return null;
  const answerPhrases = answerSearchPhrases(answer.text).slice(0, 16);
  const specificTokens = specificOrdinalFocusTokens(focusTokens);
  let best = null;

  for (const page of pages) {
    const nextPage = target.kind === "step" ? pages.find((candidate) => candidate.page === page.page + 1) : null;
    const sources = [...cachedLineWindowSegments(page), { normalized: page.normalized, text: page.text }];
    if (nextPage) {
      const text = `${page.text}\n${nextPage.text}`;
      sources.push({ normalized: normalizeForSearch(text), text });
    }
    for (const source of sources) {
      for (const window of ordinalWindows(source, target)) {
        const tokens = tokenizeNormalized(window);
        const focusHits = tokenHitCount(specificTokens, tokens);
        const focusCoverage = strictSoftCoverage(specificTokens, tokens);
        if (target.kind !== "step" && specificTokens.length && focusHits <= 0 && focusCoverage < 0.72) continue;
        if (target.kind === "line" && ordinalWindowNegatesSpecificFocus(window, specificTokens)) continue;
        const answerCoverage = strictSoftCoverage(answerTokens, tokens);
        const phraseHit = answerPhrases.some((phrase) => containsNormalizedPhrase(window, phrase));
        const abbreviation = abbreviationSupport(answer.text, window);
        if (!phraseHit && answerCoverage < 0.58 && abbreviation <= 0) continue;
        const score =
          12.2 +
          (phraseHit ? 2.4 : 0) +
          Math.max(answerCoverage, abbreviation) * 4.4 +
          Math.min(2, focusHits) * 1.1 +
          Math.min(1, focusCoverage) * 0.8;
        best = betterEvidence(best, {
          answerId: answer.id,
          page: page.page,
          text: source.text,
          score,
          kind: "ordinal_list_segment",
        });
      }
    }
  }

  return best;
}

function typeOrdinalNumber(question) {
  const normalized = normalizeForSearch(question);
  if (!containsNormalizedPhrase(normalized, "\u0442\u0438\u043f")) return null;
  if (
    !containsNormalizedPhrase(normalized, "\u0445\u0430\u0440\u0430\u043a\u0442\u0435\u0440") &&
    !containsNormalizedPhrase(normalized, "\u043c\u0435\u0445\u0430\u043d\u0438\u0437\u043c")
  ) {
    return null;
  }
  if (containsNormalizedPhrase(normalized, "\u043f\u0435\u0440\u0432")) return 1;
  if (containsNormalizedPhrase(normalized, "\u0432\u0442\u043e\u0440")) return 2;
  if (containsNormalizedPhrase(normalized, "\u0442\u0440\u0435\u0442")) return 3;
  return null;
}

function typeOrdinalForms(number) {
  if (number === 1) return ["\u043f\u0435\u0440\u0432\u044b\u0439", "\u043f\u0435\u0440\u0432\u043e\u0433\u043e", "\u043f\u0435\u0440\u0432\u044b\u043c"];
  if (number === 2) return ["\u0432\u0442\u043e\u0440\u043e\u0439", "\u0432\u0442\u043e\u0440\u043e\u0433\u043e", "\u0432\u0442\u043e\u0440\u044b\u043c"];
  return ["\u0442\u0440\u0435\u0442\u0438\u0439", "\u0442\u0440\u0435\u0442\u044c\u0435\u0433\u043e", "\u0442\u0440\u0435\u0442\u044c\u0438\u043c"];
}

function nextTypeOrdinalBoundary(normalized, start, number) {
  let best = -1;
  for (const otherNumber of [1, 2, 3]) {
    if (otherNumber === number) continue;
    for (const form of typeOrdinalForms(otherNumber)) {
      const formNorm = normalizeForSearch(form);
      let index = normalized.indexOf(formNorm, start);
      while (index >= 0) {
        const before = normalized.slice(Math.max(0, index - 20), index);
        const after = normalized.slice(index, Math.min(normalized.length, index + 40));
        if (/\d/u.test(form) || containsNormalizedPhrase(`${before} ${after}`, "\u0442\u0438\u043f") || containsNormalizedPhrase(before, "\u0438")) {
          best = best < 0 ? index : Math.min(best, index);
          break;
        }
        index = normalized.indexOf(formNorm, index + formNorm.length);
      }
    }
  }
  return best;
}

function typeOrdinalWindows(source, number) {
  const windows = [];
  const normalized = source.normalized;
  for (const form of typeOrdinalForms(number)) {
    const formNorm = normalizeForSearch(form);
    let start = 0;
    while (start < normalized.length) {
      const index = normalized.indexOf(formNorm, start);
      if (index < 0) break;
      const before = normalized.slice(Math.max(0, index - 180), index);
      const near = normalized.slice(index, Math.min(normalized.length, index + 90));
      if (containsNormalizedPhrase(`${before} ${near}`, "\u0442\u0438\u043f")) {
        const afterStart = index + formNorm.length;
        const boundary = nextTypeOrdinalBoundary(normalized, afterStart + 8, number);
        const end = boundary > afterStart ? boundary : Math.min(normalized.length, afterStart + 360);
        windows.push(normalized.slice(index, end));
      }
      start = index + Math.max(1, formNorm.length);
    }
  }
  return windows;
}

function typeAbbreviationSupport(answerText, window) {
  const answerNorm = normalizeForSearch(answerText);
  let support = 0;
  if (
    containsNormalizedPhrase(answerNorm, "\u0430\u043e\u0440\u0442") &&
    containsNormalizedPhrase(answerNorm, "\u043a\u043b\u0430\u043f\u0430\u043d") &&
    containsNormalizedPhrase(window, "\u0410\u041a")
  ) {
    support += 0.28;
  }
  if (
    containsNormalizedPhrase(answerNorm, "\u0432\u043e\u0441\u0445\u043e\u0434") &&
    containsNormalizedPhrase(answerNorm, "\u0430\u043e\u0440\u0442") &&
    containsNormalizedPhrase(window, "\u0412\u0410")
  ) {
    support += 0.22;
  }
  return support;
}

const TYPE_ORDINAL_GENERIC_ANSWER = new Set(
  [
    "\u0441\u0442\u0432\u043e\u0440\u043a\u0438",
    "\u0441\u0442\u0432\u043e\u0440\u043e\u043a",
    "\u0430\u043e\u0440\u0442\u0430\u043b\u044c\u043d\u043e\u0433\u043e",
    "\u0430\u043e\u0440\u0442\u0430\u043b\u044c\u043d\u044b\u0439",
    "\u043a\u043b\u0430\u043f\u0430\u043d",
    "\u043a\u043b\u0430\u043f\u0430\u043d\u0430",
    "\u0440\u0435\u0433\u0443\u0440\u0433\u0438\u0442\u0430\u0446\u0438\u0438",
    "\u043f\u043e\u0442\u043e\u043a",
    "\u043f\u043e\u0442\u043e\u043a\u043e\u043c",
  ].flatMap((item) => uniqueTokens(item)),
);

function typeDistinctiveAnswerTokens(answerTokens) {
  return answerTokens.filter((token) => token.length >= 4 && !TYPE_ORDINAL_GENERIC_ANSWER.has(token));
}

function bestTypeOrdinalSupport({ pages, question, answer, answerTokens }) {
  const number = typeOrdinalNumber(question);
  if (!number) return null;
  const answerPhrases = answerSearchPhrases(answer.text).slice(0, 16);
  const distinctiveTokens = typeDistinctiveAnswerTokens(answerTokens);
  let best = null;

  for (const page of pages) {
    const sources = [...cachedLineWindowSegments(page), { normalized: page.normalized, text: page.text }];
    for (const source of sources) {
      for (const window of typeOrdinalWindows(source, number)) {
        const tokens = tokenizeNormalized(window);
        const phraseHit = answerPhrases.some((phrase) => containsNormalizedPhrase(window, phrase));
        const coverageScore = strictSoftCoverage(answerTokens, tokens);
        const distinctiveCoverage = distinctiveTokens.length ? softCoverage(distinctiveTokens, tokens) : 0;
        if (distinctiveTokens.length && distinctiveCoverage <= 0) continue;
        const abbreviation = typeAbbreviationSupport(answer.text, window);
        const support = Math.min(1, coverageScore + abbreviation + Math.min(0.2, distinctiveCoverage * 0.2));
        if (!phraseHit && support < 0.5) continue;
        const score = 13.4 + (phraseHit ? 2.6 : 0) + support * 5.2;
        best = betterEvidence(best, {
          answerId: answer.id,
          page: page.page,
          text: source.text,
          score,
          kind: "type_ordinal_segment",
        });
      }
    }
  }

  return best;
}

const INDICATION_LABEL_STOPS = new Set(
  [
    "\u043f\u0430\u0446\u0438\u0435\u043d\u0442",
    "\u043f\u0430\u0446\u0438\u0435\u043d\u0442\u0430",
    "\u043f\u0430\u0446\u0438\u0435\u043d\u0442\u043e\u0432",
    "\u0431\u043e\u043b\u044c\u043d\u043e\u0439",
    "\u0431\u043e\u043b\u044c\u043d\u044b\u0445",
    "\u0437\u0430",
    "\u0441",
    "\u043f\u0440\u0438",
    "\u043f\u043e",
  ].flatMap((item) => rawTokens(item)),
);

function questionIndicationLabel(question) {
  const tokens = rawTokens(question);
  if (!tokens.some((token) => token.startsWith("\u043f\u043e\u043a\u0430\u0437\u0430\u043d"))) return null;
  const start = tokens.findIndex((token) => token === "\u0434\u043b\u044f" || token === "\u043a");
  if (start < 0) return null;
  const label = [];
  for (let index = start + 1; index < tokens.length && label.length < 5; index += 1) {
    const token = tokens[index];
    if (INDICATION_LABEL_STOPS.has(token)) break;
    label.push(token);
  }
  return label.length ? label.join(" ") : null;
}

function indicationLineMatches(line, labelTokens) {
  const lineTokens = tokenizeNormalized(normalizeForSearch(line));
  if (softCoverage(labelTokens, lineTokens) < Math.min(1, labelTokens.length <= 3 ? 0.9 : 0.72)) return false;
  const normalized = normalizeForSearch(line);
  return (
    containsNormalizedPhrase(normalized, "\u043f\u043e\u043a\u0430\u0437\u0430\u043d") ||
    containsNormalizedPhrase(normalized, "\u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434") ||
    labelTokens.length >= 2
  );
}

function buildIndicationSegment(lines, index) {
  const current = normalizeForSearch(lines[index]);
  const before = normalizeForSearch(lines.slice(Math.max(0, index - 2), index).join(" "));
  let start = index;
  if (!containsNormalizedPhrase(current, "\u0433\u043e\u0441\u043f\u0438\u0442\u0430\u043b") && containsNormalizedPhrase(before, "\u043e\u0442\u0441\u0443\u0442")) {
    start = Math.max(0, index - 2);
  }
  const out = [];
  for (let cursor = start; cursor < Math.min(lines.length, index + 5); cursor += 1) {
    if (cursor > index) {
      const normalized = normalizeForSearch(lines[cursor]);
      if (
        containsNormalizedPhrase(normalized, "\u043f\u043b\u0430\u043d\u043e\u0432") ||
        containsNormalizedPhrase(normalized, "\u044d\u043a\u0441\u0442\u0440\u0435\u043d") ||
        containsNormalizedPhrase(normalized, "\u043f\u043e\u043a\u0430\u0437\u0430\u043d\u0438\u044f \u043a")
      ) {
        break;
      }
    }
    out.push(lines[cursor]);
  }
  return out.join(" ");
}

function indicationSemanticSupport(answerText, segment) {
  const answerNorm = normalizeForSearch(answerText);
  const segmentNorm = normalizeForSearch(segment);
  if (
    containsNormalizedPhrase(answerNorm, "\u0441\u043e\u0445\u0440\u0430\u043d") &&
    containsNormalizedPhrase(answerNorm, "\u0444\u0443\u043d\u043a\u0446") &&
    containsNormalizedPhrase(segmentNorm, "\u043e\u0442\u0441\u0443\u0442") &&
    containsNormalizedPhrase(segmentNorm, "\u0441\u043d\u0438\u0436") &&
    containsNormalizedPhrase(segmentNorm, "\u0444\u0443\u043d\u043a\u0446")
  ) {
    return 0.78;
  }
  if (
    containsNormalizedPhrase(answerNorm, "\u043e\u0441\u0442\u0440") &&
    containsNormalizedPhrase(answerNorm, "\u043f\u0440\u043e\u0433\u0440\u0435\u0441") &&
    containsNormalizedPhrase(segmentNorm, "\u043e\u0441\u0442\u0440") &&
    containsNormalizedPhrase(segmentNorm, "\u043f\u0440\u043e\u0433\u0440\u0435\u0441")
  ) {
    return 0.86;
  }
  return 0;
}

function indicationContrastMismatch(answerText, segment) {
  const answerNorm = normalizeForSearch(answerText);
  const segmentNorm = normalizeForSearch(segment);
  if (
    containsNormalizedPhrase(segmentNorm, "\u043e\u0442\u0441\u0443\u0442") &&
    !containsNormalizedPhrase(answerNorm, "\u043e\u0442\u0441\u0443\u0442") &&
    (containsNormalizedPhrase(answerNorm, "\u0443\u0433\u0440\u043e\u0437") || containsNormalizedPhrase(answerNorm, "\u043d\u0435\u0434\u043e\u0441\u0442\u0430\u0442")) &&
    containsNormalizedPhrase(segmentNorm, "\u043d\u0435\u0434\u043e\u0441\u0442\u0430\u0442")
  ) {
    return true;
  }
  return false;
}

function bestIndicationSegmentSupport({ pages, question, answer, answerTokens }) {
  const label = questionIndicationLabel(question);
  if (!label) return null;
  const labelTokens = uniqueTokens(label);
  if (!labelTokens.length) return null;
  const answerPhrases = answerSearchPhrases(answer.text).slice(0, 16);
  let best = null;

  for (const page of pages) {
    const lines = page.lines ?? [];
    for (let index = 0; index < lines.length; index += 1) {
      const neighborhood = lines.slice(index, Math.min(lines.length, index + 2)).join(" ");
      if (!indicationLineMatches(neighborhood, labelTokens)) continue;
      const segment = buildIndicationSegment(lines, index);
      if (indicationContrastMismatch(answer.text, segment)) continue;
      const normalized = normalizeForSearch(segment);
      const tokens = tokenizeNormalized(normalized);
      const phraseHit = answerPhrases.some((phrase) => containsNormalizedPhrase(normalized, phrase));
      const answerCoverage = strictSoftCoverage(answerTokens, tokens);
      const semantic = indicationSemanticSupport(answer.text, segment);
      const support = Math.max(answerCoverage, semantic);
      if (!phraseHit && support < 0.45) continue;
      const score = 13.8 + (phraseHit ? 2.6 : 0) + support * 5.4;
      best = betterEvidence(best, {
        answerId: answer.id,
        page: page.page,
        text: segment,
        score,
        kind: "indication_label_segment",
      });
    }
  }

  return best;
}

function ageEligibilityAdjustment({ pages, question, answer }) {
  const questionNorm = normalizeForSearch(question);
  const answerNorm = normalizeForSearch(answer.text);
  if (
    !containsNormalizedPhrase(questionNorm, "\u043f\u043e\u043a\u0430\u0437") &&
    !containsNormalizedPhrase(questionNorm, "\u043d\u0430\u0437\u043d\u0430\u0447") &&
    !containsNormalizedPhrase(questionNorm, "\u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434")
  ) {
    return { adjustment: 0, evidence: null };
  }
  const childAnswer =
    containsNormalizedPhrase(answerNorm, "\u0434\u0435\u0442\u0441\u043a") ||
    containsNormalizedPhrase(answerNorm, "\u0434\u0435\u0442\u044f\u043c") ||
    containsNormalizedPhrase(answerNorm, "\u0434\u0435\u0442\u0438") ||
    containsNormalizedPhrase(answerNorm, "\u0434\u0435\u0442\u0435\u0439");
  if (!childAnswer || containsNormalizedPhrase(answerNorm, "\u0432\u0437\u0440\u043e\u0441")) return { adjustment: 0, evidence: null };

  for (const page of pages) {
    for (const source of cachedLineWindowSegments(page)) {
      const normalized = source.normalized;
      if (
        containsNormalizedPhrase(normalized, "\u0434\u0435\u0442") &&
        (containsNormalizedPhrase(normalized, "\u043f\u0440\u043e\u0442\u0438\u0432\u043e\u043f\u043e\u043a\u0430\u0437") ||
          (containsNormalizedPhrase(normalized, "\u0442\u043e\u043b\u044c\u043a\u043e \u0432\u0437\u0440\u043e\u0441") && containsNormalizedPhrase(normalized, "\u0434\u0435\u0442")))
      ) {
        return {
          adjustment: -4.2,
          evidence: {
            answerId: answer.id,
            page: page.page,
            text: source.text,
            score: 4.2,
            kind: "age_eligibility_contraindication",
          },
        };
      }
    }
  }

  return { adjustment: 0, evidence: null };
}

function questionDefinitionTerm(question) {
  const tokens = rawTokens(question);
  const podIndex = tokens.findIndex((token) => token === "\u043f\u043e\u0434");
  const ponimIndex = tokens.findIndex((token) => token.startsWith("\u043f\u043e\u043d\u0438\u043c"));
  if (podIndex >= 0 && ponimIndex > podIndex + 1) {
    return tokens.slice(podIndex + 1, ponimIndex).join(" ");
  }
  const calledIndex = tokens.findIndex((token) => token.startsWith("\u043d\u0430\u0437\u044b\u0432"));
  if (calledIndex > 0) return tokens.slice(0, calledIndex).join(" ");
  return null;
}

function definitionTermIndex(normalized, term) {
  const labelNorm = normalizeForSearch(term);
  const exact = normalized.indexOf(labelNorm);
  if (exact >= 0) return exact;
  const prefixes = uniqueTokens(term)
    .filter((token) => token.length >= 5)
    .map((token) => token.slice(0, Math.min(6, token.length)));
  return prefixes.length ? normalized.indexOf(prefixes[0]) : -1;
}

function definitionTermWindow(normalized, term) {
  const exact = normalizeForSearch(term);
  const prefixes = [
    exact,
    ...uniqueTokens(term)
      .filter((token) => token.length >= 5)
      .map((token) => token.slice(0, Math.min(6, token.length))),
  ].filter(Boolean);
  for (const prefix of prefixes.length ? prefixes : [normalizeForSearch(term)]) {
    let start = 0;
    while (start < normalized.length) {
      const labelIndex = normalized.indexOf(prefix, start);
      if (labelIndex < 0) break;
      const around = normalized.slice(labelIndex, Math.min(normalized.length, labelIndex + 56));
      if (
        containsNormalizedPhrase(around, "\u044d\u0442\u043e") ||
        containsNormalizedPhrase(around, "\u043f\u043e\u043d\u0438\u043c") ||
        around.includes("-")
      ) {
        let end = Math.min(normalized.length, labelIndex + 300);
        const nextDefinition = normalized.indexOf(normalizeForSearch("\u044d\u0442\u043e"), labelIndex + 64);
        if (nextDefinition > labelIndex) end = Math.min(end, Math.max(labelIndex + 80, nextDefinition - 24));
        return normalized.slice(labelIndex, end);
      }
      start = labelIndex + Math.max(1, prefix.length);
    }
  }
  const fallback = definitionTermIndex(normalized, term);
  return fallback >= 0 ? normalized.slice(fallback, Math.min(normalized.length, fallback + 260)) : null;
}

function answerAbbreviations(answerText) {
  return (String(answerText ?? "").match(/[A-ZА-ЯЁ]{2,}(?:-[A-ZА-ЯЁ]{2,})?/gu) ?? [])
    .map((item) => normalizeForSearch(item))
    .filter((item) => item.length >= 2);
}

function bestTermDefinitionSupport({ pages, question, answer, answerTokens }) {
  const term = questionDefinitionTerm(question);
  if (!term) return null;
  if (normalizeForSearch(term).length < 4) return null;
  const abbreviations = answerAbbreviations(answer.text);
  let best = null;

  for (const page of pages) {
    const sources = [...cachedLineWindowSegments(page), { normalized: page.normalized, text: page.text }];
    for (const source of sources) {
      const window = definitionTermWindow(source.normalized, term);
      if (!window) continue;
      if (abbreviations.length && !abbreviations.some((abbr) => window.includes(abbr))) continue;
      const tokens = tokenizeNormalized(window);
      const answerCoverage = strictSoftCoverage(answerTokens, tokens);
      if (answerCoverage < 0.52) continue;
      const score = 14.2 + answerCoverage * 6.2 + numberCoverage(answer.text, window) * 0.8;
      best = betterEvidence(best, {
        answerId: answer.id,
        page: page.page,
        text: source.text,
        score,
        kind: "term_definition_segment",
      });
    }
  }

  return best;
}

const FREQUENCY_POLARITY_HIGH_CUES = [
  "\u043d\u0430\u0438\u0431\u043e\u043b\u0435\u0435 \u0447\u0430\u0441\u0442",
  "\u0441\u0430\u043c\u043e\u0439 \u0447\u0430\u0441\u0442",
  "\u0441\u0430\u043c\u044b\u043c \u0447\u0430\u0441\u0442",
  "\u0447\u0430\u0441\u0442\u043e \u0432\u0441\u0442\u0440\u0435\u0447",
  "\u0447\u0430\u0449\u0435",
  "\u0432\u0435\u0434\u0443\u0449",
];

const FREQUENCY_POLARITY_LOW_CUES = [
  "\u0440\u0435\u0434\u043a",
  "\u0440\u0435\u0436\u0435",
];

const FREQUENCY_POLARITY_GENERIC_FOCUS = new Set(
  [
    "\u043d\u0430\u0438\u0431\u043e\u043b\u0435\u0435",
    "\u0447\u0430\u0441\u0442\u044b\u0439",
    "\u0447\u0430\u0441\u0442\u0430\u044f",
    "\u0447\u0430\u0441\u0442\u043e\u0439",
    "\u0447\u0430\u0441\u0442\u043e\u0435",
    "\u0440\u0435\u0434\u043a\u0438\u0439",
    "\u0440\u0435\u0434\u043a\u0430\u044f",
    "\u0440\u0435\u0434\u043a\u043e\u0439",
    "\u0444\u043e\u0440\u043c\u0430",
    "\u0444\u043e\u0440\u043c\u043e\u0439",
    "\u0432\u0430\u0440\u0438\u0430\u043d\u0442",
    "\u0432\u0430\u0440\u0438\u0430\u043d\u0442\u043e\u043c",
    "\u0440\u043e\u043b\u044c",
    "\u043e\u0442\u0432\u043e\u0434\u0438\u0442\u0441\u044f",
    "\u0432\u0441\u0442\u0440\u0435\u0447\u0430\u0435\u0442\u0441\u044f",
  ].flatMap((item) => uniqueTokens(item)),
);

/** Определяет, спрашивает ли фрагмент о частом/редком/ведущем варианте. */
function frequencyPolarity(normalized: string) {
  if (FREQUENCY_POLARITY_LOW_CUES.some((cue) => containsNormalizedPhrase(normalized, cue))) return "low";
  if (FREQUENCY_POLARITY_HIGH_CUES.some((cue) => containsNormalizedPhrase(normalized, cue))) return "high";
  return null;
}

function frequencyPolarityFocusTokens(focusTokens, answerTokens) {
  const answerSet = new Set(answerTokens ?? []);
  return (focusTokens ?? []).filter((token) => token.length >= 4 && !answerSet.has(token) && !FREQUENCY_POLARITY_GENERIC_FOCUS.has(token));
}

/**
 * Проверяет точное фразовое совпадение вне скобочных примеров.
 *
 * Для частотных вопросов это важно: `(менингит + менингококкемия)` рядом с
 * "наиболее часто" обычно поясняет форму, но не обязательно является ответом.
 */
function containsPhraseOutsideParentheses(text: string, phrases: string[]) {
  const normalized = normalizeForSearch(String(text ?? "").replace(/\([^)]*\)/gu, " "));
  for (const phrase of phrases) {
    const normalizedPhrase = normalizeForSearch(phrase);
    if (!normalizedPhrase) continue;
    if (normalized.includes(normalizedPhrase)) return true;
  }
  return false;
}

/** Делит line-window на небольшие предложение-подобные фрагменты для локального связывания cue и ответа. */
function frequencyPolarityFragments(text: string) {
  const fragments = String(text ?? "")
    .split(/(?<=[.!?;])\s+/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 20);
  return fragments.length ? fragments : [String(text ?? "")];
}

function frequencyListItemLine(line: string) {
  return /^\s*(?:[•*\-]|\d+[.)]|[IVX]+[.)])\s+/iu.test(String(line ?? ""));
}

function frequencyPolarityListItems(pages, pageIndex: number, lineIndex: number) {
  const items: Array<{ text: string; page: number }> = [];
  for (let offset = 0; offset <= 1; offset += 1) {
    const page = pages[pageIndex + offset];
    if (!page) continue;
    const start = offset === 0 ? lineIndex + 1 : 0;
    for (let index = start; index < (page.lines?.length ?? 0); index += 1) {
      const line = page.lines[index];
      if (!frequencyListItemLine(line)) {
        if (items.length) return items;
        continue;
      }
      items.push({ text: line, page: page.page });
      if (items.length >= 10) return items;
    }
  }
  return items;
}

function betterFrequencyListSupport(best, { pages, pageIndex, lineIndex, answer, answerPhrases, answerTokens, specificTokens, target }) {
  const page = pages[pageIndex];
  const heading = page.lines?.[lineIndex] ?? "";
  const headingNorm = normalizeForSearch(heading);
  if (frequencyPolarity(headingNorm) !== target) return best;
  const headingTokens = tokenizeNormalized(headingNorm);
  const headingFocusHits = tokenHitCount(specificTokens, headingTokens);
  if (specificTokens.length >= 2 && headingFocusHits <= 0) return best;

  for (const item of frequencyPolarityListItems(pages, pageIndex, lineIndex)) {
    if (!containsPhraseOutsideParentheses(item.text, answerPhrases)) continue;
    const itemTokens = tokenize(item.text);
    const answerCoverage = strictSoftCoverage(answerTokens, itemTokens);
    const score = 15.8 + answerCoverage * 4.4 + Math.min(2, headingFocusHits) * 1.2;
    best = betterEvidence(best, {
      answerId: answer.id,
      page: item.page,
      text: `${heading} ${item.text}`,
      score,
      kind: "frequency_polarity_list_item",
    });
  }

  return best;
}

/**
 * Ищет evidence для вопросов вида "наиболее частый/редкий/ведущий".
 *
 * Слой не знает медицинских фактов: он связывает вариант ответа с тем же
 * предложением, где находится частотный маркер, и отбрасывает скобочные примеры.
 */
function bestFrequencyPolaritySupport({ mode, pages, topQuestionPages, question, answer, answerTokens, focusTokens }) {
  if (mode !== "single") return null;
  const target = frequencyPolarity(normalizeForSearch(question));
  if (!target) return null;
  const answerPhrases = answerSearchPhrases(answer.text).slice(0, 16);
  const specificTokens = frequencyPolarityFocusTokens(focusTokens, answerTokens);
  let best = null;

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];
    if (
      topQuestionPages?.size &&
      !topQuestionPages.has(page.page) &&
      !topQuestionPages.has(page.page - 1) &&
      !topQuestionPages.has(page.page + 1)
    ) {
      continue;
    }
    for (let lineIndex = 0; lineIndex < (page.lines?.length ?? 0); lineIndex += 1) {
      best = betterFrequencyListSupport(best, { pages, pageIndex, lineIndex, answer, answerPhrases, answerTokens, specificTokens, target });
    }
    for (const segment of cachedLineWindowSegments(page)) {
      for (const fragment of frequencyPolarityFragments(segment.text)) {
        const normalized = normalizeForSearch(fragment);
        if (frequencyPolarity(normalized) !== target) continue;
        const phraseHit = containsPhraseOutsideParentheses(fragment, answerPhrases);
        if (!phraseHit) continue;
        const fragmentTokens = tokenizeNormalized(normalized);
        const answerCoverage = strictSoftCoverage(answerTokens, fragmentTokens);
        const focusHits = tokenHitCount(specificTokens, fragmentTokens);
        if (specificTokens.length >= 2 && focusHits <= 0) continue;
        const score = 12.2 + (phraseHit ? 2.8 : 0) + answerCoverage * 4.2 + Math.min(2, focusHits) * 1.1;
        best = betterEvidence(best, {
          answerId: answer.id,
          page: page.page,
          text: fragment,
          score,
          kind: "frequency_polarity_segment",
        });
      }
    }
  }

  return best;
}

function negatedAnswerPrefixAdjustment({ mode, pages, question, answer, answerTokens }) {
  if (mode !== "single" || answerTokens.length < 2) return { adjustment: 0, evidence: null };
  const questionNorm = normalizeForSearch(question);
  if (!containsNormalizedPhrase(questionNorm, "\u043e\u0431\u0440\u0430\u0437\u043e\u0432") && !containsNormalizedPhrase(questionNorm, "\u0445\u0430\u0440\u0430\u043a\u0442\u0435\u0440")) {
    return { adjustment: 0, evidence: null };
  }
  const first = answerTokens[0];
  if (first.startsWith("he") || first.startsWith("\u043d\u0435")) return { adjustment: 0, evidence: null };
  const negatedPrefix = `he${first.slice(0, Math.min(first.length, 4))}`;
  for (const page of pages) {
    if (page.normalized.includes(negatedPrefix) && answerTokens.slice(1).some((token) => page.normalized.includes(token.slice(0, Math.min(token.length, 8))))) {
      return {
        adjustment: -3.8,
        evidence: {
          answerId: answer.id,
          page: page.page,
          text: evidenceSnippet(page.text, first, question),
          score: 3.8,
          kind: "negated_answer_prefix_mismatch",
        },
      };
    }
  }
  return { adjustment: 0, evidence: null };
}

function impossibilityOnlyAdjustment({ mode, pages, question, answer }) {
  if (mode !== "single") return { adjustment: 0, evidence: null };
  const questionNorm = normalizeForSearch(question);
  if (
    !containsNormalizedPhrase(questionNorm, "\u0434\u0438\u043d\u0430\u043c\u0438\u0447") &&
    !containsNormalizedPhrase(questionNorm, "\u044d\u0444\u0444\u0435\u043a\u0442\u0438\u0432")
  ) {
    return { adjustment: 0, evidence: null };
  }
  const answerTokens = uniqueTokens(answer.text).filter((token) => token.length >= 5 && !FOCUS_STOPWORDS.has(token));
  const phrases = answerSearchPhrases(answer.text).slice(0, 12);
  for (const page of pages) {
    for (const phrase of phrases) {
      const hits = findPhraseOccurrences(page.normalized, phrase, { textIsNormalized: true });
      for (const hit of hits) {
        const local = pageWindow(page, hit, 230);
        if (
          containsNormalizedPhrase(local, "\u0442\u043e\u043b\u044c\u043a\u043e \u0432 \u0441\u043b\u0443\u0447\u0430\u044f\u0445 \u043d\u0435\u0432\u043e\u0437\u043c\u043e\u0436") ||
          containsNormalizedPhrase(local, "\u043d\u0435\u0432\u043e\u0437\u043c\u043e\u0436\u043d\u043e\u0441\u0442\u0438 \u043f\u0440\u043e\u0432\u0435\u0434\u0435\u043d")
        ) {
          return {
            adjustment: -3.6,
            evidence: {
              answerId: answer.id,
              page: page.page,
              text: evidenceSnippet(page.text, phrase, question),
              score: 3.6,
              kind: "impossibility_only_penalty",
            },
          };
        }
      }
    }
    if (answerTokens.length) {
      for (const source of cachedLineWindowSegments(page)) {
        const local = source.normalized;
        const tokens = tokenizeNormalized(local);
        const answerCoverage = strictSoftCoverage(answerTokens, tokens);
        if (answerCoverage < 0.45) continue;
        if (
          containsNormalizedPhrase(local, "\u0442\u043e\u043b\u044c\u043a\u043e \u0432 \u0441\u043b\u0443\u0447\u0430\u044f\u0445 \u043d\u0435\u0432\u043e\u0437\u043c\u043e\u0436") ||
          containsNormalizedPhrase(local, "\u043d\u0435\u0432\u043e\u0437\u043c\u043e\u0436\u043d\u043e\u0441\u0442\u0438 \u043f\u0440\u043e\u0432\u0435\u0434\u0435\u043d")
        ) {
          return {
            adjustment: -3.6,
            evidence: {
              answerId: answer.id,
              page: page.page,
              text: source.text,
              score: 3.6,
              kind: "impossibility_only_penalty",
            },
          };
        }
      }
    }
  }
  return { adjustment: 0, evidence: null };
}

function activeTherapyIndicationAdjustment({ question, answer }) {
  const questionNorm = normalizeForSearch(question);
  if (
    !containsNormalizedPhrase(questionNorm, "\u043d\u0430\u0447\u0430\u043b") ||
    !containsNormalizedPhrase(questionNorm, "\u0430\u043a\u0442\u0438\u0432") ||
    !containsNormalizedPhrase(questionNorm, "\u0442\u0435\u0440\u0430\u043f")
  ) {
    return { adjustment: 0, evidence: null };
  }
  const answerNorm = normalizeForSearch(answer.text);
  const supportive =
    containsNormalizedPhrase(answerNorm, "\u0443\u0433\u0440\u043e\u0437") ||
    containsNormalizedPhrase(answerNorm, "\u043d\u0435\u0434\u043e\u0441\u0442\u0430\u0442") ||
    containsNormalizedPhrase(answerNorm, "\u043f\u043e\u0442\u0435\u0440") ||
    containsNormalizedPhrase(answerNorm, "\u043a\u0430\u0447\u0435\u0441\u0442") ||
    containsNormalizedPhrase(answerNorm, "\u0436\u0438\u0437\u043d");
  if (supportive) return { adjustment: 0, evidence: null };
  return {
    adjustment: -4.2,
    evidence: {
      answerId: answer.id,
      page: 0,
      text: answer.text,
      score: 4.2,
      kind: "active_therapy_indication_mismatch",
    },
  };
}

function questionDefinitionLabel(question) {
  const tokens = rawTokens(question);
  const index = tokens.findIndex((token) => token.startsWith("\u0441\u0447\u0438\u0442\u0430"));
  if (index < 0) return null;
  const label = [];
  for (let offset = index + 1; offset < Math.min(tokens.length, index + 5); offset += 1) {
    if (tokens[offset] === "\u043f\u0440\u0438") break;
    label.push(tokens[offset]);
  }
  return label.length ? label.join(" ") : null;
}

function labelDefinitionWindows(normalized, labelNorm) {
  const labelBoundaries = [
    "\u043e\u0442\u0440\u0438\u0446\u0430\u0442\u0435\u043b",
    "\u0441\u043e\u043c\u043d\u0438\u0442\u0435\u043b",
    "\u043f\u043e\u043b\u043e\u0436\u0438\u0442\u0435\u043b",
  ].map((item) => normalizeForSearch(item));
  const windows = [];
  let start = 0;
  while (start < normalized.length) {
    const labelIndex = normalized.indexOf(labelNorm, start);
    if (labelIndex < 0) break;
    const afterLabel = labelIndex + labelNorm.length;
    let end = Math.min(normalized.length, afterLabel + 220);
    for (const boundary of labelBoundaries) {
      if (labelNorm.includes(boundary)) continue;
      const index = normalized.indexOf(boundary, afterLabel + 18);
      if (index > 0) end = Math.min(end, index);
    }
    windows.push({
      answerWindow: normalized.slice(labelIndex, end),
      contextWindow: normalized.slice(Math.max(0, labelIndex - 240), Math.min(normalized.length, end + 80)),
    });
    start = afterLabel;
  }
  return windows;
}

const LABEL_DEFINITION_GENERIC_FOCUS = new Set(
  [
    "\u043f\u0440\u043e\u0431\u0430",
    "\u0441\u0447\u0438\u0442\u0430\u0435\u0442\u0441\u044f",
    "\u043f\u0440\u0438",
    "\u043f\u043e\u043b\u043e\u0436\u0438\u0442\u0435\u043b\u044c\u043d\u043e\u0439",
    "\u0441\u043e\u043c\u043d\u0438\u0442\u0435\u043b\u044c\u043d\u043e\u0439",
    "\u043e\u0442\u0440\u0438\u0446\u0430\u0442\u0435\u043b\u044c\u043d\u043e\u0439",
  ].flatMap((item) => uniqueTokens(item)),
);

function labelDefinitionFocusTokens(focusTokens) {
  return (focusTokens ?? []).filter((token) => token.length >= 3 && !LABEL_DEFINITION_GENERIC_FOCUS.has(token));
}

function bestLabelDefinitionSupport({ mode, pages, question, answer, answerTokens, focusTokens }) {
  if (mode !== "single") return null;
  const label = questionDefinitionLabel(question);
  if (!label) return null;
  const labelNorm = normalizeForSearch(label);
  const answerPhrases = answerSearchPhrases(answer.text).slice(0, 16);
  const specificTokens = labelDefinitionFocusTokens(focusTokens);
  let best = null;

  for (const page of pages) {
    for (const source of cachedLineWindowSegments(page)) {
      if (!containsNormalizedPhrase(source.normalized, label)) continue;
      for (const { answerWindow, contextWindow } of labelDefinitionWindows(source.normalized, labelNorm)) {
        if (specificTokens.length && tokenHitCount(specificTokens, tokenizeNormalized(contextWindow)) <= 0) continue;
        const tokens = tokenizeNormalized(answerWindow);
        const answerCoverage = strictSoftCoverage(answerTokens, tokens);
        const phraseHit = answerPhrases.some((phrase) => containsNormalizedPhrase(answerWindow, phrase));
        if (!phraseHit && answerCoverage < 0.55) continue;
        const score = 13.0 + (phraseHit ? 2.8 : 0) + answerCoverage * 4.2 + numberCoverage(answer.text, answerWindow) * 1.2;
        best = betterEvidence(best, {
          answerId: answer.id,
          page: page.page,
          text: source.text,
          score,
          kind: "label_definition_segment",
        });
      }
    }
  }

  return best;
}

const RECOMMENDATION_GENERIC_FOCUS = new Set(
  [
    "\u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434\u0443\u0435\u0442\u0441\u044f",
    "\u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434\u043e\u0432\u0430\u043d",
    "\u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434\u043e\u0432\u0430\u043d\u043d\u044b\u043c",
    "\u043b\u0435\u0447\u0435\u043d\u0438\u0435",
    "\u043b\u0435\u0447\u0435\u043d\u0438\u044e",
    "\u043f\u0430\u0446\u0438\u0435\u043d\u0442",
    "\u043f\u0430\u0446\u0438\u0435\u043d\u0442\u0430\u043c",
    "\u043f\u0440\u0435\u043f\u0430\u0440\u0430\u0442",
    "\u043f\u0440\u043e\u0432\u043e\u0434\u0438\u0442\u044c",
    "\u043f\u0440\u043e\u0432\u0435\u0434\u0435\u043d\u0438\u0435",
  ].flatMap((item) => uniqueTokens(item)),
);

function specificRecommendationFocusTokens(focusTokens) {
  return (focusTokens ?? []).filter((token) => token.length >= 4 && !RECOMMENDATION_GENERIC_FOCUS.has(token));
}

function recommendationQuestion(question) {
  return containsNormalizedPhrase(normalizeForSearch(question), "\u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434");
}

function segmentRecommendationPolarity(normalized) {
  if (
    containsNormalizedPhrase(normalized, "\u043d\u0435 \u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434") ||
    containsNormalizedPhrase(normalized, "\u043d\u0435\u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434")
  ) {
    return "negative";
  }
  if (containsNormalizedPhrase(normalized, "\u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434")) return "positive";
  return null;
}

function recommendationQuestionPolarity(question, intent) {
  const normalized = normalizeForSearch(question);
  if (intent.negative || containsNormalizedPhrase(normalized, "\u043d\u0435 \u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434") || containsNormalizedPhrase(normalized, "\u043d\u0435\u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434")) {
    return "negative";
  }
  return "positive";
}

function recommendationAnswerHit(segment, answer, answerTokens) {
  const answerPhrases = answerSearchPhrases(answer.text).slice(0, 16);
  const phraseHit = answerPhrases.some((phrase) => containsNormalizedPhrase(segment.normalized, phrase));
  const answerCoverage = strictSoftCoverage(answerTokens, segment.tokens);
  return { phraseHit, answerCoverage, hit: phraseHit || answerCoverage >= 0.6 };
}

function recommendationPolarityAdjustment({ mode, pages, question, answer, answerTokens, focusTokens, intent }) {
  if (mode !== "single" || !recommendationQuestion(question)) return { support: null, adjustment: 0, evidence: null };
  const target = recommendationQuestionPolarity(question, intent);
  if (target !== "negative") return { support: null, adjustment: 0, evidence: null };
  const specificTokens = specificRecommendationFocusTokens(focusTokens);
  let bestMatch = null;
  let bestMismatch = null;

  for (const page of pages) {
    for (const segment of cachedLineWindowSegments(page)) {
      const polarity = segmentRecommendationPolarity(segment.normalized);
      if (!polarity) continue;
      const focusHits = tokenHitCount(specificTokens, segment.tokens);
      if (specificTokens.length >= 2 && focusHits <= 0) continue;
      const answerHit = recommendationAnswerHit(segment, answer, answerTokens);
      if (!answerHit.hit) continue;
      const evidence = {
        answerId: answer.id,
        page: page.page,
        text: segment.text,
        score: 11.8 + (answerHit.phraseHit ? 2.5 : 0) + answerHit.answerCoverage * 3.2 + Math.min(2, focusHits) * 1.0,
        kind: polarity === target ? "recommendation_polarity_match" : "recommendation_polarity_mismatch",
      };
      if (polarity === target) bestMatch = betterEvidence(bestMatch, evidence);
      else bestMismatch = betterEvidence(bestMismatch, evidence);
    }
  }

  if (bestMatch) return { support: bestMatch, adjustment: 0, evidence: null };
  return bestMismatch ? { support: null, adjustment: -7.5, evidence: bestMismatch } : { support: null, adjustment: 0, evidence: null };
}

const SHARED_MULTI_SOURCE_KINDS = new Set([
  "question_anchor_segment",
  "question_chunk_answer",
  "bm25_question_answer",
  "section_list_segment",
  "bounded_list_segment",
  "ordinal_list_segment",
  "latin_fuzzy_ocr",
]);

const SHARED_MULTI_GENERIC_TOKENS = new Set(
  [
    "\u0434\u0430\u043d\u043d\u044b\u0435",
    "\u0434\u0430\u043d\u043d\u044b\u0445",
    "\u0446\u0435\u043b\u044c",
    "\u0446\u0435\u043b\u044c\u044e",
    "\u043f\u0430\u0446\u0438\u0435\u043d\u0442",
    "\u043f\u0430\u0446\u0438\u0435\u043d\u0442\u0430",
    "\u043f\u0430\u0446\u0438\u0435\u043d\u0442\u0430\u043c",
    "\u043f\u0440\u043e\u0432\u0435\u0434\u0435\u043d",
    "\u043f\u0440\u043e\u0432\u043e\u0434",
    "\u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434",
    "\u043e\u0442\u043d\u043e\u0441",
    "\u044f\u0432\u043b\u044f",
    "\u0432\u044b\u043f\u043e\u043b\u043d",
    "\u043b\u0435\u0447\u0435\u043d",
    "\u0442\u0435\u0440\u0430\u043f",
  ].flatMap((item) => uniqueTokens(item)),
);

const SHARED_MULTI_SECTION_CUES = [
  "\u043f\u043e \u043b\u043e\u043a\u0430\u043b\u0438\u0437\u0430\u0446\u0438\u0438",
  "\u043f\u043e \u044d\u0442\u0438\u043e\u043b\u043e\u0433\u0438\u0438",
  "\u043f\u043e \u0441\u0442\u0435\u043f\u0435\u043d\u0438",
  "\u043f\u043e \u043e\u0441\u043e\u0431\u0435\u043d\u043d\u043e\u0441\u0442\u044f\u043c \u0442\u0435\u0447\u0435\u043d\u0438\u044f",
  "\u043f\u043e \u043a\u043b\u0430\u0441\u0441\u0438\u0444\u0438\u043a\u0430\u0446\u0438\u0438",
].map((item) => normalizeForSearch(item));

const SHARED_MULTI_REQUIRED_CUE_GROUPS = [
  {
    answer: ["\u043c\u0435\u043d\u0435\u0435", "\u043d\u0438\u0436\u0435", "\u0441\u043d\u0438\u0436", "\u043d\u0438\u0437\u043a", "\u043c\u043e\u043b\u043e\u0436\u0435", "\u043f\u043e\u043d\u0438\u0436"],
    source: ["\u043c\u0435\u043d\u0435\u0435", "\u043d\u0438\u0436\u0435", "\u0441\u043d\u0438\u0436", "\u043d\u0438\u0437\u043a", "\u043c\u043e\u043b\u043e\u0436\u0435", "\u043f\u043e\u043d\u0438\u0436"],
  },
  {
    answer: ["\u0431\u043e\u043b\u0435\u0435", "\u0432\u044b\u0448\u0435", "\u043f\u043e\u0432\u044b\u0448", "\u0432\u044b\u0441\u043e\u043a", "\u0441\u0442\u0430\u0440\u0448\u0435"],
    source: ["\u0431\u043e\u043b\u0435\u0435", "\u0432\u044b\u0448\u0435", "\u043f\u043e\u0432\u044b\u0448", "\u0432\u044b\u0441\u043e\u043a", "\u0441\u0442\u0430\u0440\u0448\u0435"],
  },
].map((group) => ({
  answer: group.answer.map((item) => normalizeForSearch(item)),
  source: group.source.map((item) => normalizeForSearch(item)),
}));

const SHARED_MULTI_SHORT_ALIAS_PHRASES = new Set(["\u0441\u043f\u044f", "\u0440\u044d"].map((item) => normalizeForSearch(item)));

function answerShortMedicalAliases(answerText) {
  const own = new Set(focusedAnswerSearchPhrases(answerText).map((phrase) => normalizeForSearch(phrase)));
  const answerNorm = normalizeForSearch(answerText);
  return [...SHARED_MULTI_SHORT_ALIAS_PHRASES].filter((alias) => own.has(alias) && !answerNorm.includes(alias));
}

function bestShortMedicalAliasSupport({ mode, pages, topQuestionPages, questionTokens, answer }) {
  if (mode !== "multi") return null;
  const aliases = answerShortMedicalAliases(answer.text);
  if (!aliases.length) return null;
  let best = null;
  for (const page of pages) {
    const nearTopPage =
      !topQuestionPages?.size || topQuestionPages.has(page.page) || topQuestionPages.has(page.page - 1) || topQuestionPages.has(page.page + 1);
    if (!nearTopPage) continue;
    for (const segment of cachedLineWindowSegments(page)) {
      if (!aliases.some((alias) => segment.normalized.includes(alias))) continue;
      const questionCoverage = coverage(questionTokens, segment.tokens);
      if (questionCoverage < 0.18) continue;
      const score = 10.8 + Math.min(0.65, questionCoverage) * 5.4;
      best = betterEvidence(best, {
        answerId: answer.id,
        page: page.page,
        text: segment.text,
        score,
        kind: "short_medical_alias_segment",
      });
    }
  }
  return best;
}

function sharedMultiTokens(answerText) {
  return uniqueTokens(answerText).filter((token) => token.length >= 3 && !FOCUS_STOPWORDS.has(token) && !SHARED_MULTI_GENERIC_TOKENS.has(token));
}

const PARENTHETICAL_GROUP_GENERIC_FOCUS = new Set(
  [
    "\u0430\u043c\u043a",
    "\u0430\u043d\u043e\u043c\u0430\u043b\u044c\u043d",
    "\u043c\u0430\u0442\u043e\u0447",
    "\u043a\u0440\u043e\u0432\u043e\u0442\u0435\u0447",
    "\u043a\u0430\u0442\u0435\u0433\u043e\u0440",
    "\u043a\u0430\u0442\u0435\u0433\u043e\u0440\u0438",
    "\u043e\u0442\u043d\u043e\u0441",
    "\u044f\u0432\u043b\u044f",
    "\u044f\u0432\u043b\u044f\u044e\u0442",
  ].flatMap((item) => uniqueTokens(item)),
);

function parentheticalGroupFocusTokens(question) {
  return uniqueTokens(question).filter((token) => token.length >= 4 && !FOCUS_STOPWORDS.has(token) && !PARENTHETICAL_GROUP_GENERIC_FOCUS.has(token));
}

function answerInParentheticalGroup(groupNormalized, answer) {
  return answerSearchPhrases(answer.text)
    .map((phrase) => normalizeForSearch(phrase))
    .filter((phrase) => phrase.length >= 3)
    .some((phrase) => containsNormalizedPhrase(groupNormalized, phrase));
}

function parentheticalGroupAnswerHit(groupNormalized, groupTokens, answer) {
  const answerTokens = uniqueTokens(answer.text);
  return answerInParentheticalGroup(groupNormalized, answer) || strictSoftCoverage(answerTokens, groupTokens) >= (answerTokens.length <= 1 ? 0.95 : 0.68);
}

function inlineParentheticalGroupContext({ beforeText, afterText, specificFocus }) {
  const beforeTokens = tokenize(beforeText);
  const afterTokens = tokenize(afterText);
  const headHits = tokenHitCount(specificFocus, beforeTokens);
  const tailHits = tokenHitCount(specificFocus, afterTokens);
  const hasListCue = beforeTokens.includes(stemToken(normalizeForSearch("\u0440\u044f\u0434"))) || beforeTokens.includes(stemToken(normalizeForSearch("\u0433\u0440\u0443\u043f\u043f")));
  return hasListCue && headHits >= 1 && tailHits >= 1;
}

/**
 * Связывает варианты ответа с ближайшей скобочной группой после релевантного
 * заголовка: `органические причины (...)`, `факторы риска (...)` и похожие
 * конструкции. Это помогает не смешивать соседние группы в одной строке.
 */
function bestParentheticalGroupSupport({ mode, pages, question, answer, answers, answerTokens }) {
  if (mode !== "multi") return null;
  const normalizedQuestion = normalizeForSearch(question);
  const questionTokenSet = new Set(tokenize(question));
  if (questionTokenSet.has(stemToken(normalizeForSearch("\u0444\u0430\u043a\u0442\u043e\u0440"))) && questionTokenSet.has(stemToken(normalizeForSearch("\u0440\u0438\u0441\u043a")))) {
    return null;
  }
  const specificFocus = parentheticalGroupFocusTokens(question);
  if (specificFocus.length < 2) return null;
  let best = null;

  for (const page of pages) {
    const text = String(page.text ?? "");
    const matches = text.matchAll(/\(([^()]{6,260})\)/gu);
    for (const match of matches) {
      const groupText = match[1] ?? "";
      const groupStart = match.index ?? 0;
      let beforeText = text.slice(Math.max(0, groupStart - 180), groupStart);
      const previousGroupEnd = beforeText.lastIndexOf(")");
      if (previousGroupEnd >= 0) beforeText = beforeText.slice(previousGroupEnd + 1);
      const afterText = text.slice(groupStart + match[0].length, groupStart + match[0].length + 180);
      const beforeTokens = tokenize(beforeText);
      const categoryContext = beforeTokens.includes(stemToken(normalizeForSearch("\u043a\u0430\u0442\u0435\u0433\u043e\u0440\u0438\u0438")));
      const inlineContext = inlineParentheticalGroupContext({ beforeText, afterText, specificFocus });
      if (!categoryContext && !inlineContext) continue;
      const specificHits = tokenHitCount(specificFocus, beforeTokens);
      const specificCoverage = coverage(specificFocus, beforeTokens);
      if (categoryContext && specificHits < 2 && specificCoverage < 0.34) continue;

      const groupNormalized = normalizeForSearch(groupText);
      const groupTokens = tokenize(groupText);
      const groupAnswerHits = (answers ?? []).filter((candidate) => parentheticalGroupAnswerHit(groupNormalized, groupTokens, candidate)).length;
      if (inlineContext && groupAnswerHits < 2) continue;
      const answerCoverage = strictSoftCoverage(answerTokens, groupTokens);
      if (!answerInParentheticalGroup(groupNormalized, answer) && answerCoverage < (answerTokens.length <= 1 ? 0.95 : 0.68)) continue;
      const score =
        (inlineContext ? 14.6 : 13.8) +
        Math.min(4, specificHits) * 1.15 +
        Math.min(0.75, specificCoverage) * 5.2 +
        answerCoverage * 2.2 +
        Math.min(3, groupAnswerHits) * 0.8;
      best = betterEvidence(best, {
        answerId: answer.id,
        page: page.page,
        text: `${beforeText}(${groupText})`.replace(/\s+/g, " ").trim(),
        score,
        kind: "parenthetical_group_segment",
      });
    }
  }

  return best;
}

const CONTINUATION_LIST_QUESTION_CUES = [
  "\u043e\u0441\u043d\u043e\u0432\u0430\u043d",
].map((item) => normalizeForSearch(item));

const CONTINUATION_LIST_SEGMENT_CUES = [
  "\u043e\u0441\u043d\u043e\u0432\u0430\u043d",
  "\u0434\u0430\u043d\u043d",
].map((item) => normalizeForSearch(item));

function continuationListQuestion(question, intent) {
  if (intent?.exception) return false;
  const normalized = normalizeForSearch(question);
  if (containsNormalizedPhrase(normalized, "\u043d\u0435 \u0432\u043a\u043b\u044e\u0447")) return false;
  return CONTINUATION_LIST_QUESTION_CUES.some((cue) => normalized.includes(cue)) && containsNormalizedPhrase(normalized, "\u043d\u0430");
}

function answerContinuationListHit(segment, answer, answerTokens) {
  const normalized = segment.normalized;
  const phraseHit = answerSearchPhrases(answer.text)
    .map((phrase) => normalizeForSearch(phrase))
    .filter((phrase) => phrase.length >= 5)
    .some((phrase) => containsNormalizedPhrase(normalized, phrase));
  const answerCoverage = strictSoftCoverage(answerTokens, segment.tokens);
  const numbers = extractNumbers(answer.text);
  if (numbers.length && numberCoverage(answer.text, normalized) < 1) return { phraseHit: false, answerCoverage, hit: false };
  const hit = phraseHit || answerCoverage >= (answerTokens.length <= 2 ? 0.86 : 0.68);
  return { phraseHit, answerCoverage, hit };
}

function continuationLineSegments(page) {
  const lines = page.lines ?? [];
  const segments = [];
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines.slice(index, Math.min(lines.length, index + 7)).join(" ").replace(/\s+/g, " ").trim();
    if (text.length >= 40 && text.length <= 1500) {
      segments.push({
        text,
        normalized: normalizeForSearch(text),
        tokens: tokenize(text),
      });
    }
  }
  return segments;
}

/**
 * Ищет варианты в строке-продолжении вопроса вида `критерии основаны на...`.
 *
 * В отличие от общего BM25 этот scorer требует, чтобы сама строка содержала
 * формулировку вопроса и структурный list-cue, поэтому соседние обсуждения
 * вариантов не получают такой же вес.
 */
function bestQuestionContinuationListSupport({ mode, pages, topQuestionPages, question, answer, answerTokens, questionTokens, focusTokens, intent }) {
  if (mode !== "multi" || !continuationListQuestion(question, intent)) return null;
  const usefulFocus = (focusTokens?.length ? focusTokens : questionTokens).filter((token) => token.length >= 4 && !FOCUS_STOPWORDS.has(token));
  let best = null;

  for (const page of pages) {
    const nearTopPage =
      !topQuestionPages?.size || topQuestionPages.has(page.page) || topQuestionPages.has(page.page - 1) || topQuestionPages.has(page.page + 1);
    if (!nearTopPage) continue;
    for (const segment of continuationLineSegments(page)) {
      if (!CONTINUATION_LIST_SEGMENT_CUES.some((cue) => segment.normalized.includes(cue))) continue;
      const questionCoverage = coverage(questionTokens, segment.tokens);
      const focusHits = tokenHitCount(usefulFocus, segment.tokens);
      if (questionCoverage < 0.5) continue;
      if (usefulFocus.length >= 2 && focusHits < 2) continue;
      const answerHit = answerContinuationListHit(segment, answer, answerTokens);
      if (!answerHit.hit) continue;
      const score =
        11.6 +
        Math.min(0.72, questionCoverage) * 5.4 +
        Math.min(3, focusHits) * 0.8 +
        answerHit.answerCoverage * 2.6 +
        (answerHit.phraseHit ? 1.6 : 0);
      best = betterEvidence(best, {
        answerId: answer.id,
        page: page.page,
        text: segment.text,
        score,
        kind: "question_continuation_list",
      });
    }
  }

  return best;
}

function sharedMultiSectionCue(question) {
  const normalizedQuestion = normalizeForSearch(question);
  return SHARED_MULTI_SECTION_CUES.find((cue) => normalizedQuestion.includes(cue)) ?? null;
}

function sharedMultiFocusedNormalized(segmentText, question) {
  const normalized = normalizeForSearch(segmentText);
  const cue = sharedMultiSectionCue(question);
  if (!cue) return normalized;
  const start = normalized.indexOf(cue);
  if (start < 0) return normalized;
  let end = normalized.length;
  for (const nextCue of SHARED_MULTI_SECTION_CUES) {
    if (nextCue === cue) continue;
    const index = normalized.indexOf(nextCue, start + cue.length + 20);
    if (index > start) end = Math.min(end, index);
  }
  return normalized.slice(start, end);
}

function sharedMultiRequiredCueMismatch(answerText, normalizedSegment) {
  const normalizedAnswer = normalizeForSearch(answerText);
  for (const group of SHARED_MULTI_REQUIRED_CUE_GROUPS) {
    if (group.answer.some((cue) => normalizedAnswer.includes(cue)) && !group.source.some((cue) => normalizedSegment.includes(cue))) {
      return true;
    }
  }
  return false;
}

function sharedMultiTokenPosition(normalizedSegment, token) {
  const probes = [token, token.slice(0, 10), token.slice(0, 8), token.slice(0, 6)].filter((item) => item.length >= 4);
  for (const probe of probes) {
    const index = normalizedSegment.indexOf(probe);
    if (index >= 0) return index;
  }
  return -1;
}

function sharedMultiCompactSpan(normalizedSegment, tokens) {
  const positions = tokens
    .map((token) => sharedMultiTokenPosition(normalizedSegment, token))
    .filter((position) => position >= 0)
    .sort((a, b) => a - b);
  if (positions.length < Math.min(2, tokens.length)) return Infinity;
  return positions[positions.length - 1] - positions[0];
}

function sharedMultiNumericComparatorMismatch(answerText, normalizedSegment) {
  const answerNumbers = extractNumbers(answerText).filter((number) => /^\d+(?:[.,]\d+)?$/u.test(number));
  if (answerNumbers.length !== 1) return false;
  const answerNumber = answerNumbers[0].replace(",", ".");
  const comparatorHits = [...String(normalizedSegment ?? "").matchAll(/(?:<=|<|>=|>)\s*(\d+(?:[.,]\d+)?)/gu)].map((match) =>
    String(match[1] ?? "").replace(",", "."),
  );
  if (!comparatorHits.length) return false;
  return !comparatorHits.includes(answerNumber);
}

function sharedMultiSegmentHit(segmentText, answer, question) {
  const normalized = sharedMultiFocusedNormalized(segmentText, question);
  if (!normalized || normalized.length < 30) return null;
  if (sharedMultiRequiredCueMismatch(answer.text, normalized)) return null;
  if (sharedMultiNumericComparatorMismatch(answer.text, normalized)) return null;

  const tokens = sharedMultiTokens(answer.text);
  const phraseHit = focusedAnswerSearchPhrases(answer.text)
    .map((phrase) => normalizeForSearch(phrase))
    .filter((phrase) => phrase.length >= 9 || SHARED_MULTI_SHORT_ALIAS_PHRASES.has(phrase) || (tokens.length === 1 && phrase.length >= 5))
    .some((phrase) => (SHARED_MULTI_SHORT_ALIAS_PHRASES.has(phrase) ? normalized.includes(phrase) : containsNormalizedPhrase(normalized, phrase)));
  const tokenCoverage = tokens.length ? strictSoftCoverage(tokens, tokenizeNormalized(normalized)) : 0;
  const compactSpan = sharedMultiCompactSpan(normalized, tokens);
  const spanLimit = Math.min(520, 150 + tokens.length * 45);
  const strongTokenHit = tokens.length >= 2 && tokenCoverage >= 0.78 && compactSpan <= spanLimit;

  if (!phraseHit && !strongTokenHit) return null;
  return { phraseHit, tokenCoverage, tokens, compactSpan };
}

function addSharedMultiSegmentSupport(answerScores, intent, question) {
  if (intent.negative || intent.exception || answerScores.length < 3) return answerScores;
  const sorted = [...answerScores].sort((a, b) => b.raw - a.raw);
  const topRaw = sorted[0]?.raw ?? 0;
  if (topRaw < 5) return answerScores;

  const sourceMap = new Map();
  for (const item of sorted.slice(0, Math.min(3, sorted.length))) {
    for (const evidenceItem of item.evidence.slice(0, 4)) {
      if (!SHARED_MULTI_SOURCE_KINDS.has(evidenceItem.kind)) continue;
      if (!evidenceItem.text || evidenceItem.text.length < 50) continue;
      if ((evidenceItem.score ?? 0) < 4.8) continue;
      const key = `${evidenceItem.page}:${evidenceItem.kind}:${evidenceItem.text.slice(0, 220)}`;
      if (!sourceMap.has(key) || sourceMap.get(key).score < evidenceItem.score) {
        sourceMap.set(key, evidenceItem);
      }
    }
  }
  const sources = [...sourceMap.values()].slice(0, 8);
  if (!sources.length) return answerScores;

  return answerScores.map((item) => {
    let best = null;
    for (const source of sources) {
      const hit = sharedMultiSegmentHit(source.text, item.answer, question);
      if (!hit) continue;
      const evidenceScore =
        9.2 +
        Math.min(3.2, source.score * 0.18) +
        hit.tokenCoverage * 2.6 +
        (hit.phraseHit ? 1.4 : 0);
      best = betterEvidence(best, {
        answerId: item.answer.id,
        page: source.page,
        text: source.text,
        score: evidenceScore,
        kind: "shared_multi_segment",
      });
    }
    if (!best) return item;
    const minPriorRatio = topRaw < 10 ? 0.48 : 0.38;
    if (item.raw < topRaw * minPriorRatio) return item;
    const supportRatio = topRaw < 13 ? 0.96 : best.score >= 12 ? 0.82 : 0.76;
    const boostedRaw = Math.max(item.raw, topRaw * supportRatio);
    if (boostedRaw <= item.raw + 0.05) return item;
    return { ...item, raw: boostedRaw, evidence: [...item.evidence, best] };
  });
}

function applyGeneSentenceSetSupport(answerScores, mode, question) {
  if (mode !== "multi" || !geneMutationQuestion(question)) return answerScores;
  const supported = answerScores.filter((item) => item.evidence.some((evidenceItem) => evidenceItem.kind === "gene_sentence_segment"));
  if (supported.length < 2) return answerScores;
  const topRaw = Math.max(...answerScores.map((item) => item.raw), 0);
  return answerScores.map((item) => {
    const hasGeneSupport = item.evidence.some((evidenceItem) => evidenceItem.kind === "gene_sentence_segment");
    if (hasGeneSupport) return { ...item, raw: Math.max(item.raw, topRaw * 0.93) };
    if (latinAnswerTokens(item.answer.text).length) return { ...item, raw: item.raw * 0.56 };
    return item;
  });
}

function questionAgeFormCues(question) {
  const normalized = normalizeForSearch(question);
  if (!containsNormalizedPhrase(normalized, "\u0432\u043e\u0437\u0440\u0430\u0441\u0442") || !containsNormalizedPhrase(normalized, "\u0444\u043e\u0440\u043c")) return null;
  if (containsNormalizedPhrase(normalized, "\u043f\u043e\u0434\u0440\u043e\u0441\u0442") || containsNormalizedPhrase(normalized, "\u0432\u0437\u0440\u043e\u0441\u043b")) {
    return ["\u043f\u043e\u0434\u0440\u043e\u0441\u0442", "\u0432\u0437\u0440\u043e\u0441\u043b"].map((item) => normalizeForSearch(item));
  }
  if (containsNormalizedPhrase(normalized, "\u043f\u043e\u0437\u0434") && containsNormalizedPhrase(normalized, "\u043c\u043b\u0430\u0434\u0435\u043d")) {
    return ["\u043f\u043e\u0437\u0434", "\u043c\u043b\u0430\u0434\u0435\u043d"].map((item) => normalizeForSearch(item));
  }
  if (containsNormalizedPhrase(normalized, "\u0440\u0430\u043d") && containsNormalizedPhrase(normalized, "\u043c\u043b\u0430\u0434\u0435\u043d")) {
    return ["\u0440\u0430\u043d", "\u043c\u043b\u0430\u0434\u0435\u043d"].map((item) => normalizeForSearch(item));
  }
  if (containsNormalizedPhrase(normalized, "\u044e\u0432\u0435\u043d")) {
    return ["\u044e\u0432\u0435\u043d"].map((item) => normalizeForSearch(item));
  }
  return null;
}

function ageFormLabelIndex(normalized, cues) {
  if (cues.length === 1) return normalized.indexOf(cues[0]);
  let best = -1;
  const primary = cues[0];
  let start = 0;
  while (start < normalized.length) {
    const index = normalized.indexOf(primary, start);
    if (index < 0) break;
    const positions = [index];
    let ok = true;
    for (const cue of cues.slice(1)) {
      const before = normalized.lastIndexOf(cue, index + 42);
      const after = normalized.indexOf(cue, Math.max(0, index - 8));
      const candidate =
        before >= 0 && Math.abs(before - index) <= 42
          ? before
          : after >= 0 && Math.abs(after - index) <= 42
            ? after
            : -1;
      if (candidate < 0) {
        ok = false;
        break;
      }
      positions.push(candidate);
    }
    if (ok && Math.max(...positions) - Math.min(...positions) <= 48) {
      const labelStart = Math.min(...positions);
      best = best < 0 ? labelStart : Math.min(best, labelStart);
    }
    start = index + primary.length;
  }
  return best;
}

const AGE_FORM_BOUNDARY_CUES = [
  "\u043f\u0435\u0440\u0438\u043d\u0430\u0442",
  "\u0440\u0430\u043d",
  "\u043f\u043e\u0437\u0434",
  "\u044e\u0432\u0435\u043d",
  "\u043f\u043e\u0434\u0440\u043e\u0441\u0442",
  "\u0432\u0437\u0440\u043e\u0441\u043b",
].map((item) => normalizeForSearch(item));

function nextAgeFormBoundary(normalized, labelIndex, cues) {
  let best = -1;
  for (const cue of AGE_FORM_BOUNDARY_CUES) {
    let index = normalized.indexOf(cue, labelIndex + 8);
    while (index >= 0) {
      const isCurrentLabelCue = cues.includes(cue) && Math.abs(index - labelIndex) <= 48;
      if (!isCurrentLabelCue) {
        best = best < 0 ? index : Math.min(best, index);
        break;
      }
      index = normalized.indexOf(cue, index + cue.length);
    }
  }
  return best;
}

function answerComparatorMismatch(answerText, window) {
  const numbers = extractNumbers(answerText);
  if (!numbers.length) return false;
  const firstNumber = expandNumberToken(numbers[0])[0] ?? numbers[0];
  const normalizedAnswer = normalizeForSearch(answerText);
  const startsWithDo = normalizedAnswer.startsWith(normalizeForSearch("\u0434\u043e "));
  const lessAnswer =
    answerText.includes("<") ||
    startsWithDo ||
    containsNormalizedPhrase(normalizedAnswer, "\u043c\u0435\u043d\u0435\u0435") ||
    containsNormalizedPhrase(normalizedAnswer, "\u043c\u0435\u043d\u044c\u0448\u0435") ||
    containsNormalizedPhrase(normalizedAnswer, "\u043c\u043e\u043b\u043e\u0436\u0435");
  if (lessAnswer) {
    return ![
      "\u0434\u043e",
      "\u043c\u0435\u043d\u0435\u0435",
      "\u043c\u0435\u043d\u044c\u0448\u0435",
      "\u043c\u043e\u043b\u043e\u0436\u0435",
      "\u043d\u0438\u0436\u0435",
    ].some((cue) => containsNormalizedPhrase(window, `${cue} ${firstNumber}`));
  }
  const greaterAnswer =
    answerText.includes(">") ||
    containsNormalizedPhrase(normalizedAnswer, "\u0441\u0442\u0430\u0440\u0448\u0435") ||
    containsNormalizedPhrase(normalizedAnswer, "\u0431\u043e\u043b\u0435\u0435") ||
    containsNormalizedPhrase(normalizedAnswer, "\u0432\u044b\u0448\u0435");
  if (greaterAnswer) {
    return ![
      "\u0441\u0442\u0430\u0440\u0448\u0435",
      "\u0431\u043e\u043b\u0435\u0435",
      "\u0432\u044b\u0448\u0435",
      "\u043f\u043e\u0441\u043b\u0435",
    ].some((cue) => containsNormalizedPhrase(window, `${cue} ${firstNumber}`));
  }
  return false;
}

function ageAnswerSupport(window, answer, answerTokens) {
  if (answerComparatorMismatch(answer.text, window)) return null;
  const phraseHit = answerSearchPhrases(answer.text)
    .map((phrase) => normalizeForSearch(phrase))
    .filter((phrase) => phrase.length >= 2)
    .some((phrase) => containsNormalizedPhrase(window, phrase));
  const tokens = answerTokens.filter((token) => token.length >= 2);
  const tokenCoverage = tokens.length ? strictSoftCoverage(tokens, tokenizeNormalized(window)) : 0;
  const numberHit = numberCoverage(answer.text, window);
  if (!phraseHit && tokenCoverage < 0.7 && numberHit < 0.9) return null;
  return { phraseHit, tokenCoverage, numberHit };
}

function bestAgeFormSupport({ mode, pages, question, answer, answerTokens }) {
  if (mode !== "single") return null;
  const cues = questionAgeFormCues(question);
  if (!cues) return null;
  const normalizedAnswer = normalizeForSearch(answer.text);
  if (!extractNumbers(answer.text).length && !containsNormalizedPhrase(normalizedAnswer, "\u0441\u0442\u0430\u0440\u0448") && !containsNormalizedPhrase(normalizedAnswer, "\u043c\u043e\u043b\u043e\u0436")) return null;
  let best = null;

  for (const page of pages) {
    const lines = page.lines ?? [];
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 2)).join(" ");
      const normalized = normalizeForSearch(text);
      const labelIndex = ageFormLabelIndex(normalized, cues);
      if (labelIndex < 0) continue;
      const boundary = nextAgeFormBoundary(normalized, labelIndex, cues);
      const windowEnd = boundary > labelIndex ? boundary : Math.min(normalized.length, labelIndex + 145);
      const window = normalized.slice(labelIndex, windowEnd);
      const support = ageAnswerSupport(window, answer, answerTokens);
      if (!support) continue;
      const score = 15.4 + support.numberHit * 3.8 + support.tokenCoverage * 2.4 + (support.phraseHit ? 2.0 : 0);
      best = betterEvidence(best, {
        answerId: answer.id,
        page: page.page,
        text,
        score,
        kind: "age_form_segment",
      });
    }
  }

  return best;
}

function questionRomanStage(question) {
  const tokens = rawTokens(question);
  const index = tokens.findIndex((token) => token.startsWith("\u0441\u0442\u0430\u0434\u0438"));
  const next = index >= 0 ? tokens[index + 1] : null;
  const previous = index > 0 ? tokens[index - 1] : null;
  if (/^(?:[ivx]+|\d+)$/iu.test(next ?? "")) return next.toLowerCase();
  if (/^(?:[ivx]+|\d+)$/iu.test(previous ?? "")) return previous.toLowerCase();
  return null;
}

function romanStageVariants(stage) {
  const romanMap = new Map([
    ["1", "i"],
    ["2", "ii"],
    ["3", "iii"],
    ["4", "iv"],
    ["5", "v"],
    ["6", "vi"],
  ]);
  const reverse = new Map([...romanMap.entries()].map(([number, roman]) => [roman, number]));
  const variants = new Set([stage]);
  if (romanMap.has(stage)) variants.add(romanMap.get(stage));
  if (reverse.has(stage)) variants.add(reverse.get(stage));
  return [...variants].map((item) => normalizeForSearch(item));
}

function nextRomanStageRowIndex(normalized, start) {
  const pattern = /(?:^|\s)(?:[ivx]{1,5}|\d{1,2})(?:\s|$)/giu;
  pattern.lastIndex = start;
  const match = pattern.exec(normalized);
  return match?.index ?? -1;
}

function romanStageWindow(normalized, stage) {
  const stageCue = normalizeForSearch("\u0441\u0442\u0430\u0434\u0438\u044f");
  for (const variant of romanStageVariants(stage)) {
    const cues = [normalizeForSearch(`\u0441\u0442\u0430\u0434\u0438\u044f ${variant}`), normalizeForSearch(`${variant} \u0441\u0442\u0430\u0434\u0438\u044f`)];
    for (const cue of cues) {
      let index = -1;
      for (let start = 0; start < normalized.length; start += 1) {
        const found = normalized.indexOf(cue, start);
        if (found < 0) break;
        if (hasSearchBoundaries(normalized, found, cue.length)) {
          index = found;
          break;
        }
        start = found + cue.length;
      }
      if (index < 0) continue;
      let end = Math.min(normalized.length, index + 520);
      const nextStage = normalized.indexOf(stageCue, index + cue.length + 20);
      if (nextStage > 0) end = Math.min(end, nextStage);
      return normalized.slice(index, end);
    }
  }

  if (!normalized.includes(stageCue)) return null;
  for (const variant of romanStageVariants(stage)) {
    let start = 0;
    while (start < normalized.length) {
      const index = normalized.indexOf(variant, start);
      if (index < 0) break;
      if (!hasSearchBoundaries(normalized, index, variant.length)) {
        start = index + variant.length;
        continue;
      }
      const before = normalized.slice(Math.max(0, index - 220), index);
      if (!before.includes(stageCue)) {
        start = index + variant.length;
        continue;
      }
      const next = nextRomanStageRowIndex(normalized, index + variant.length + 1);
      const end = next > index ? Math.min(next, index + 420) : Math.min(normalized.length, index + 420);
      return normalized.slice(index, end);
    }
  }

  return null;
}

function bestRomanStageSupport({ mode, pages, question, answer, answerTokens }) {
  if (mode !== "single") return null;
  const stage = questionRomanStage(question);
  if (!stage) return null;
  const answerPhrases = answerSearchPhrases(answer.text).slice(0, 16);
  let best = null;

  for (const page of pages) {
    for (const source of cachedLineWindowSegments(page)) {
      const window = romanStageWindow(source.normalized, stage);
      if (!window) continue;
      const tokens = tokenizeNormalized(window);
      const answerCoverage = strictSoftCoverage(answerTokens, tokens);
      const phraseHit = answerPhrases.some((phrase) => containsNormalizedPhrase(window, phrase));
      if (!phraseHit && answerCoverage < 0.58) continue;
      const score = 12.8 + (phraseHit ? 2.4 : 0) + answerCoverage * 4.0 + numberCoverage(answer.text, window) * 0.8;
      best = betterEvidence(best, {
        answerId: answer.id,
        page: page.page,
        text: source.text,
        score,
        kind: "roman_stage_segment",
      });
    }
  }

  return best;
}

function answerOrdinalLabel(answerText) {
  const normalized = normalizeForSearch(answerText);
  const tokens = normalized.split(/\s+/u).filter(Boolean);
  const kinds = [
    { kind: "stage", cue: normalizeForSearch("\u0441\u0442\u0430\u0434\u0438") },
    { kind: "degree", cue: normalizeForSearch("\u0441\u0442\u0435\u043f\u0435\u043d") },
    { kind: "type", cue: normalizeForSearch("\u0442\u0438\u043f") },
  ];
  const kind = kinds.find((item) => tokens.some((token) => token.startsWith(item.cue)));
  if (!kind) return null;

  const values = new Set<number>();
  for (const match of normalized.matchAll(/(?:^|\s)(\d{1,2}|[ivx]{1,7})(?:\s|$)/giu)) {
    const number = ordinalValueToNumber(match[1]);
    if (number && number > 0 && number <= 10) values.add(number);
  }
  if (values.size !== 1) return null;
  return { kind: kind.kind, cue: kind.cue, number: [...values][0] };
}

function ordinalKindCue(kind) {
  if (kind === "stage") return normalizeForSearch("\u0441\u0442\u0430\u0434\u0438");
  if (kind === "degree") return normalizeForSearch("\u0441\u0442\u0435\u043f\u0435\u043d");
  if (kind === "type") return normalizeForSearch("\u0442\u0438\u043f");
  return normalizeForSearch("\u043a\u043b\u0430\u0441\u0441");
}

function hasOrdinalKindCue(normalized, kind) {
  const cue = ordinalKindCue(kind);
  return new RegExp(`(?:^|\\s)${escapeRegExp(cue)}\\S*(?:\\s|$)`, "iu").test(normalized);
}

function nextAnswerOrdinalIndex(normalized, start, label) {
  const cue = ordinalKindCue(label.kind);
  let best = -1;
  for (let number = 1; number <= 10; number += 1) {
    if (number === label.number) continue;
    for (const variant of romanStageVariants(String(number))) {
      const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(variant)}(?:\\s|-|$)`, "iu");
      const match = normalized.slice(start).match(pattern);
      if (!match?.index && match?.index !== 0) continue;
      const index = start + match.index;
      if (isRomanOneConjunctionMatch(normalized, index, variant)) continue;
      const before = normalized.slice(Math.max(0, index - 180), index);
      const after = normalized.slice(index, Math.min(normalized.length, index + 90));
      if (!hasOrdinalKindCue(before, label.kind) && !hasOrdinalKindCue(after, label.kind)) continue;
      if (best < 0 || index < best) best = index;
    }
  }
  return best;
}

function nearestTokenBefore(normalized, index) {
  const tokens = normalized.slice(0, index).trim().match(/\S+/gu) ?? [];
  return tokens[tokens.length - 1] ?? "";
}

function nearestTokenAfter(normalized, index, length) {
  const tokens = normalized.slice(index + length).trim().match(/\S+/gu) ?? [];
  return tokens[0] ?? "";
}

function isRomanOneConjunctionMatch(normalized, index, variant) {
  if (variant !== "i") return false;
  const before = ordinalValueToNumber(nearestTokenBefore(normalized, index));
  const after = ordinalValueToNumber(nearestTokenAfter(normalized, index, variant.length));
  return Boolean(before && after);
}

function answerOrdinalRowWindows(source, label) {
  const normalized = source.normalized;
  const cue = ordinalKindCue(label.kind);
  const windows = [];
  for (const variant of romanStageVariants(String(label.number))) {
    if (hasOrdinalKindCue(normalized, label.kind)) {
      const directPatterns = [
        new RegExp(`(?:^|\\s)${escapeRegExp(variant)}(?:\\s|$)(?:-?\\s*\\S{0,3}\\s+)?${escapeRegExp(cue)}`, "giu"),
        new RegExp(`${escapeRegExp(cue)}\\s+(?:\\S+\\s+){0,2}${escapeRegExp(variant)}(?:\\s|$)`, "giu"),
      ];
      for (const pattern of directPatterns) {
        for (const match of normalized.matchAll(pattern)) {
          const index = match.index ?? 0;
          if (isRomanOneConjunctionMatch(normalized, index, variant)) continue;
          const afterStart = index + match[0].length;
          const next = nextAnswerOrdinalIndex(normalized, afterStart + 8, label);
          const end = next > 0 ? next : Math.min(normalized.length, afterStart + 520);
          windows.push(normalized.slice(index, end));
        }
      }

      let start = 0;
      while (start < normalized.length) {
        const index = normalized.indexOf(variant, start);
        if (index < 0) break;
        if (!hasSearchBoundaries(normalized, index, variant.length)) {
          start = index + Math.max(1, variant.length);
          continue;
        }
        if (isRomanOneConjunctionMatch(normalized, index, variant)) {
          start = index + Math.max(1, variant.length);
          continue;
        }
        const before = normalized.slice(Math.max(0, index - 220), index);
        const after = normalized.slice(index, Math.min(normalized.length, index + 100));
        if (!hasOrdinalKindCue(before, label.kind) && !hasOrdinalKindCue(after, label.kind)) {
          start = index + Math.max(1, variant.length);
          continue;
        }
        const next = nextAnswerOrdinalIndex(normalized, index + variant.length + 8, label);
        const end = next > 0 ? next : Math.min(normalized.length, index + 520);
        windows.push(normalized.slice(index, end));
        start = index + Math.max(1, variant.length);
      }
    } else {
      const barePattern = new RegExp(`^\\s*${escapeRegExp(variant)}(?:\\s|$)`, "iu");
      const match = normalized.match(barePattern);
      if (match?.[0]) {
        windows.push(normalized.slice(0, Math.min(normalized.length, 520)));
      }
    }
  }
  return windows;
}

function ordinalRangeIncludesValue(normalized, label) {
  if (!hasOrdinalKindCue(normalized, label.kind)) return false;
  const number = label.number;
  const digitPatterns = [
    /(?:^|\s)(\d{1,2})\s*-\s*(\d{1,2})(?:\s|$)/giu,
    /(?:^|\s)(\d{1,2})\s*\/\s*(\d{1,2})(?:\s|$)/giu,
  ];
  for (const pattern of digitPatterns) {
    for (const match of normalized.matchAll(pattern)) {
      const left = Number(match[1]);
      const right = Number(match[2]);
      if (number >= Math.min(left, right) && number <= Math.max(left, right)) return true;
    }
  }
  const romanPattern = /(?:^|\s)(i|ii|iii|iv|v|vi|vii|viii|ix|x)\s*-\s*(i|ii|iii|iv|v|vi|vii|viii|ix|x)(?:\s|$)/giu;
  for (const match of normalized.matchAll(romanPattern)) {
    const left = ordinalValueToNumber(match[1]);
    const right = ordinalValueToNumber(match[2]);
    if (left && right && number >= Math.min(left, right) && number <= Math.max(left, right)) return true;
  }
  return false;
}

const ANSWER_ORDINAL_GENERIC_FOCUS = new Set(
  [
    "\u0441\u043e\u0433\u043b\u0430\u0441\u043d\u043e",
    "\u043a\u043b\u0430\u0441\u0441\u0438\u0444\u0438\u043a\u0430\u0446\u0438\u044f",
    "\u043a\u043b\u0430\u0441\u0441\u0438\u0444\u0438\u043a\u0430\u0446\u0438\u0438",
    "\u0445\u0430\u0440\u0430\u043a\u0442\u0435\u0440\u043d\u043e",
    "\u0445\u0430\u0440\u0430\u043a\u0442\u0435\u0440\u043d\u044b",
    "\u0441\u0442\u0430\u0434\u0438\u044f",
    "\u0441\u0442\u0430\u0434\u0438\u0438",
    "\u0441\u0442\u0435\u043f\u0435\u043d\u044c",
    "\u0441\u0442\u0435\u043f\u0435\u043d\u0438",
    "\u0442\u0438\u043f",
    "\u0442\u0438\u043f\u0430",
    "\u043a\u043b\u0430\u0441\u0441",
    "\u043a\u043b\u0430\u0441\u0441\u0430",
  ].flatMap((item) => uniqueTokens(item)),
);

function specificAnswerOrdinalFocusTokens(focusTokens, answerTokens) {
  const answerSet = new Set(answerTokens ?? []);
  return (focusTokens ?? []).filter(
    (token) => token.length >= 4 && !/^\d/.test(token) && !answerSet.has(token) && !ANSWER_ORDINAL_GENERIC_FOCUS.has(token),
  );
}

function orderedFocusPairHits(focusTokens, documentTokens) {
  if ((focusTokens?.length ?? 0) < 2 || !documentTokens?.length) return 0;
  const seen = new Set<string>();
  let hits = 0;
  for (let index = 0; index < focusTokens.length - 1; index += 1) {
    const left = focusTokens[index];
    const right = focusTokens[index + 1];
    if (!left || !right || left === right) continue;
    const key = `${left}\u0000${right}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (tokenSequenceIncludes(documentTokens, [left, right])) hits += 1;
  }
  return hits;
}

function bestAnswerOrdinalRowSupport({ mode, pages, topQuestionPages, answer, answerTokens, focusTokens }) {
  const label = answerOrdinalLabel(answer.text);
  if (!label) return null;
  const specificTokens = specificAnswerOrdinalFocusTokens(focusTokens, answerTokens);
  if (specificTokens.length < 2) return null;
  let best = null;

  for (const page of pages) {
    const nearTopPage =
      !topQuestionPages?.size || topQuestionPages.has(page.page) || topQuestionPages.has(page.page - 1) || topQuestionPages.has(page.page + 1);
    if (!nearTopPage) continue;
    const sources = [...cachedLineWindowSegments(page), { normalized: page.normalized, text: page.text }];
    for (const source of sources) {
      const windows = answerOrdinalRowWindows(source, label);
      if (mode === "multi" && ordinalRangeIncludesValue(source.normalized, label)) {
        windows.push(source.normalized);
      }
      for (const window of windows) {
        const tokens = tokenizeNormalized(window);
        const focusHits = tokenHitCount(specificTokens, tokens);
        if (focusHits < 2) continue;
        const focusCoverage = coverage(specificTokens, tokens);
        const pairHits = orderedFocusPairHits(specificTokens, tokens);
        const answerCoverage = strictSoftCoverage(answerTokens, tokens);
        const score =
          13.4 +
          Math.min(5, focusHits) * 1.45 +
          Math.min(0.7, focusCoverage) * 5.4 +
          Math.min(4, pairHits) * 1.8 +
          answerCoverage * 2.2 +
          (ordinalRangeIncludesValue(window, label) ? 1.0 : 0);
        best = betterEvidence(best, {
          answerId: answer.id,
          page: page.page,
          text: source.text,
          score,
          kind: "answer_ordinal_row",
        });
      }
    }
  }

  return best;
}

function scoreAnswer(context) {
  const anchor = bestAnchorSupport(context);
  const section = bestSectionSupport(context);
  const rowLabel = bestRowLabelSupport(context);
  const focused = bestFocusedSupport(context);
  const lineToken = lineTokenApplicable(context) ? bestLineTokenSupport(context) : null;
  const prefix = bestPrefixSupport(context);
  const phrase = bestPhraseSupport(context);
  const precedingLabel = bestPrecedingQuestionLabelSupport(context);
  const exactAnswer = bestExactAnswerSupport(context);
  const chunk = bestChunkSupport(context);
  const polarity = polarityAdjustment(context);
  const temporal = temporalCueAdjustment(context);
  const conditionPair = conditionPairAdjustment(context);
  const riskCondition = riskConditionAdjustment(context);
  const genericPopulation = genericPopulationConditionAdjustmentForMode(context);
  const classSubject = bestClassSubjectSupport(context);
  const frequency = bestFrequencyRecommendationSupport(context);
  const negativeLocal = { adjustment: 0, evidence: null };
  const boundedList = bestBoundedListSupport(context);
  const ordinalList = bestOrdinalListSupport(context);
  const typeOrdinal = bestTypeOrdinalSupport(context);
  const indicationLabel = bestIndicationSegmentSupport(context);
  const labelDefinition = bestLabelDefinitionSupport(context);
  const recommendationPolarity = recommendationPolarityAdjustment(context);
  const exactNumericOption = bestExactNumericOptionSupport(context);
  const exactHourAlias = bestExactHourAliasOptionSupport(context);
  const ageEligibility = ageEligibilityAdjustment(context);
  const drugDose = bestDrugDoseSupport(context);
  const termDefinition = bestTermDefinitionSupport(context);
  const frequencyPolarity = bestFrequencyPolaritySupport(context);
  const negatedAnswerPrefix = negatedAnswerPrefixAdjustment(context);
  const impossibilityOnly = impossibilityOnlyAdjustment(context);
  const activeTherapyIndication = activeTherapyIndicationAdjustment(context);
  const recommendationItem = bestRecommendationItemSupport(context);
  const explicitRecommendationTarget = explicitRecommendationTargetAdjustment(context);
  const conditionedNumber = bestConditionedNumberSupport(context);
  const numericCondition = bestNumericConditionSupport(context);
  const countRelation = context.config?.countRelationBoost ? bestCountRelationSupport(context) : null;
  const ageForm = bestAgeFormSupport(context);
  const fibrosisStage = bestFibrosisStageSupport(context);
  const conditionNumber = null;
  const romanStage = bestRomanStageSupport(context);
  const answerOrdinalRow = bestAnswerOrdinalRowSupport(context);
  const clozeGap = bestClozeGapSupport(context);
  const visualTableColumn = bestVisualTableColumnSupport(context);
  const coordinateTableRow = bestCoordinateTableRowSupport(context);
  const coordinateTableGroup = bestCoordinateTableGroupSupport(context);
  const coordinateMultiCellRow = bestCoordinateMultiCellRowSupport(context);
  const coordinateTableMembership = bestCoordinateTableMembershipSupport(context);
  const parentheticalGroup = bestParentheticalGroupSupport(context);
  const questionContinuationList = bestQuestionContinuationListSupport(context);
  const shortMedicalAlias = bestShortMedicalAliasSupport(context);
  const latinFuzzy = bestLatinFuzzySupport(context);
  const geneSentence = bestGeneSentenceSupport(context);
  const clinicalFeature = clinicalFeatureAdjustment(context);
  const mkbClassExclusion = bestMkbClassExclusionSupport(context);
  const labelNumber = bestLabelNumberSupport(context);
  const classificationCode = bestClassificationCodeSupport(context);
  const exactShortLabelRow = bestExactShortLabelRowSupport(context);
  const shortLabelRow = bestShortLabelRowSupport(context);
  const answerTokens = context.answerTokens;
  const numbers = extractNumbers(context.answer.text);
  const answerPhraseFound = phrase?.kind === "answer_window" || phrase?.kind === "answer_after_question" || phrase?.kind === "question_answer_phrase";
  const phraseWeight =
    phrase?.kind === "answer_window" ? 0.55 : phrase?.kind === "answer_directional_window" ? 0.95 : phrase ? 1.15 : 0;
  const focusedWeight = context.mode === "multi" ? 0.15 : 0.9;
  const lineTokenWeight = context.mode === "single" ? 0.85 : 0;
  const latinFuzzyWeight = context.mode === "multi" && polarity.evidence?.kind !== "polarity_mismatch" ? 1.15 : 0;
  let raw =
    (anchor?.score ?? 0) * 1.35 +
    (section?.score ?? 0) * 1.2 +
    (rowLabel?.score ?? 0) * 0.95 +
    (focused?.score ?? 0) * focusedWeight +
    (lineToken?.score ?? 0) * lineTokenWeight +
    (prefix?.score ?? 0) * 1.15 +
    (phrase?.score ?? 0) * phraseWeight +
    (precedingLabel?.score ?? 0) * 1.3 +
    (exactAnswer?.score ?? 0) * 1.08 +
    (chunk?.score ?? 0) * 1.0 +
    polarity.adjustment +
    (temporal.support?.score ?? 0) * 1.0 +
    temporal.adjustment +
    conditionPair.adjustment +
    riskCondition.adjustment +
    genericPopulation.adjustment +
    (classSubject?.score ?? 0) * 1.15 +
    (frequency?.score ?? 0) * 1.1 +
    negativeLocal.adjustment +
    (boundedList.support?.score ?? 0) * 1.15 +
    boundedList.adjustment +
    (ordinalList?.score ?? 0) * 1.15 +
    (typeOrdinal?.score ?? 0) * 1.15 +
    (indicationLabel?.score ?? 0) * 1.15 +
    (labelDefinition?.score ?? 0) * 1.15 +
    (recommendationPolarity.support?.score ?? 0) * 1.05 +
    recommendationPolarity.adjustment +
    (exactNumericOption?.score ?? 0) * 1.04 +
    (exactHourAlias?.score ?? 0) * 1.08 +
    ageEligibility.adjustment +
    (drugDose?.score ?? 0) * 1.15 +
    (termDefinition?.score ?? 0) * 1.15 +
    (frequencyPolarity?.score ?? 0) * 1.08 +
    negatedAnswerPrefix.adjustment +
    impossibilityOnly.adjustment +
    activeTherapyIndication.adjustment +
    (recommendationItem?.score ?? 0) * 1.1 +
    (explicitRecommendationTarget.support?.score ?? 0) * 1.05 +
    explicitRecommendationTarget.adjustment +
    (conditionedNumber?.score ?? 0) * 1.1 +
    (numericCondition?.score ?? 0) * 1.05 +
    (countRelation?.score ?? 0) * 1.1 +
    (ageForm?.score ?? 0) * 1.15 +
    (fibrosisStage?.score ?? 0) * 1.15 +
    (conditionNumber?.score ?? 0) * 1.15 +
    (romanStage?.score ?? 0) * 1.15 +
    (answerOrdinalRow?.score ?? 0) * 1.15 +
    (clozeGap?.score ?? 0) * 1.12 +
    (visualTableColumn?.score ?? 0) * 1.18 +
    (coordinateTableRow?.score ?? 0) * 1.12 +
    (coordinateTableGroup?.score ?? 0) * 1.16 +
    (coordinateMultiCellRow?.score ?? 0) * 1.16 +
    (coordinateTableMembership?.score ?? 0) * 1.1 +
    (parentheticalGroup?.score ?? 0) * 1.16 +
    (questionContinuationList?.score ?? 0) * 1.1 +
    (shortMedicalAlias?.score ?? 0) * 0.35 +
    (latinFuzzy?.score ?? 0) * latinFuzzyWeight +
    (geneSentence?.score ?? 0) * 1.18 +
    (clinicalFeature.support?.score ?? 0) * 1.12 +
    clinicalFeature.adjustment +
    (mkbClassExclusion.support?.score ?? 0) * 1.12 +
    mkbClassExclusion.adjustment +
    (labelNumber?.score ?? 0) * 1.15 +
    (classificationCode?.score ?? 0) * 1.15 +
    (exactShortLabelRow?.score ?? 0) * 1.2 +
    (shortLabelRow?.score ?? 0) * 1.15 +
    (answerPhraseFound ? 0.35 : 0) +
    (numbers.length ? numberSpecificity(context.answer.text) * 0.35 : 0) +
    Math.min(0.35, answerTokens.length * 0.015);
  if (context.intent.listLike && context.anchorSegments?.length && !anchor) {
    raw *= 0.62;
  }
  if (context.intent.listLike && context.sectionSegments?.length && !section) {
    raw *= 0.72;
  }

  let evidence = [
    anchor,
    section,
    rowLabel,
    focused,
    lineToken,
    prefix,
    phrase,
    precedingLabel,
    exactAnswer,
    chunk,
    polarity.evidence,
    temporal.support,
    temporal.evidence,
    conditionPair.evidence,
    riskCondition.evidence,
    genericPopulation.evidence,
    classSubject,
    frequency,
    negativeLocal.evidence,
    boundedList.support,
    boundedList.evidence,
    ordinalList,
    typeOrdinal,
    indicationLabel,
    labelDefinition,
    recommendationPolarity.support,
    recommendationPolarity.evidence,
    exactNumericOption,
    exactHourAlias,
    ageEligibility.evidence,
    drugDose,
    termDefinition,
    frequencyPolarity,
    negatedAnswerPrefix.evidence,
    impossibilityOnly.evidence,
    activeTherapyIndication.evidence,
    recommendationItem,
    explicitRecommendationTarget.support,
    explicitRecommendationTarget.evidence,
    conditionedNumber,
    numericCondition,
    countRelation,
    ageForm,
    fibrosisStage,
    conditionNumber,
    romanStage,
    answerOrdinalRow,
    clozeGap,
    visualTableColumn,
    coordinateTableRow,
    coordinateTableGroup,
    coordinateMultiCellRow,
    coordinateTableMembership,
    parentheticalGroup,
    questionContinuationList,
    shortMedicalAlias,
    latinFuzzy,
    geneSentence,
    clinicalFeature.support,
    clinicalFeature.evidence,
    mkbClassExclusion.support,
    mkbClassExclusion.evidence,
    labelNumber,
    classificationCode,
    exactShortLabelRow,
    shortLabelRow,
  ].filter(Boolean);
  const contrastCue = contrastCueMismatchAdjustment(context, evidence.sort((a, b) => b.score - a.score));
  raw += contrastCue.adjustment;
  if (contrastCue.evidence) evidence.push(contrastCue.evidence);
  if (context.config?.optionFamilyComparatorGuard) {
    const optionFamilyComparator = optionFamilyComparatorAdjustment({ answer: context.answer, answers: context.answers, evidence });
    raw += optionFamilyComparator.adjustment;
    if (optionFamilyComparator.evidence) evidence.push(optionFamilyComparator.evidence);
  }
  if (context.config?.optionFamilyCompactComboGuard) {
    const optionFamilyCompactCombo = optionFamilyCompactComboAdjustment({ question: context.question, answer: context.answer, evidence });
    raw += optionFamilyCompactCombo.adjustment;
    if (optionFamilyCompactCombo.evidence) evidence.push(optionFamilyCompactCombo.evidence);
  }
  const excludedCondition = excludedConditionMismatchAdjustment(context, evidence.sort((a, b) => b.score - a.score));
  raw += excludedCondition.adjustment;
  if (excludedCondition.evidence) evidence.push(excludedCondition.evidence);
  evidence = evidence.sort((a, b) => b.score - a.score);
  return { raw, evidence };
}

/**
 * Запускает локальный non-LLM predictor для выбора ответа.
 *
 * Predictor получает источник PDF, текст вопроса, варианты ответа и режим
 * (`single` или `multi`). Он извлекает или переиспользует текст PDF, считает
 * score для каждого варианта по документу и возвращает id выбранных ответов
 * вместе с evidence-фрагментами.
 *
 * Runtime использует только данные, переданные вызывающим кодом.
 *
 * @param input Запрос с PDF-данными/путем/URL, вопросом, ответами и режимом.
 * @param options Необязательные runtime-зависимости, например явный модуль PDF.js.
 * @returns ID выбранных ответов, калиброванные score, raw score, evidence и метаданные.
 */
export async function predict(input, options: any = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };
  const pdfInput = input.pdfData ?? input.pdfBuffer ?? input.pdf ?? input.file ?? input.blob ?? input.pdfUrl ?? input.url ?? input.pdfPath;
  if (!pdfInput) throw new Error("predict input requires pdfData, pdfUrl, file/blob, or pdfPath-compatible data");
  const mode = input.mode === "multi" ? "multi" : "single";
  const answers = normalizeAnswers(input.answers ?? input.variants ?? []);
  if (!answers.length) throw new Error("predict input requires answers");

  const runtime = await getPdfRuntime(pdfInput, {
    cacheKey: input.cacheKey ?? input.pdfPath ?? input.pdfUrl ?? input.url,
    pdfjsLib: options.pdfjsLib,
    pdfVerbosity: options.pdfVerbosity,
  });
  const question = String(input.question ?? "");
  const questionTokens = uniqueTokens(question);
  const focusTokens = questionFocusTokens(question);
  const intent = detectQuestionIntent(question);
  const anchorSegments = findAnchorSegments(runtime.pdfText.pages, question);
  const sectionSegments = findSectionSegments(runtime.pdfText.pages, question);
  const topQuestionPages = new Set(runtime.index.search(questionTokens, { limit: 6 }).map((result) => result.chunk.page));
  const rowSegments = findRowSegments(runtime.pdfText.pages, question, topQuestionPages);
  const boundedListSegments = findBoundedListSegments(runtime.pdfText.pages, question, topQuestionPages, mode, intent);
  const visualTableColumnTargetsByPage =
    mode === "multi" && hasVisualTableColumnCue(question, focusTokens)
      ? buildVisualTableColumnTargetsByPage(runtime.pdfText.pages, question, focusTokens, topQuestionPages)
      : null;
  const coordinateTableRowsByPage = hasCoordinateTableCue(question, focusTokens)
    ? buildCoordinateTableRowsByPage(runtime.pdfText.pages, topQuestionPages)
    : null;
  const coordinateTableGroupsByPage =
    mode === "multi" && hasCoordinateTableGroupCue(question, focusTokens, intent)
      ? buildCoordinateTableGroupsByPage(runtime.pdfText.pages, topQuestionPages)
      : null;
  const coordinateMultiCellRowsByPage =
    mode === "multi" && hasCoordinateTableGroupCue(question, focusTokens, intent)
      ? buildCoordinateMultiCellRowsByPage(runtime.pdfText.pages, topQuestionPages)
      : null;
  const coordinateTableMembershipsByPage =
    mode === "multi" && hasCoordinateTableGroupCue(question, focusTokens, intent)
      ? buildCoordinateTableMembershipsByPage(runtime.pdfText.pages, topQuestionPages)
      : null;

  let answerScores = answers.map((answer) => {
    const answerTokens = uniqueTokens(answer.text);
    const result = scoreAnswer({
      pages: runtime.pdfText.pages,
      chunks: runtime.chunks,
      index: runtime.index,
      config,
      mode,
      question,
      answer,
      answers,
      questionTokens,
      topQuestionPages,
      focusTokens,
      answerTokens,
      intent,
      anchorSegments,
      sectionSegments,
      rowSegments,
      boundedListSegments,
      visualTableColumnTargetsByPage,
      coordinateTableRowsByPage,
      coordinateTableGroupsByPage,
      coordinateMultiCellRowsByPage,
      coordinateTableMembershipsByPage,
    });
    return {
      answer,
      raw: result.raw,
      evidence: result.evidence,
    };
  });
  if (mode === "multi" && config.sharedMultiSegmentBoost) {
    answerScores = addSharedMultiSegmentSupport(answerScores, intent, question);
  }
  answerScores = applyGeneSentenceSetSupport(answerScores, mode, question);
  if (mode === "single" && questionDefinitionLabel(question) && answerScores.some((item) => item.evidence.some((evidenceItem) => evidenceItem.kind === "label_definition_segment"))) {
    answerScores = answerScores.map((item) =>
      item.evidence.some((evidenceItem) => evidenceItem.kind === "label_definition_segment") ? item : { ...item, raw: item.raw * 0.48 },
    );
  }
  if (mode === "multi" && answerScores.some((item) => item.evidence.some((evidenceItem) => evidenceItem.kind === "latin_fuzzy_ocr"))) {
    answerScores = answerScores.map((item) => {
      const hasLatin = latinAnswerTokens(item.answer.text).length > 0;
      const hasLatinSupport = item.evidence.some((evidenceItem) => evidenceItem.kind === "latin_fuzzy_ocr" || evidenceItem.kind === "gene_sentence_segment");
      return hasLatin && !hasLatinSupport ? { ...item, raw: item.raw * 0.68 } : item;
    });
  }
  answerScores = applyFrozenFeatureRanker(answerScores, mode, config, { question });

  const calibrated = calibrateScores(answerScores);
  const selected = selectAnswers(calibrated, mode, config);
  const confidence = predictionConfidence(calibrated, selected, mode);
  const scores = Object.fromEntries(calibrated.map((item) => [item.answer.id, item.score]));
  const rawScores = Object.fromEntries(calibrated.map((item) => [item.answer.id, round4(item.raw)]));
  const evidence = calibrated
    .flatMap((item) => item.evidence.map((evidenceItem) => ({ ...evidenceItem, answerId: item.answer.id, score: round4(evidenceItem.score) })))
    .sort((a, b) => b.score - a.score)
    .slice(0, config.evidenceLimit);
  const diagnostics = options.diagnostics ? { answerEvidence: buildAnswerEvidenceDiagnostics(calibrated) } : undefined;

  return {
    selected,
    mode,
    confidence: round4(confidence),
    scores,
    rawScores,
    evidence,
    ...(diagnostics ? { diagnostics } : {}),
    meta: {
      pageCount: runtime.pdfText.pageCount,
      chunks: runtime.chunks.length,
      ocrNeeded: runtime.pdfText.ocrNeeded,
      intent,
    },
  };
}

const CONFIDENCE_STRUCTURAL_KINDS = new Set([
  "coordinate_table_row",
  "coordinate_table_group",
  "coordinate_table_group_inverse",
  "coordinate_table_multicell_row",
  "coordinate_table_membership",
  "parenthetical_group_segment",
  "preceding_question_label",
  "question_continuation_list",
  "exact_numeric_option_segment",
  "exact_hour_alias_segment",
  "visual_table_column",
  "exact_short_label_visual_row",
  "short_label_visual_row",
  "answer_ordinal_row",
  "fibrosis_stage_row",
  "gene_sentence_segment",
  "clinical_feature_segment",
  "mkb_class_exclusion_absent",
  "classification_code_segment",
  "label_number_proximity",
  "label_definition_segment",
  "row_label_segment",
  "bounded_list_segment",
  "ordinal_list_segment",
  "drug_dose_segment",
  "frequency_polarity_segment",
  "frequency_polarity_list_item",
  "recommendation_item_segment",
  "explicit_recommendation_target_segment",
  "numeric_condition_less_than",
  "numeric_condition_more_than",
  "numeric_condition_equal",
  "conditioned_number_segment",
  "cloze_gap_local",
]);

const CONFIDENCE_BROAD_KINDS = new Set(["bm25_question_answer", "question_chunk_answer", "answer_chunk_question", "answer_window", "focused_answer_window", "shared_multi_segment"]);

function confidenceEvidenceSummary(item) {
  let bestScore = 0;
  let bestKind = "";
  let structuralScore = 0;
  let broadCount = 0;
  for (const evidence of item.evidence ?? []) {
    const score = Number(evidence.score ?? 0);
    if (score > bestScore) {
      bestScore = score;
      bestKind = String(evidence.kind ?? "");
    }
    if (CONFIDENCE_STRUCTURAL_KINDS.has(evidence.kind)) structuralScore = Math.max(structuralScore, score);
    if (CONFIDENCE_BROAD_KINDS.has(evidence.kind)) broadCount += 1;
  }
  return {
    bestScore,
    bestKind,
    structuralScore,
    hasStructural: structuralScore > 0,
    broadOnly: broadCount > 0 && structuralScore <= 0,
  };
}

function clampConfidence(value) {
  return Math.max(0.05, Math.min(0.99, value));
}

/**
 * Считает итоговую уверенность прогноза без влияния на выбор ответа.
 *
 * Selection по-прежнему использует raw score. Этот слой только снижает
 * confidence, когда выбранный набор держится на плоском поисковом evidence,
 * близкой границе между выбранными и невыбранными вариантами или плотной
 * multi-семье без структурной поддержки.
 */
function predictionConfidence(calibrated, selected, mode) {
  const selectedScores = selected.map((id) => calibrated.find((item) => item.answer.id === id)?.score ?? 0);
  let confidence = mode === "single" ? Math.max(...selectedScores, 0) : selectedScores.reduce((sum, score) => sum + score, 0) / (selectedScores.length || 1);
  const sorted = [...calibrated].sort((a, b) => b.raw - a.raw);
  const selectedSet = new Set(selected);
  const selectedItems = calibrated.filter((item) => selectedSet.has(item.answer.id));
  const selectedSummaries = selectedItems.map(confidenceEvidenceSummary);

  const broadOnlySelected = selectedSummaries.filter((summary) => summary.broadOnly).length;
  const structuralSelected = selectedSummaries.filter((summary) => summary.hasStructural).length;
  const selectedCount = Math.max(1, selectedItems.length);

  let penalty = 0;
  if (broadOnlySelected) penalty += Math.min(0.16, 0.045 * broadOnlySelected);
  if (!structuralSelected && selectedItems.length) penalty += mode === "multi" ? 0.055 : 0.035;

  if (mode === "single") {
    const top = sorted[0];
    const second = sorted[1];
    if (top && second) {
      const gap = top.raw - second.raw;
      if (gap < 0.35) penalty += 0.095;
      else if (gap < 0.85) penalty += 0.06;
      else if (gap < 1.5) penalty += 0.03;
      const topSummary = confidenceEvidenceSummary(top);
      if (topSummary.broadOnly && gap < 2.2) penalty += 0.045;
    }
  } else {
    const selectedRaw = selectedItems.map((item) => item.raw);
    const unselectedRaw = calibrated.filter((item) => !selectedSet.has(item.answer.id)).map((item) => item.raw);
    const minSelected = selectedRaw.length ? Math.min(...selectedRaw) : 0;
    const maxUnselected = unselectedRaw.length ? Math.max(...unselectedRaw) : 0;
    const boundaryGap = minSelected - maxUnselected;
    if (boundaryGap < 0.2) penalty += 0.095;
    else if (boundaryGap < 0.7) penalty += 0.06;
    else if (boundaryGap < 1.4) penalty += 0.03;
    if (selected.length >= calibrated.length - 1 && calibrated.length >= 4 && !structuralSelected) penalty += 0.04;
    penalty += Math.min(0.08, (broadOnlySelected / selectedCount) * 0.07);
  }

  const structuralBonus = structuralSelected ? Math.min(0.035, selectedSummaries.reduce((sum, summary) => sum + Math.min(18, summary.structuralScore), 0) / selectedCount / 600) : 0;
  return clampConfidence(confidence - penalty + structuralBonus);
}

function buildAnswerEvidenceDiagnostics(calibrated) {
  return Object.fromEntries(
    calibrated.map((item) => {
      const kindCounts = {};
      const kindBestScores = {};
      const pages = new Set();
      let bestEvidenceScore = 0;

      for (const evidenceItem of item.evidence ?? []) {
        const kind = String(evidenceItem.kind ?? "unknown");
        const score = Number(evidenceItem.score ?? 0);
        kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
        kindBestScores[kind] = round4(Math.max(kindBestScores[kind] ?? 0, score));
        bestEvidenceScore = Math.max(bestEvidenceScore, score);
        if (Number.isFinite(evidenceItem.page)) pages.add(evidenceItem.page);
      }

      return [
        item.answer.id,
        {
          evidenceCount: item.evidence?.length ?? 0,
          uniqueEvidencePages: pages.size,
          bestEvidenceScore: round4(bestEvidenceScore),
          kindCounts,
          kindBestScores,
          refs: (item.evidence ?? []).map((evidenceItem) => ({
            page: Number.isFinite(evidenceItem.page) ? evidenceItem.page : 0,
            kind: String(evidenceItem.kind ?? "unknown"),
            score: round4(Number(evidenceItem.score ?? 0)),
          })),
        },
      ];
    }),
  );
}

/**
 * Очищает in-memory кеши predictor, включая кешированный текст PDF и runtime-состояние.
 */
export function clearPredictorCache() {
  clearPdfRuntimeCache();
}
