import { extractNumbers, normalizeForSearch, normalizeText, uniqueTokens } from "../../normalize.js";
import { FOCUS_STOPWORDS } from "../constants.js";
import { answerSearchPhrases, betterEvidence, containsNormalizedPhrase, numberCoverage, strictSoftCoverage, tokenizeNormalized } from "../text-utils.js";

const RECOMMENDATION_QUESTION_GENERIC = new Set(
  [
    "\u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434\u0443\u0435\u0442\u0441\u044f",
    "\u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434\u043e\u0432\u0430\u043d\u043e",
    "\u043f\u0430\u0446\u0438\u0435\u043d\u0442\u0430\u043c",
    "\u043f\u0430\u0446\u0438\u0435\u043d\u0442\u043e\u0432",
    "\u043f\u0430\u0446\u0438\u0435\u043d\u0442\u044b",
    "\u043f\u0440\u0438",
    "\u0434\u043b\u044f",
    "\u0441",
    "\u0438",
    "\u0443",
    "\u044f\u0432\u043b\u044f\u044e\u0442\u0441\u044f",
    "\u043f\u0440\u0435\u043f\u0430\u0440\u0430\u0442\u0430\u043c\u0438",
    "\u043f\u0435\u0440\u0432\u043e\u0439",
    "\u043b\u0438\u043d\u0438\u0438",
  ].flatMap((item) => uniqueTokens(item)),
);

const RECOMMENDATION_TARGET_GENERIC = new Set(
  [
    "\u043d\u0430\u0437\u043d\u0430\u0447\u0435\u043d\u0438\u0435",
    "\u043d\u0430\u0437\u043d\u0430\u0447",
    "\u043f\u0440\u043e\u0432\u0435\u0434",
    "\u043f\u0440\u043e\u0432\u043e\u0434",
    "\u0432\u044b\u043f\u043e\u043b\u043d",
    "\u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434",
    "\u043f\u0430\u0446\u0438\u0435\u043d\u0442",
    "\u043f\u0430\u0446\u0438\u0435\u043d\u0442\u0430\u043c",
    "\u043f\u0430\u0446\u0438\u0435\u043d\u0442\u043e\u0432",
    "\u043f\u0440\u0435\u043f\u0430\u0440\u0430\u0442",
    "\u043b\u0435\u043a\u0430\u0440\u0441\u0442\u0432",
    "\u0441",
    "\u043f\u0440\u0438",
    "\u0434\u043b\u044f",
    "\u0438",
  ].flatMap((item) => uniqueTokens(item)),
);

function recommendationItemQuestion(question) {
  const normalized = normalizeForSearch(question);
  const firstLineTherapy = containsNormalizedPhrase(normalized, "\u043f\u0435\u0440\u0432\u043e\u0439 \u043b\u0438\u043d\u0438\u0438");
  const valveProsthesisChoice =
    containsNormalizedPhrase(normalized, "\u043f\u0440\u043e\u0442\u0435\u0437") &&
    containsNormalizedPhrase(normalized, "\u043a\u043b\u0430\u043f") &&
    (containsNormalizedPhrase(normalized, "\u0431\u0438\u043e\u043b\u043e\u0433") || containsNormalizedPhrase(normalized, "\u043c\u0435\u0445\u0430\u043d"));
  const universalInstrumental =
    containsNormalizedPhrase(normalized, "\u0432\u0441\u0435\u043c \u043f\u0430\u0446\u0438\u0435\u043d\u0442") &&
    ((containsNormalizedPhrase(normalized, "\u043f\u0435\u0440\u0432\u0438\u0447") && containsNormalizedPhrase(normalized, "\u0441\u0442\u0430\u0434")) ||
      (containsNormalizedPhrase(normalized, "\u0434\u0438\u043d\u0430\u043c\u0438\u0447") && containsNormalizedPhrase(normalized, "\u044d\u0444\u0444\u0435\u043a\u0442")));
  return firstLineTherapy || valveProsthesisChoice || universalInstrumental;
}

function recommendationQuestionTokens(question) {
  return uniqueTokens(question).filter((token) => token.length >= 4 && !FOCUS_STOPWORDS.has(token) && !RECOMMENDATION_QUESTION_GENERIC.has(token));
}

function isPageNumberOnly(line) {
  return /^\s*\d+\s*$/u.test(String(line ?? ""));
}

function startsBullet(line) {
  return /^\s*[•*\-]\s*/u.test(String(line ?? ""));
}

