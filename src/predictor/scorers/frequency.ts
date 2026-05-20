import { coverage, extractNumbers, normalizeForSearch, normalizeText, tokenize, uniqueTokens } from "../../normalize.js";
import { betterEvidence, containsNormalizedPhrase, numberCoverage, tokenHitCount } from "../text-utils.js";

export function frequencyAnswer(answerText) {
  const raw = normalizeText(answerText);
  return /\d|один|два|три|четыре|пять|шесть|семь|восемь|девять/u.test(raw) && /(год|месяц|недел|дн|сут|раз)/u.test(raw);
}

export function frequencySearchPhrases(answerText) {
  const raw = normalizeText(answerText);
  const numbers = extractNumbers(answerText);
  const phrases = new Set();
  if (answerText && /(год|месяц|недел|дн|сут|раз|\d)/u.test(raw)) phrases.add(answerText);
  for (const number of numbers) {
    if (/год/u.test(raw)) {
      phrases.add(`${number} год`);
      phrases.add(`${number} раз в год`);
    }
    if (/месяц/u.test(raw)) {
      phrases.add(`${number} месяц`);
      phrases.add(`${number} месяцев`);
      phrases.add(`${number} месяца`);
    }
    if (/недел/u.test(raw)) {
      phrases.add(`${number} неделю`);
      phrases.add(`${number} недели`);
      phrases.add(`${number} недель`);
    }
    if (/(дн|сут)/u.test(raw)) {
      phrases.add(`${number} день`);
      phrases.add(`${number} дня`);
      phrases.add(`${number} дней`);
      phrases.add(`${number} сутки`);
      phrases.add(`${number} суток`);
    }
  }
  return [...phrases].filter((phrase) => {
    const phraseNorm = normalizeForSearch(phrase);
    if (!/\u0441\u0443\u0442/u.test(raw) && containsNormalizedPhrase(phraseNorm, "\u0441\u0443\u0442")) return false;
    if (!/\u0434\u043d/u.test(raw) && (containsNormalizedPhrase(phraseNorm, "\u0434\u0435\u043d\u044c") || containsNormalizedPhrase(phraseNorm, "\u0434\u043d\u044f") || containsNormalizedPhrase(phraseNorm, "\u0434\u043d\u0435\u0439"))) return false;
    return phraseNorm.length >= 4;
  });
}

function lineWindowSegments(page, radius = 2) {
  const lines = page.lines ?? [];
  const segments = [];
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines.slice(index, Math.min(lines.length, index + radius + 1)).join(" ").replace(/\s+/g, " ").trim();
    if (text.length >= 16 && text.length <= 900) {
      segments.push({
        text,
        normalized: normalizeForSearch(text),
        tokens: tokenize(text),
      });
    }
  }
  return segments;
}

function cachedLineWindowSegments(page) {
  if (!page.__lineWindowSegments) {
    Object.defineProperty(page, "__lineWindowSegments", {
      value: lineWindowSegments(page, 3),
      enumerable: false,
    });
  }
  return page.__lineWindowSegments;
}

const FREQUENCY_GENERIC_FOCUS = new Set(
  [
    "динамическое",
    "динамического",
    "наблюдение",
    "наблюдения",
    "пациент",
    "пациентам",
    "хвгс",
    "хвгв",
    "цп",
    "цирроз",
    "печень",
    "печени",
    "рекомендуется",
    "рекомендовано",
    "выполнение",
    "выполнять",
    "проведение",
    "проводить",
    "контроль",
    "контроля",
    "эффективность",
    "эффективности",
    "исключение",
    "рецидив",
    "раз",
  ].flatMap((item) => uniqueTokens(item)),
);

const FREQUENCY_ANSWER_GENERIC = new Set(
  [
    "внутривенное",
    "внутривенно",
    "внутримышечно",
    "местное",
    "перорально",
    "введение",
    "вводят",
    "назначение",
    "назначают",
    "применение",
    "применяют",
    "дозе",
    "доза",
    "средняя",
    "суточная",
    "содержанием",
    "составе",
    "область",
    "боли",
    "сутки",
    "суток",
    "дней",
    "дня",
    "недель",
    "недели",
    "течение",
    "каждые",
    "каждый",
    "курсом",
    "раствора",
    "раствор",
    "таблеток",
    "крема",
    "геля",
    "мг",
    "мл",
    "кг",
    "раз",
  ].flatMap((item) => uniqueTokens(item)),
);

function specificFrequencyFocusTokens(focusTokens) {
  return focusTokens.filter((token) => token.length >= 4 && !/^\d/.test(token) && !FREQUENCY_GENERIC_FOCUS.has(token));
}

/**
 * Выделяет из числового варианта предмет назначения: препарат, действующее вещество
 * или медицинское средство. Это защищает scorer от ложных совпадений, когда в PDF
 * рядом найден только срок или кратность, но указан другой препарат.
 */
function frequencyAnswerSubjectTokens(answerText) {
  const tokens = uniqueTokens(answerText).filter(
    (token) => token.length >= 5 && !/^\d/u.test(token) && !/[/%]/u.test(token) && !FREQUENCY_ANSWER_GENERIC.has(token),
  );
  return tokens.slice(0, 5);
}

function frequencySubjectCompatible(answerText, segmentTokens) {
  const subjectTokens = frequencyAnswerSubjectTokens(answerText);
  if (!subjectTokens.length) return true;
  return tokenHitCount(subjectTokens, segmentTokens) > 0;
}

export function bestFrequencyRecommendationSupport({ mode, pages, topQuestionPages, question, answer, focusTokens }) {
  if (mode !== "single") return null;
  if (!frequencyAnswer(answer.text)) return null;
  const questionRaw = normalizeText(question);
  if (!/(рекоменд|наблюден|контрол|выполн|провод)/u.test(questionRaw)) return null;
  const phrases = frequencySearchPhrases(answer.text).slice(0, 10);
  if (!phrases.length) return null;
  const specificTokens = specificFrequencyFocusTokens(focusTokens);
  let best = null;

  for (const page of pages) {
    if (topQuestionPages?.size && !topQuestionPages.has(page.page)) continue;
    for (const segment of cachedLineWindowSegments(page)) {
      if (!containsNormalizedPhrase(segment.normalized, "рекоменд")) continue;
      const hasAnswer = phrases.some((phrase) => containsNormalizedPhrase(segment.normalized, phrase));
      if (!hasAnswer) continue;
      if (!frequencySubjectCompatible(answer.text, segment.tokens)) continue;
      if (specificTokens.length && tokenHitCount(specificTokens, segment.tokens) < Math.min(2, specificTokens.length)) continue;
      const focusCoverage = coverage(focusTokens, segment.tokens);
      const score = 11.8 + focusCoverage * 9.0 + numberCoverage(answer.text, segment.normalized) * 1.0;
      best = betterEvidence(best, {
        answerId: answer.id,
        page: page.page,
        text: segment.text,
        score,
        kind: "frequency_recommendation_line",
      });
    }
  }

  return best;
}
