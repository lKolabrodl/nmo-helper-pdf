import { coverage, normalizeForSearch, tokenize, uniqueTokens } from "../../normalize.js";
import { FOCUS_STOPWORDS } from "../constants.js";
import {
  answerSearchPhrases,
  betterEvidence,
  cachedLineWindowSegments,
  containsNormalizedPhrase,
  evidenceSnippet,
  findPhraseOccurrences,
  nearestCueName,
  pageWindow,
  tokenHitCount,
  tokenizeNormalized,
} from "../text-utils.js";
import { latinAnswerTokens } from "./biomedical-symbols.js";

const POLARITY_UP_CUES = ["повыш", "увелич", "возраста", "рост", "высок", "более", "выше"].map((item) => normalizeForSearch(item));
const POLARITY_DOWN_CUES = ["сниж", "уменьш", "низк", "менее", "ниже"].map((item) => normalizeForSearch(item));

function detectPolarity(text) {
  const normalized = normalizeForSearch(text);
  if (containsNormalizedPhrase(normalized, "менее высокий") || containsNormalizedPhrase(normalized, "менее высок") || containsNormalizedPhrase(normalized, "ниже")) {
    return "down";
  }
  if (containsNormalizedPhrase(normalized, "более высокий") || containsNormalizedPhrase(normalized, "более высок") || containsNormalizedPhrase(normalized, "выше")) {
    return "up";
  }
  const up = POLARITY_UP_CUES.some((cue) => normalized.includes(cue));
  const down = POLARITY_DOWN_CUES.some((cue) => normalized.includes(cue));
  if (up && !down) return "up";
  if (down && !up) return "down";
  return null;
}

function nearestPolarityBefore(pageNorm, hit) {
  const before = pageNorm.slice(Math.max(0, hit - 140), hit);
  let best = null;
  for (const cue of POLARITY_UP_CUES) {
    const index = before.lastIndexOf(cue);
    if (index >= 0 && (!best || index > best.index)) best = { type: "up", index };
  }
  for (const cue of POLARITY_DOWN_CUES) {
    const index = before.lastIndexOf(cue);
    if (index >= 0 && (!best || index > best.index)) best = { type: "down", index };
  }
  return best?.type ?? null;
}

/**
 * Сопоставляет направление (рост/снижение) в вопросе и в локальном контексте
 * найденного варианта; штрафует противоположную полярность.
 */
export function polarityAdjustment({ pages, topQuestionPages, mode, question, questionTokens, answer }) {
  const targetPolarity = detectPolarity(question) ?? detectPolarity(answer.text);
  if (!targetPolarity) return { adjustment: 0, evidence: null };
  const phrases = [...new Set([...latinAnswerTokens(answer.text), ...answerSearchPhrases(answer.text)])].slice(0, 14);
  let bestMatch = null;
  let bestMismatch = null;

  for (const page of pages) {
    if (topQuestionPages?.size && !topQuestionPages.has(page.page)) continue;
    const pageNorm = page.normalized;
    for (const phrase of phrases) {
      const normalizedPhrase = normalizeForSearch(phrase);
      if (!normalizedPhrase || normalizedPhrase.length < 3) continue;
      const hits = findPhraseOccurrences(pageNorm, phrase, { textIsNormalized: true });
      for (const hit of hits) {
        const local = pageWindow(page, hit, 180);
        const questionCoverage = coverage(questionTokens, tokenizeNormalized(local));
        if (questionCoverage < 0.16) continue;
        const found = nearestPolarityBefore(pageNorm, hit);
        if (!found) continue;
        const evidence = {
          answerId: answer.id,
          page: page.page,
          text: evidenceSnippet(page.text, phrase),
          score: (found === targetPolarity ? 4.8 : 4.2) + questionCoverage * 5.0,
          kind: found === targetPolarity ? "polarity_match" : "polarity_mismatch",
        };
        if (found === targetPolarity) bestMatch = betterEvidence(bestMatch, evidence);
        else bestMismatch = betterEvidence(bestMismatch, evidence);
      }
    }
  }

  if (bestMatch && (!bestMismatch || bestMatch.score >= bestMismatch.score + 0.3)) return { adjustment: 2.4, evidence: bestMatch };
  if (bestMismatch && (!bestMatch || bestMismatch.score > bestMatch.score + 0.3)) {
    return { adjustment: mode === "single" ? -5.2 : -2.4, evidence: bestMismatch };
  }
  return { adjustment: 0, evidence: null };
}

function temporalCue(text) {
  const normalized = normalizeForSearch(text);
  if (containsNormalizedPhrase(normalized, "ноч")) return "night";
  if (containsNormalizedPhrase(normalized, "днем") || containsNormalizedPhrase(normalized, "днев")) return "day";
  return null;
}