function recommendationLineStart(line) {
  if (isPageNumberOnly(line)) return false;
  const normalized = normalizeForSearch(line);
  return (
    startsBullet(line) ||
    containsNormalizedPhrase(normalized, "\u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434") ||
    containsNormalizedPhrase(normalized, "\u043f\u0435\u0440\u0432\u043e\u0439 \u043b\u0438\u043d\u0438\u0438")
  );
}

function recommendationBoundaryLine(line, isFirstLine) {
  if (isPageNumberOnly(line)) return true;
  if (!isFirstLine && startsBullet(line)) return true;
  const normalized = normalizeForSearch(line);
  return (
    /^e\s*o?k\b/iu.test(normalized) ||
    normalized.startsWith("eok") ||
    normalized.startsWith("ypobeh") ||
    containsNormalizedPhrase(normalized, "\u0443\u0443\u0440") ||
    containsNormalizedPhrase(normalized, "\u0443\u0434\u0434")
  );
}

function collectRecommendationSegment(pages, pageIndex, lineIndex) {
  const lines = [];
  for (let currentPageIndex = pageIndex; currentPageIndex < Math.min(pages.length, pageIndex + 2); currentPageIndex += 1) {
    const page = pages[currentPageIndex];
    const pageLines = page.lines ?? [];
    const startLine = currentPageIndex === pageIndex ? lineIndex : 0;
    for (let index = startLine; index < pageLines.length && lines.length < 12; index += 1) {
      const line = pageLines[index];
      if (recommendationBoundaryLine(line, currentPageIndex === pageIndex && index === lineIndex)) {
        if (!isPageNumberOnly(line)) return lines.join(" ");
        continue;
      }
      lines.push(line);
    }
    if (lines.length >= 12) break;
    const nextPage = pages[currentPageIndex + 1];
    if (!nextPage?.lines?.length || startsBullet(nextPage.lines[0])) break;
  }
  return lines.join(" ");
}

function recommendationSegments(pages) {
  const segments = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];
    const lines = page.lines ?? [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      if (!recommendationLineStart(lines[lineIndex])) continue;
      const text = collectRecommendationSegment(pages, pageIndex, lineIndex).replace(/\s+/gu, " ").trim();
      if (text.length < 24) continue;
      segments.push({
        page: page.page,
        text,
        normalized: normalizeForSearch(text),
      });
    }
  }
  return segments;
}

function explicitRecommendationLineStart(line) {
  if (isPageNumberOnly(line)) return false;
  const normalized = normalizeForSearch(line);
  return containsNormalizedPhrase(normalized, "\u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434\u043e\u0432\u0430") || containsNormalizedPhrase(normalized, "\u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434\u0443");
}

function collectExplicitRecommendationBlock(pages, pageIndex, lineIndex) {
  const lines = [];
  for (let currentPageIndex = pageIndex; currentPageIndex < Math.min(pages.length, pageIndex + 2); currentPageIndex += 1) {
    const page = pages[currentPageIndex];
    const pageLines = page.lines ?? [];
    const startLine = currentPageIndex === pageIndex ? lineIndex : 0;
    for (let index = startLine; index < pageLines.length && lines.length < 22; index += 1) {
      const line = pageLines[index];
      if (isPageNumberOnly(line)) continue;
      if (!(currentPageIndex === pageIndex && index === lineIndex) && explicitRecommendationLineStart(line)) {
        return lines.join(" ");
      }
      lines.push(line);
    }
    if (lines.length >= 22) break;
  }
  return lines.join(" ");
}

function explicitRecommendationSegments(pages) {
  const segments = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];
    const lines = page.lines ?? [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      if (!explicitRecommendationLineStart(lines[lineIndex])) continue;
      const text = collectExplicitRecommendationBlock(pages, pageIndex, lineIndex).replace(/\s+/gu, " ").trim();
      if (text.length < 24) continue;
      segments.push({
        page: page.page,
        text,
        normalized: normalizeForSearch(text),
      });
    }
  }
  return segments;
}

