import { coverage, extractNumbers, normalizeForSearch, tokenize } from "../../normalize.js";
import {
  answerSearchPhrases,
  betterEvidence,
  containsNormalizedPhrase,
  evidenceSnippet,
  findPhraseOccurrences,
  numberCoverage,
  tokenHitCount,
  tokenizeNormalized,
} from "../text-utils.js";

function exactAnswerPhrases(answerText, answerTokens) {
  const answerNumbers = extractNumbers(answerText);
  const minTokenCount = Math.max(3, Math.ceil(Math.max(1, answerTokens.length) * 0.72));
  const phrases = [];
  const seen = new Set();

  for (const phrase of answerSearchPhrases(answerText)) {
    const normalized = normalizeForSearch(phrase);
    if (!normalized || normalized.length < 10 || seen.has(normalized)) continue;
    const tokens = tokenize(phrase);
    if (tokens.length < minTokenCount) continue;
    if (answerNumbers.length && numberCoverage(answerText, normalized) < 0.99) continue;
    phrases.push({ raw: phrase, normalized, tokens });
    seen.add(normalized);
  }

  return phrases;
}

function exactAnswerApplicable(question, answer) {
  const normalizedQuestion = normalizeForSearch(question);
  const answerNumbers = extractNumbers(answer.text);
  if (answerNumbers.length < 3) return false;
  const routeDoseQuestion =
    containsNormalizedPhrase(normalizedQuestion, "\u0432\u043d\u0443\u0442\u0440\u044c \u043f\u043e") ||
    (containsNormalizedPhrase(normalizedQuestion, "\u043d\u0430\u0437\u043d\u0430\u0447") &&
      containsNormalizedPhrase(normalizedQuestion, "\u043f\u043e") &&
      containsNormalizedPhrase(normalizedQuestion, "\u0432\u043d\u0443\u0442\u0440"));
  return routeDoseQuestion;
}

export function bestExactAnswerSupport({ mode, pages, topQuestionPages, question, answer, questionTokens, answerTokens, focusTokens }) {
  if (mode !== "single") return null;
  if (!exactAnswerApplicable(question, answer)) return null;
  const phrases = exactAnswerPhrases(answer.text, answerTokens);
  if (!phrases.length) return null;
  let best = null;

  for (const page of pages) {
    const nearQuestionPage =
      !topQuestionPages?.size || topQuestionPages.has(page.page) || topQuestionPages.has(page.page - 1) || topQuestionPages.has(page.page + 1);
    for (const phrase of phrases) {
      const hits = findPhraseOccurrences(page.normalized, phrase.raw, { textIsNormalized: true });
      for (const hit of hits) {
        const local = page.normalized.slice(Math.max(0, hit - 380), Math.min(page.normalized.length, hit + phrase.normalized.length + 380));
        const localTokens = tokenizeNormalized(local);
        const focusHits = tokenHitCount(focusTokens, localTokens);
        const focusCoverage = focusTokens.length ? coverage(focusTokens, localTokens) : 0;
        const questionCoverage = questionTokens.length ? coverage(questionTokens, localTokens) : 0;
        if (!nearQuestionPage && focusHits < 2 && focusCoverage < 0.22) continue;
        if (focusTokens.length && focusHits < 1 && focusCoverage < 0.16 && questionCoverage < 0.14) continue;

        const answerLengthBonus = Math.min(4.8, phrase.tokens.length * 0.55);
        const score =
          20.2 +
          answerLengthBonus +
          Math.min(0.8, focusCoverage) * 8.2 +
          Math.min(4, focusHits) * 0.95 +
          Math.min(0.6, questionCoverage) * 2.4 +
          numberCoverage(answer.text, local) * 2.4 +
          (nearQuestionPage ? 1.2 : 0);
        best = betterEvidence(best, {
          answerId: answer.id,
          page: page.page,
          text: evidenceSnippet(page.text, question, answer.text),
          score,
          kind: "exact_answer_phrase",
        });
      }
    }
  }

  return best;
}