function nearestTemporalCue(local) {
  return nearestCueName(local, [
    ["night", ["ноч"]],
    ["day", ["днем", "днев"]],
  ]);
}

/**
 * Различает дневные и ночные подсказки для single-вопросов и штрафует
 * вариант с противоположным временем суток рядом с фокусом вопроса.
 */
export function temporalCueAdjustment({ mode, pages, topQuestionPages, answer, focusTokens, questionTokens }) {
  if (mode !== "single") return { support: null, adjustment: 0, evidence: null };
  const cue = temporalCue(answer.text);
  if (!cue) return { support: null, adjustment: 0, evidence: null };
  const usefulFocus = focusTokens?.length ? focusTokens : questionTokens;
  let bestMatch = null;
  let bestMismatch = null;

  for (const page of pages) {
    const topPage = topQuestionPages?.has(page.page);
    const adjacentTopPage = topQuestionPages?.has(page.page - 1) || topQuestionPages?.has(page.page + 1);
    if (topQuestionPages?.size && !topPage && !adjacentTopPage) continue;
    for (const segment of cachedLineWindowSegments(page)) {
      const focusCoverage = coverage(usefulFocus, segment.tokens);
      if (focusCoverage < 0.12) continue;
      const found = nearestTemporalCue(segment.normalized);
      if (!found) continue;
      const evidence = {
        answerId: answer.id,
        page: page.page,
        text: segment.text,
        score: 9.8 + Math.min(0.5, focusCoverage) * 5.0,
        kind: found === cue ? "temporal_cue_match" : "temporal_cue_mismatch",
      };
      if (found === cue) bestMatch = betterEvidence(bestMatch, evidence);
      else bestMismatch = betterEvidence(bestMismatch, evidence);
    }
  }

  if (bestMatch && (!bestMismatch || bestMatch.score >= bestMismatch.score - 0.4)) return { support: bestMatch, adjustment: 0, evidence: null };
  if (bestMismatch && (!bestMatch || bestMismatch.score > bestMatch.score + 0.4)) return { support: null, adjustment: -4.8, evidence: bestMismatch };
  return { support: null, adjustment: 0, evidence: null };
}

const CONTRAST_CUE_GROUPS = [
  {
    answer: ["верхн"],
    opposite: ["нижн", "базал"],
  },
  {
    answer: ["нижн", "базал"],
    opposite: ["верхн"],
  },
  {
    answer: ["повыш", "увелич"],
    opposite: ["пониж", "сниж", "уменьш"],
  },
  {
    answer: ["пониж", "сниж", "уменьш"],
    opposite: ["повыш", "увелич"],
  },
  {
    answer: ["дистальнопроксим"],
    opposite: ["проксимальнодист"],
  },
  {
    answer: ["проксимальнодист"],
    opposite: ["дистальнопроксим"],
  },
].map((group) => ({
  answer: group.answer.map((item) => normalizeForSearch(item)),
  opposite: group.opposite.map((item) => normalizeForSearch(item)),
}));

const MODIFIER_TARGET_CONTRAST_GROUPS = [
  {
    answer: "ранний ранняя раннее ранней",
    opposite: "поздний поздняя позднее поздней",
  },
  {
    answer: "поздний поздняя позднее поздней",
    opposite: "ранний ранняя раннее ранней",
  },
].map((group) => ({
  answer: new Set(tokenize(group.answer)),
  opposite: new Set(tokenize(group.opposite)),
}));

function modifierTargetContrastMismatch(answerText, sourceText) {
  const answerTokens = tokenize(answerText);
  const sourceTokens = tokenize(sourceText);
  for (const group of MODIFIER_TARGET_CONTRAST_GROUPS) {
    if (!answerTokens.some((token) => group.answer.has(token))) continue;
    const targets = answerTokens.filter((token) => token.length >= 4 && !group.answer.has(token) && !group.opposite.has(token) && !FOCUS_STOPWORDS.has(token));
    if (!targets.length) continue;
    for (let index = 0; index < sourceTokens.length; index += 1) {
      if (!targets.includes(sourceTokens[index])) continue;
      for (let cursor = index - 1; cursor >= Math.max(0, index - 4); cursor -= 1) {
        const token = sourceTokens[cursor];
        if (group.opposite.has(token)) return true;
        if (group.answer.has(token)) break;
      }
    }
  }
  return false;
}

/**
 * Штрафует multi-вариант, у которого сильнейшее evidence содержит
 * противоположную подсказку (верх/низ, рост/снижение, порядок дистальный/
 * проксимальный) либо противоположный модификатор у того же целевого слова.
 */