function recommendationSubjectCompatible(questionNorm, segmentNorm) {
  const questionBiological = containsNormalizedPhrase(questionNorm, "\u0431\u0438\u043e\u043b\u043e\u0433");
  const questionMechanical = containsNormalizedPhrase(questionNorm, "\u043c\u0435\u0445\u0430\u043d");
  const segmentBiological = containsNormalizedPhrase(segmentNorm, "\u0431\u0438\u043e\u043b\u043e\u0433");
  const segmentMechanical = containsNormalizedPhrase(segmentNorm, "\u043c\u0435\u0445\u0430\u043d");
  if (questionBiological && segmentMechanical && !segmentBiological) return false;
  if (questionMechanical && segmentBiological && !segmentMechanical) return false;
  if (questionBiological && !segmentBiological) return false;
  if (questionMechanical && !segmentMechanical) return false;
  if (containsNormalizedPhrase(questionNorm, "\u043f\u0435\u0440\u0432\u043e\u0439 \u043b\u0438\u043d\u0438\u0438") && !containsNormalizedPhrase(segmentNorm, "\u043f\u0435\u0440\u0432\u043e\u0439 \u043b\u0438\u043d\u0438\u0438")) {
    return false;
  }
  return true;
}

function recommendationQuestionCoverage(questionNorm, questionTokens, segmentNorm) {
  const segmentTokens = tokenizeNormalized(segmentNorm);
  let coverageScore = strictSoftCoverage(questionTokens, segmentTokens);
  const valveProsthesisQuestion =
    containsNormalizedPhrase(questionNorm, "\u043f\u0440\u043e\u0442\u0435\u0437") &&
    containsNormalizedPhrase(questionNorm, "\u0430\u043e\u0440\u0442") &&
    containsNormalizedPhrase(questionNorm, "\u043a\u043b\u0430\u043f");
  if (valveProsthesisQuestion && containsNormalizedPhrase(segmentNorm, "\u041f\u0410\u041a")) coverageScore = Math.max(coverageScore, 0.58);
  return coverageScore;
}

function recommendationAnswerWindow(questionNorm, segmentNorm) {
  if (containsNormalizedPhrase(questionNorm, "\u0434\u0438\u043b\u0430\u0442\u0430\u0446")) {
    const withoutDilation = segmentNorm.indexOf(normalizeForSearch("\u0431\u0435\u0437 \u0434\u0438\u043b\u0430\u0442\u0430\u0446"));
    if (withoutDilation > 80) return segmentNorm.slice(0, withoutDilation);
  }
  return segmentNorm;
}

function recommendationAliasSupport(answerText, segmentNorm) {
  const answerNorm = normalizeForSearch(answerText);
  let support = 0;
  if (
    containsNormalizedPhrase(answerNorm, "\u0438\u043d\u0433\u0438\u0431") &&
    containsNormalizedPhrase(answerNorm, "\u0430\u043f\u0444") &&
    containsNormalizedPhrase(segmentNorm, "\u0438\u0410\u041f\u0424")
  ) {
    support = Math.max(support, 0.98);
  }
  if (
    containsNormalizedPhrase(answerNorm, "\u0431\u0435\u0442\u0430") &&
    containsNormalizedPhrase(answerNorm, "\u0430\u0434\u0440\u0435\u043d\u043e") &&
    containsNormalizedPhrase(answerNorm, "\u0431\u043b\u043e\u043a") &&
    containsNormalizedPhrase(segmentNorm, "\u0431\u0435\u0442\u0430")
  ) {
    support = Math.max(support, 0.96);
  }
  return support;
}

function anticoagulationContraPolarity(normalized) {
  if (!containsNormalizedPhrase(normalized, "\u0430\u043d\u0442\u0438\u043a\u043e\u0430\u0433")) return null;
  const contra = normalizeForSearch("\u043f\u0440\u043e\u0442\u0438\u0432\u043e\u043f\u043e\u043a\u0430\u0437");
  let start = 0;
  while (start < normalized.length) {
    const index = normalized.indexOf(contra, start);
    if (index < 0) break;
    const before = normalized.slice(Math.max(0, index - 58), index);
    if (containsNormalizedPhrase(before, "\u043e\u0442\u0441\u0443\u0442")) return "absence";
    if (containsNormalizedPhrase(before, "\u043d\u0430\u043b\u0438\u0447")) return "presence";
    start = index + contra.length;
  }
  return null;
}

function recommendationPresenceMismatch(answerText, segmentNorm) {
  const answerNorm = normalizeForSearch(answerText);
  const answerContraPolarity = anticoagulationContraPolarity(answerNorm);
  const segmentContraPolarity = anticoagulationContraPolarity(segmentNorm);
  if (answerContraPolarity && segmentContraPolarity && answerContraPolarity !== segmentContraPolarity) return true;
  if (containsNormalizedPhrase(answerNorm, "\u043e\u043f\u0442\u0438\u043c") && !containsNormalizedPhrase(segmentNorm, "\u043e\u043f\u0442\u0438\u043c")) return true;
  if (
    (containsNormalizedPhrase(answerNorm, "\u043c\u0435\u043d\u044c\u0448") || containsNormalizedPhrase(answerNorm, "\u043d\u0438\u0436\u0435")) &&
    !containsNormalizedPhrase(segmentNorm, "\u043c\u0435\u043d\u044c\u0448") &&
    !containsNormalizedPhrase(segmentNorm, "\u043d\u0438\u0436\u0435")
  ) {
    return true;
  }
  const answerAbsence = containsNormalizedPhrase(answerNorm, "\u043e\u0442\u0441\u0443\u0442\u0441\u0442");
  const answerPresence = containsNormalizedPhrase(answerNorm, "\u043d\u0430\u043b\u0438\u0447");
  const segmentAbsence = containsNormalizedPhrase(segmentNorm, "\u043e\u0442\u0441\u0443\u0442\u0441\u0442");
  const segmentPresence = containsNormalizedPhrase(segmentNorm, "\u043d\u0430\u043b\u0438\u0447");
  const contra = containsNormalizedPhrase(answerNorm, "\u043f\u0440\u043e\u0442\u0438\u0432\u043e\u043f\u043e\u043a\u0430\u0437") || containsNormalizedPhrase(segmentNorm, "\u043f\u0440\u043e\u0442\u0438\u0432\u043e\u043f\u043e\u043a\u0430\u0437");
  if (contra && answerAbsence && segmentPresence && !segmentAbsence) return true;
  if (contra && answerPresence && segmentAbsence && !segmentPresence) return true;
  return false;
}

function appointmentTargetTokens(question) {
  const normalized = normalizeText(question);
  const cues = [
    "\u043d\u0430\u0437\u043d\u0430\u0447\u0435\u043d\u0438\u0435",
    "\u043f\u0440\u043e\u0432\u0435\u0434\u0435\u043d\u0438\u0435",
    "\u043f\u0440\u043e\u0432\u043e\u0434\u0438\u0442\u044c",
    "\u0432\u044b\u043f\u043e\u043b\u043d\u0435\u043d\u0438\u0435",
  ].map((item) => normalizeText(item));
  let cue = "";
  let cueIndex = -1;
  for (const candidate of cues) {
    const index = normalized.indexOf(candidate);
    if (index >= 0 && (cueIndex < 0 || index < cueIndex)) {
      cue = candidate;
      cueIndex = index;
    }
  }
  if (cueIndex < 0) return [];
  const tail = normalized.slice(cueIndex + cue.length).trim();
  const boundaryCues = [
    "\u0441 \u0446\u0435\u043b\u044c\u044e",
    "\u0432 \u0434\u043e\u0437",
    "\u0432 \u043a\u0430\u0447\u0435\u0441\u0442\u0432",
    "\u043f\u0440\u0438 \u043d\u0430\u043b\u0438\u0447",
    "\u043f\u0430\u0446\u0438\u0435\u043d\u0442",
  ].map((item) => normalizeText(item));
  let end = tail.length;
  for (const boundary of boundaryCues) {
    const index = tail.indexOf(boundary);
    if (index > 0) end = Math.min(end, index);
  }
  return uniqueTokens(tail.slice(0, end))
    .filter((token) => token.length >= 4 && !FOCUS_STOPWORDS.has(token) && !RECOMMENDATION_TARGET_GENERIC.has(token))
    .slice(0, 7);
}

function targetCoverage(targetTokens, segmentTokens) {
  if (!targetTokens.length) return 0;
  return strictSoftCoverage(targetTokens, segmentTokens);
}

function appointmentContextTokens(question, targetTokens) {
  const targetSet = new Set(targetTokens);
  return uniqueTokens(question)
    .filter((token) => token.length >= 4 && !targetSet.has(token) && !FOCUS_STOPWORDS.has(token) && !RECOMMENDATION_TARGET_GENERIC.has(token))
    .slice(0, 8);
}

function contextCoverage(contextTokens, segmentTokens) {
  if (contextTokens.length < 2) return 1;
  return strictSoftCoverage(contextTokens, segmentTokens);
}