export function contrastCueMismatchAdjustment({ mode, answer }, evidence) {
  if (mode !== "multi" || !evidence?.length) return { adjustment: 0, evidence: null };
  const answerNorm = normalizeForSearch(answer.text);
  const group = CONTRAST_CUE_GROUPS.find((item) => item.answer.some((cue) => answerNorm.includes(cue)));

  for (const item of evidence.slice(0, 4)) {
    if ((item.score ?? 0) < 5.5 || !item.text) continue;
    const sourceNorm = normalizeForSearch(item.text);
    if (modifierTargetContrastMismatch(answer.text, item.text)) {
      return {
        adjustment: -6.4,
        evidence: {
          answerId: answer.id,
          page: item.page,
          text: item.text,
          score: 6.4,
          kind: "modifier_target_mismatch",
        },
      };
    }
    if (!group) continue;
    const hasAnswerCue = group.answer.some((cue) => sourceNorm.includes(cue));
    const hasOppositeCue = group.opposite.some((cue) => sourceNorm.includes(cue));
    if (!hasAnswerCue && hasOppositeCue) {
      return {
        adjustment: -5.2,
        evidence: {
          answerId: answer.id,
          page: item.page,
          text: item.text,
          score: 5.2,
          kind: "contrast_cue_mismatch",
        },
      };
    }
  }

  return { adjustment: 0, evidence: null };
}

const EXCLUDED_CONDITION_START_STOP = [
  "сниж",
  "повыш",
  "примен",
  "лечен",
  "назнач",
  "пров",
  "провед",
  "проведение",
  "использ",
  "концентр",
  "проб",
].flatMap((item) => uniqueTokens(item));

const CONDITION_POSITIVE_CUES = [
  "при",
  "на фоне",
  "налич",
  "имеющ",
].map((item) => normalizeForSearch(item));

/**
 * Достает короткое условие из формулировок вида `без цирроза`, чтобы отличать
 * рекомендации для исключенной подгруппы от рекомендаций для этой подгруппы.
 */
function excludedConditionTokens(question) {
  const normalized = normalizeForSearch(question);
  if (
    containsNormalizedPhrase(normalized, "без проведен") ||
    containsNormalizedPhrase(normalized, "без применен") ||
    containsNormalizedPhrase(normalized, "без назнач")
  ) {
    return [];
  }
  const tokens = tokenize(question);
  const withoutCue = normalizeForSearch("без");
  const out = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index] !== withoutCue) continue;
    const next = tokens.slice(index + 1, index + 4).filter((token) => token.length >= 4 && !FOCUS_STOPWORDS.has(token));
    if (!next.length) continue;
    if (EXCLUDED_CONDITION_START_STOP.some((prefix) => next[0].startsWith(prefix) || prefix.startsWith(next[0]))) continue;
    out.push(...next.slice(0, 2));
    break;
  }
  return [...new Set(out)];
}

function evidenceHasExcludedConditionBeforeAnswer(answerText, evidenceText, conditionTokens) {
  if (!conditionTokens.length || !evidenceText) return false;
  const normalized = normalizeForSearch(evidenceText);
  const phrases = answerSearchPhrases(answerText)
    .map((phrase) => normalizeForSearch(phrase))
    .filter((phrase) => phrase.length >= 3);
  for (const phrase of phrases) {
    const hit = normalized.indexOf(phrase);
    if (hit < 0) continue;
    const before = normalized.slice(Math.max(0, hit - 140), hit);
    if (!CONDITION_POSITIVE_CUES.some((cue) => before.includes(cue))) continue;
    if (tokenHitCount(conditionTokens, tokenizeNormalized(before)) > 0) return true;
  }
  return false;
}

/**
 * Штрафует вариант, чье локальное evidence относится к исключенной подгруппе
 * (`при X` рядом с фразой ответа), когда вопрос явно про `без X`.
 */
export function excludedConditionMismatchAdjustment({ mode, question, answer }, evidence) {
  const conditionTokens = excludedConditionTokens(question);
  if (!conditionTokens.length) return { adjustment: 0, evidence: null };

  for (const item of evidence.slice(0, 5)) {
    if ((item.score ?? 0) < 6.5) continue;
    if (!evidenceHasExcludedConditionBeforeAnswer(answer.text, item.text, conditionTokens)) continue;
    return {
      adjustment: mode === "single" ? -12.4 : -4.2,
      evidence: {
        answerId: answer.id,
        page: item.page,
        text: item.text,
        score: 8.4,
        kind: "excluded_condition_mismatch",
      },
    };
  }

  return { adjustment: 0, evidence: null };
}