function recommendationSegmentAnswerHit(answer, answerTokens, segmentNorm, segmentTokens) {
  const answerNorm = normalizeForSearch(answer.text);
  const strongPhrases = new Set([answerNorm]);
  const withoutParentheses = answerNorm.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  if (withoutParentheses) strongPhrases.add(withoutParentheses);
  const hyphenSplit = normalizeForSearch(String(answer.text ?? "").replace(/\s*[-\u2010-\u2015]\s*/g, " "));
  if (hyphenSplit) strongPhrases.add(hyphenSplit);
  const strongPhraseHit = [...strongPhrases].filter((phrase) => phrase.length >= 8).some((phrase) => containsNormalizedPhrase(segmentNorm, phrase));
  const answerPhrases = answerSearchPhrases(answer.text).slice(0, 18);
  const phraseHit = answerPhrases.some((phrase) => containsNormalizedPhrase(segmentNorm, phrase));
  const answerCoverage = strictSoftCoverage(answerTokens, segmentTokens);
  const numeric = extractNumbers(answer.text).length > 0;
  const numericCoverage = numeric ? numberCoverage(answer.text, segmentNorm) : 0;
  const longText = answerTokens.length >= 5;
  const supportHit =
    strongPhraseHit ||
    (numeric && ((phraseHit && answerCoverage >= 0.74 && numericCoverage >= 0.72) || (answerCoverage >= 0.8 && numericCoverage >= 0.9))) ||
    (!numeric && (longText ? answerCoverage >= 0.9 : phraseHit || answerCoverage >= 0.62));
  const mismatchHit = phraseHit || (answerCoverage >= (numeric ? 0.62 : 0.58) && (!numeric || numericCoverage >= 0.45));
  return { phraseHit, strongPhraseHit, answerCoverage, numericCoverage, supportHit, mismatchHit };
}

function genericPopulationAnswerText(answerText) {
  const normalized = normalizeForSearch(answerText);
  return (
    normalized.startsWith(normalizeForSearch("\u0432\u0441\u0435\u043c \u043f\u0430\u0446\u0438\u0435\u043d\u0442")) ||
    normalized.startsWith(normalizeForSearch("\u0432\u0441\u0435 \u043f\u0430\u0446\u0438\u0435\u043d\u0442")) ||
    normalized.startsWith(normalizeForSearch("\u0432\u0441\u0435\u043c \u043f\u043e\u0441\u0442\u0440\u0430\u0434")) ||
    normalized.startsWith(normalizeForSearch("\u0432\u0441\u0435 \u043f\u043e\u0441\u0442\u0440\u0430\u0434")) ||
    normalized.startsWith(normalizeForSearch("\u0432\u0441\u0435\u043c \u0431\u043e\u043b\u044c\u043d")) ||
    normalized.startsWith(normalizeForSearch("\u0432\u0441\u0435 \u0431\u043e\u043b\u044c\u043d"))
  );
}

function populationStem(answerText) {
  const stems = ["\u043f\u0430\u0446\u0438\u0435\u043d\u0442", "\u043f\u043e\u0441\u0442\u0440\u0430\u0434", "\u0431\u043e\u043b\u044c\u043d"].map((item) => normalizeForSearch(item));
  return uniqueTokens(answerText).find((token) => stems.some((stem) => token.startsWith(stem.slice(0, Math.min(8, stem.length))))) ?? null;
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

function followUpFrequencyAnswer(answerText) {
  const normalized = normalizeForSearch(answerText);
  return (
    extractNumbers(answerText).length > 0 &&
    (containsNormalizedPhrase(normalized, "\u043a\u0430\u0436\u0434") || containsNormalizedPhrase(normalized, "\u0440\u0430\u0437 \u0432")) &&
    (containsNormalizedPhrase(normalized, "\u043c\u0435\u0441\u044f\u0446") ||
      containsNormalizedPhrase(normalized, "\u0433\u043e\u0434") ||
      containsNormalizedPhrase(normalized, "\u043b\u0435\u0442") ||
      containsNormalizedPhrase(normalized, "\u043d\u0435\u0434\u0435\u043b"))
  );
}

/**
 * Ищет поддержку варианта внутри того рекомендательного блока, который относится к препарату/вмешательству
 * из вопроса вида "рекомендовано назначение X". Если вариант уверенно найден только в соседней рекомендации
 * про другой X, возвращается мягкий штраф вместо поддержки.
 */
export function explicitRecommendationTargetAdjustment({ mode, pages, question, answer, answers, answerTokens }) {
  if (mode !== "multi") return { support: null, adjustment: 0, evidence: null };
  const targetTokens = appointmentTargetTokens(question);
  if (!targetTokens.length) return { support: null, adjustment: 0, evidence: null };
  const contextTokens = appointmentContextTokens(question, targetTokens);

  let bestSupport = null;
  let bestMismatch = null;
  let targetSegmentCount = 0;

  for (const segment of explicitRecommendationSegments(pages)) {
    const segmentTokens = tokenizeNormalized(segment.normalized);
    const segmentTargetCoverage = targetCoverage(targetTokens, segmentTokens);
    const segmentContextCoverage = contextCoverage(contextTokens, segmentTokens);
    const answerHit = recommendationSegmentAnswerHit(answer, answerTokens, segment.normalized, segmentTokens);
    if (segmentTargetCoverage >= 0.72 && segmentContextCoverage >= 0.45) {
      targetSegmentCount += 1;
      const genericSpecificConflict = genericPopulationAnswerText(answer.text) && hasSpecificPopulationAlternative(answers, answer);
      if (!answerHit.supportHit || genericSpecificConflict) continue;
      const score =
        12.8 +
        segmentTargetCoverage * 4.4 +
        Math.min(1, segmentContextCoverage) * 1.6 +
        answerHit.answerCoverage * 4.2 +
        answerHit.numericCoverage * 1.8 +
        (answerHit.strongPhraseHit ? 2.8 : answerHit.phraseHit ? 1.4 : 0);
      bestSupport = betterEvidence(bestSupport, {
        answerId: answer.id,
        page: segment.page,
        text: segment.text,
        score,
        kind: "explicit_recommendation_target_segment",
      });
      continue;
    }

    if (!answerHit.mismatchHit || followUpFrequencyAnswer(answer.text) || (segmentTargetCoverage > 0.35 && segmentContextCoverage >= 0.45)) continue;
    const mismatchScore = 9.4 + answerHit.answerCoverage * 3.1 + answerHit.numericCoverage * 1.6 + (answerHit.phraseHit ? 2.0 : 0);
    bestMismatch = betterEvidence(bestMismatch, {
      answerId: answer.id,
      page: segment.page,
      text: segment.text,
      score: mismatchScore,
      kind: "explicit_recommendation_target_mismatch",
    });
  }

  if (bestSupport) return { support: bestSupport, adjustment: 0, evidence: null };
  if (targetSegmentCount > 0 && bestMismatch && bestMismatch.score >= 11.2) {
    return { support: null, adjustment: -3.8, evidence: bestMismatch };
  }
  return { support: null, adjustment: 0, evidence: null };
}

export function bestRecommendationItemSupport({ pages, question, answer, answerTokens }) {
  if (!recommendationItemQuestion(question)) return null;
  const questionNorm = normalizeForSearch(question);
  const qTokens = recommendationQuestionTokens(question);
  if (!qTokens.length) return null;
  let best = null;

  for (const segment of recommendationSegments(pages)) {
    const answerNorm = normalizeForSearch(answer.text);
    if (containsNormalizedPhrase(answerNorm, "\u043e\u043f\u0442\u0438\u043c") && !containsNormalizedPhrase(questionNorm, "\u043e\u043f\u0442\u0438\u043c")) continue;
    if (!recommendationSubjectCompatible(questionNorm, segment.normalized)) continue;
    const qCoverage = recommendationQuestionCoverage(questionNorm, qTokens, segment.normalized);
    if (qCoverage < 0.34) continue;
    const answerWindow = recommendationAnswerWindow(questionNorm, segment.normalized);
    if (recommendationPresenceMismatch(answer.text, answerWindow)) continue;
    const tokens = tokenizeNormalized(answerWindow);
    const phraseHit = answerSearchPhrases(answer.text).some((phrase) => containsNormalizedPhrase(answerWindow, phrase));
    const alias = recommendationAliasSupport(answer.text, answerWindow);
    const answerCoverage = Math.max(strictSoftCoverage(answerTokens, tokens), alias);
    if (!phraseHit && answerCoverage < 0.62) continue;
    const score = 15.8 + qCoverage * 4.0 + answerCoverage * 6.2 + (phraseHit ? 2.4 : 0) + alias * 2.0;
    best = betterEvidence(best, {
      answerId: answer.id,
      page: segment.page,
      text: segment.text,
      score,
      kind: "recommendation_item_segment",
    });
  }

  return best;
}
