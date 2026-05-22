import {
  coverage,
  extractNumbers,
  normalizeForSearch,
  normalizeText,
  phraseTokens,
  stemToken,
  tokenize,
  uniqueTokens,
} from "../../normalize.js";
import { FOCUS_STOPWORDS } from "../constants.js";
import { frequencyAnswer, frequencySearchPhrases } from "./frequency.js";
import {
  answerSearchPhrases,
  betterEvidence,
  cachedLineWindowSegments,
  cachedPageTokens,
  containsNormalizedPhrase,
  containsPhrase,
  escapeRegExp,
  evidenceSnippet,
  expandNumberToken,
  findPhraseOccurrences,
  hasSearchBoundaries,
  nearestCueName,
  numberCoverage,
  pageWindow,
  proximityBonus,
  rawSoftCoverage,
  softCoverage,
  strictSoftCoverage,
  tokenBoundaryIncludes,
  tokenizeNormalized,
  tokenHitCount,
  tokenProximity,
  tokenSequenceIncludes,
} from "../text-utils.js";

const CLOZE_GENERIC_FOCUS = new Set(
  uniqueTokens(
    [
      "пациент пациенты пациентам больной больных дети детей ребенок ребенка",
      "рекомендуется проводится применяется назначается принимается используют",
      "составляет относятся следующие критерии показатель значение терапия лечение",
      "клинический рекомендации заболевание диагноз подтвержденный форма",
      "обычно необходимо следует возможно после перед при для",
    ].join(" "),
  ),
);

const CLOZE_COUNT_RIGHT_TOKENS = new Set(uniqueTokens("раз сутки прием приём день"));

const CLOZE_CONTRAST_PHRASES = [
  "при менее",
  "менее выраж",
  "далее",
  "после",
  "либо",
  "или",
  "для декрет",
  "декретирован",
  "старше",
  "от 1 года",
  "через",
].map((phrase) => normalizeForSearch(phrase));

const SMALL_NUMBER_ALIASES = new Map(
  Object.entries({
    "1": ["один", "одна", "одно", "однократно", "однократное", "однократный", "однократная", "1 раз", "1 р"],
    "2": ["два", "две", "дважды", "двукратно", "двукратное", "двукратный", "двукратная", "2 раза", "2 р"],
    "3": ["три", "трижды", "трехкратно", "трёхкратно", "3 раза", "3 р"],
    "4": ["четыре", "четырехкратно", "четырёхкратно", "4 раза", "4 р"],
    "5": ["пять", "5 раз", "5 р"],
    "6": ["шесть", "6 раз", "6 р"],
  }),
);

function clozeQuestionParts(question) {
  const raw = String(question ?? "");
  const blank = raw.match(/_{2,}|…+/u);
  if (!blank?.index) return { left: raw, right: "" };
  return {
    left: raw.slice(0, blank.index),
    right: raw.slice(blank.index + blank[0].length),
  };
}

function clozeApplicable({ mode, question, answer }) {
  if (mode !== "single") return false;
  const hasBlank = /_{2,}|…+/u.test(String(question ?? ""));
  if (hasBlank) return true;
  return false;
}

function clozeFocusTokens(question, focusTokens, answerTokens) {
  const answerSet = new Set(answerTokens ?? []);
  const out = [];
  for (const token of [...(focusTokens ?? []), ...uniqueTokens(question)]) {
    if (!token || token.length < 3) continue;
    if (answerSet.has(token)) continue;
    if (FOCUS_STOPWORDS.has(token) || CLOZE_GENERIC_FOCUS.has(token)) continue;
    if (!out.includes(token)) out.push(token);
  }
  return out.slice(0, 18);
}

function clozeCoreTokens(question, answerTokens) {
  const parts = clozeQuestionParts(question);
  const left = parts.left
    .split(
      /\s+(?:у|для|при|с|со|в)\s+пациент|\s+пациентам|\s+пациентов|\s+больным|\s+детям|\s+младше|\s+старше|\s+кажд|\s+принима|\s+провод|\s+составля|\s+равн|\s+в\s+дозе/iu,
    )[0];
  const tokens = uniqueTokens(left).filter((token) => token.length >= 4 && !FOCUS_STOPWORDS.has(token) && !CLOZE_GENERIC_FOCUS.has(token));
  const answerSet = new Set(answerTokens ?? []);
  return tokens.filter((token) => !answerSet.has(token)).slice(0, 6);
}

function clozeAnswerPhraseEntries(answerText) {
  const entries = [];
  const seen = new Set<string>();
  const add = (value, alias = false) => {
    const normalizedPhrase = normalizeForSearch(value);
    if (!normalizedPhrase || normalizedPhrase.length < 1 || seen.has(normalizedPhrase)) return;
    seen.add(normalizedPhrase);
    entries.push({
      phrase: String(value),
      alias,
      bareNumber: /^\d+(?:[.,]\d+)?$/u.test(normalizedPhrase),
    });
  };
  for (const phrase of answerSearchPhrases(answerText).slice(0, 18)) add(phrase, false);
  const numbers = extractNumbers(answerText);
  for (const number of numbers) {
    for (const expanded of expandNumberToken(number)) add(expanded, true);
  }
  if (numbers.length === 1) {
    const normalizedNumber = numbers[0].replace(/[.,]0+$/u, "");
    for (const alias of SMALL_NUMBER_ALIASES.get(normalizedNumber) ?? []) add(alias, true);
  }
  const answerNorm = normalizeForSearch(answerText);
  if (containsNormalizedPhrase(answerNorm, normalizeForSearch("месяц")) || containsNormalizedPhrase(answerNorm, normalizeForSearch("месяцев"))) {
    add("мес", true);
  }
  if (containsNormalizedPhrase(answerNorm, normalizeForSearch("неделя")) || containsNormalizedPhrase(answerNorm, normalizeForSearch("недели"))) {
    add("нед", true);
  }
  return entries;
}

function clozeHasUnitCue(local, question) {
  const text = normalizeForSearch(`${local} ${question}`);
  return /(?:мг|мес|месяц|сут|дн|раз|р |%|°|мм|г\/л|лет|год)/u.test(text);
}

function lastTokenDistance(before, focusTokens) {
  let best = -1;
  for (const token of focusTokens) {
    if (!token) continue;
    const index = before.lastIndexOf(token);
    if (index > best) best = index;
  }
  if (best < 0) return Number.POSITIVE_INFINITY;
  return before.length - best;
}

function clozeContrastPenalty(tail, questionNumbers) {
  let penalty = 0;
  for (const phrase of CLOZE_CONTRAST_PHRASES) {
    if (phrase && containsNormalizedPhrase(tail, phrase)) penalty += 1;
  }
  const localNumbers = extractNumbers(tail);
  if (questionNumbers.length && localNumbers.some((number) => !questionNumbers.includes(number))) {
    penalty += 1;
  }
  return Math.min(3, penalty);
}

function relevantClozeQuestionNumbers(question) {
  const raw = String(question ?? "");
  const out = [];
  const pattern = /(?<![\p{L}])([<>]?\d+(?:[.,]\d+)?)(?![\p{L}])/giu;
  for (const match of raw.matchAll(pattern)) {
    const index = match.index ?? 0;
    const around = raw.slice(Math.max(0, index - 24), index + match[0].length + 24).toLowerCase();
    if (!/[<>]|мг|мм|мес|меся|лет|год|сут|дн|%|°|температур|доз|кажд|раз/u.test(around)) continue;
    const cleaned = match[1].replace(/^[<>]/u, "");
    for (const expanded of expandNumberToken(cleaned)) {
      if (!out.includes(expanded)) out.push(expanded);
    }
  }
  return out;
}

function clozeLocalHasRelevantQuestionNumber(local, relevantNumbers) {
  if (!relevantNumbers.length) return true;
  const localNumbers = new Set(extractNumbers(local).flatMap(expandNumberToken));
  return relevantNumbers.some((number) => localNumbers.has(number));
}

function clozeTailHasConflictingNumber(tail, answerText) {
  const answerNumbers = new Set(extractNumbers(answerText).flatMap(expandNumberToken));
  if (!answerNumbers.size) return false;
  return extractNumbers(tail)
    .flatMap(expandNumberToken)
    .some((number) => !answerNumbers.has(number));
}

function clozeTailHasTimingCue(tail) {
  return containsNormalizedPhrase(tail, "через") || containsNormalizedPhrase(tail, "после");
}

export function bestClozeGapSupport({ mode, pages, topQuestionPages, question, answer, answerTokens, focusTokens }) {
  if (!clozeApplicable({ mode, question, answer })) return null;
  const specificFocus = clozeFocusTokens(question, focusTokens, answerTokens);
  if (specificFocus.length < 2) return null;
  const answerEntries = clozeAnswerPhraseEntries(answer.text);
  if (!answerEntries.length) return null;
  const parts = clozeQuestionParts(question);
  const rightTokens = clozeFocusTokens(parts.right, uniqueTokens(parts.right), answerTokens);
  if (!rightTokens.some((token) => CLOZE_COUNT_RIGHT_TOKENS.has(token))) return null;
  const hasBlank = /_{2,}|…+/u.test(String(question ?? ""));
  const coreTokens = clozeCoreTokens(question, answerTokens);
  const questionNumbers = extractNumbers(question);
  const relevantQuestionNumbers = relevantClozeQuestionNumbers(question);
  let best = null;

  for (const page of pages) {
    const nearTopPage =
      !topQuestionPages?.size || topQuestionPages.has(page.page) || topQuestionPages.has(page.page - 1) || topQuestionPages.has(page.page + 1);
    if (!nearTopPage) continue;
    const sources = cachedLineWindowSegments(page).filter((segment) => segment.normalized.length <= 760);
    for (const source of sources) {
      const tokens = tokenizeNormalized(source.normalized);
      const focusHits = tokenHitCount(specificFocus, tokens);
      const focusCoverage = coverage(specificFocus, tokens);
      if (focusHits < 2 && focusCoverage < 0.24) continue;

      for (const entry of answerEntries) {
        const hits = findPhraseOccurrences(source.normalized, entry.phrase, { textIsNormalized: true });
        for (const hit of hits) {
          const local = source.normalized.slice(Math.max(0, hit - 80), hit + entry.phrase.length + 90);
          if (entry.bareNumber && !clozeHasUnitCue(local, question)) continue;
          const relevantLocal = source.normalized.slice(Math.max(0, hit - 220), hit + entry.phrase.length + 140);
          if (!clozeLocalHasRelevantQuestionNumber(relevantLocal, relevantQuestionNumbers)) continue;
          const before = source.normalized.slice(Math.max(0, hit - 300), hit);
          const after = source.normalized.slice(hit + entry.phrase.length, hit + entry.phrase.length + 180);
          const beforeTokens = tokenizeNormalized(before);
          if (hasBlank && coreTokens.length >= 2) {
            const recentCoreCoverage = coverage(coreTokens, tokenizeNormalized(before.slice(-180)));
            const overallCoreCoverage = coverage(coreTokens, beforeTokens);
            if (recentCoreCoverage < 0.45 && overallCoreCoverage < 0.75) continue;
            if (lastTokenDistance(before, coreTokens) > 110) continue;
          }
          const beforeFocusHits = tokenHitCount(specificFocus, beforeTokens);
          const beforeCoverage = coverage(specificFocus, beforeTokens);
          if (beforeFocusHits < 2 && beforeCoverage < 0.18) continue;
          const distance = lastTokenDistance(before, specificFocus);
          if (!Number.isFinite(distance) || distance > 220) continue;
          const tail = before.slice(Math.max(0, before.length - Math.min(140, distance + 28)));
          const contrastPenalty = clozeContrastPenalty(tail, questionNumbers);
          if (!hasBlank && entry.bareNumber && clozeTailHasTimingCue(tail)) continue;
          if (!hasBlank && clozeTailHasConflictingNumber(tail, answer.text)) continue;
          if (contrastPenalty >= 2 && !rightTokens.length) continue;
          const rightCoverage = rightTokens.length ? coverage(rightTokens, tokenizeNormalized(after)) : 0;
          const numeric = numberCoverage(answer.text, local);
          const score =
            12.1 +
            Math.min(6, focusHits) * 0.65 +
            Math.min(6, beforeFocusHits) * 0.85 +
            Math.min(0.7, beforeCoverage) * 4.0 +
            proximityBonus(distance, 180) * 6.0 +
            Math.min(0.75, rightCoverage) * 4.0 +
            (entry.alias ? 1.4 : 0) +
            numeric * 1.1 -
            contrastPenalty * 5.2;
          if (score < 10.8) continue;
          best = betterEvidence(best, {
            answerId: answer.id,
            page: page.page,
            text: source.text,
            score,
            kind: "cloze_gap_local",
          });
        }
      }
    }
  }

  return best;
}


function conditionFamily(text) {
  const normalized = normalizeForSearch(text);
  if (containsNormalizedPhrase(normalized, "тяжел")) return "heavy";
  if (containsNormalizedPhrase(normalized, "умерен") || containsNormalizedPhrase(normalized, "средн")) return "moderate";
  if (containsNormalizedPhrase(normalized, "легк")) return "mild";
  return null;
}

function nearestConditionFamily(normalizedText) {
  let best = null;
  for (const [family, cues] of [
    ["heavy", ["тяжел"]],
    ["moderate", ["умерен", "средн"]],
    ["mild", ["легк"]],
  ]) {
    for (const cueText of cues) {
      const cue = normalizeForSearch(cueText);
      const index = normalizedText.indexOf(cue);
      if (index >= 0 && (!best || index < best.index)) best = { family, index };
    }
  }
  return best?.family ?? null;
}

function answerValueCondition(answerText) {
  const raw = normalizeText(answerText);
  const match = raw.match(/^(.{2,90}?)\s+для\s+(.{3,120})$/u);
  if (!match) return null;
  const value = match[1].trim();
  const condition = match[2].trim();
  if (!extractNumbers(value).length && !/(год|месяц|дн|сут|раз)/u.test(value)) return null;
  const family = conditionFamily(condition);
  if (!family) return null;
  return { value, condition, family };
}

export function conditionPairAdjustment({ pages, topQuestionPages, answer }) {
  const pair = answerValueCondition(answer.text);
  if (!pair) return { adjustment: 0, evidence: null };
  let bestMatch = null;
  let bestMismatch = null;
  const valuePhrases = answerSearchPhrases(pair.value).slice(0, 8);

  for (const page of pages) {
    if (topQuestionPages?.size && !topQuestionPages.has(page.page)) continue;
    for (const phrase of valuePhrases) {
      const phraseNorm = normalizeForSearch(phrase);
      if (!phraseNorm || phraseNorm.length < 3) continue;
      const hits = findPhraseOccurrences(page.normalized, phrase, { textIsNormalized: true });
      for (const hit of hits) {
        const after = page.normalized.slice(hit + phraseNorm.length, hit + phraseNorm.length + 120);
        const actual = nearestConditionFamily(after);
        if (!actual) continue;
        const local = page.normalized.slice(Math.max(0, hit - 80), hit + phraseNorm.length + 160);
        const evidence = {
          answerId: answer.id,
          page: page.page,
          text: evidenceSnippet(page.text, pair.value, pair.condition),
          score: actual === pair.family ? 8.8 : 2.4,
          kind: actual === pair.family ? "condition_pair_match" : "condition_pair_mismatch",
        };
        if (actual === pair.family) {
          const proximity = after.indexOf(normalizeForSearch(pair.condition).slice(0, 5));
          bestMatch = betterEvidence(bestMatch, { ...evidence, score: evidence.score + proximityBonus(proximity, 120) });
        } else if (local) {
          bestMismatch = betterEvidence(bestMismatch, evidence);
        }
      }
    }
  }

  if (bestMatch) return { adjustment: 4.6, evidence: bestMatch };
  if (bestMismatch) return { adjustment: -2.4, evidence: bestMismatch };
  return { adjustment: 0, evidence: null };
}


const NUMERIC_OPTION_UNIT_TOKENS = new Set(
  [
    "\u043c\u0433",
    "\u043c\u043a\u0433",
    "\u043c\u043b",
    "\u043c\u0435",
    "\u043a\u0433",
    "\u0434\u0435\u043d\u044c",
    "\u0434\u043d\u044f",
    "\u0434\u043d\u0435\u0439",
    "\u0441\u0443\u0442\u043a\u0438",
    "\u0441\u0443\u0442\u043e\u043a",
    "\u043d\u0435\u0434\u0435\u043b\u044e",
    "\u043d\u0435\u0434\u0435\u043b\u0438",
    "\u043c\u0435\u0441\u044f\u0446",
    "\u043c\u0435\u0441\u044f\u0446\u0430",
    "\u043c\u0435\u0441\u044f\u0446\u0435\u0432",
    "\u0433\u043e\u0434",
    "\u0433\u043e\u0434\u0430",
    "\u043b\u0435\u0442",
    "\u0440\u0430\u0437",
    "\u0447\u0430\u0441",
    "\u0447",
  ].flatMap((item) => uniqueTokens(item)),
);

function numericOptionAnswer(answerText) {
  if (!extractNumbers(answerText).length) return false;
  const normalized = normalizeForSearch(answerText);
  return normalized.includes("%") || tokenHitCount([...NUMERIC_OPTION_UNIT_TOKENS], tokenize(answerText)) > 0;
}

function denseNumericSingleQuestion(mode, answers) {
  return mode === "single" && answers.filter((answer) => numericOptionAnswer(answer.text)).length >= 2;
}

function exactNumericOptionQuestion(question) {
  const normalized = normalizeForSearch(question);
  return (
    containsNormalizedPhrase(normalized, "\u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434") ||
    containsNormalizedPhrase(normalized, "\u043d\u0430\u0437\u043d\u0430\u0447") ||
    containsNormalizedPhrase(normalized, "\u0434\u043e\u0437") ||
    containsNormalizedPhrase(normalized, "\u0432 \u0442\u0435\u0447\u0435\u043d") ||
    containsNormalizedPhrase(normalized, "\u0440\u0430\u0437 \u0432") ||
    containsNormalizedPhrase(normalized, "\u043a\u0430\u0436\u0434") ||
    containsNormalizedPhrase(normalized, "\u043f\u0440\u043e\u0432\u043e\u0434")
  );
}

function numericExactPhrases(answerText) {
  const normalized = normalizeForSearch(answerText);
  const withoutParentheses = normalizeForSearch(normalized.replace(/\([^)]*\)/g, " "));
  const hyphenSplit = normalizeForSearch(String(answerText ?? "").replace(/\s*[-\u2010-\u2015]\s*/g, " "));
  const phrases = new Set([normalized, withoutParentheses, hyphenSplit]);
  return [...phrases].filter((phrase) => phrase.length >= 5 && extractNumbers(phrase).length);
}

function hourAliasPhrases(answerText) {
  const raw = normalizeText(answerText);
  const numbers = extractNumbers(answerText);
  if (!numbers.length || !/(?:^|\s)(?:\u0447|\u0447\.|\u0447\u0430\u0441|\u0447\u0430\u0441\u0430|\u0447\u0430\u0441\u043e\u0432)(?:\s|$)/u.test(raw)) return [];
  const phrases = new Set();
  for (const number of numbers) {
    phrases.add(`${number} \u0447`);
    phrases.add(`${number} \u0447.`);
  }
  const answerNorm = normalizeForSearch(answerText);
  return [...phrases].filter((phrase) => normalizeForSearch(phrase) !== answerNorm);
}

function segmentContainsBoundedPhrase(normalizedSegment, phrase) {
  const normalizedPhrase = normalizeForSearch(phrase);
  if (!normalizedPhrase) return false;
  return findPhraseOccurrences(normalizedSegment, normalizedPhrase, { textIsNormalized: true }).some((index) =>
    hasSearchBoundaries(normalizedSegment, index, normalizedPhrase.length),
  );
}

/**
 * Поддерживает single-вопросы с плотной числовой семьей вариантов.
 *
 * Если несколько вариантов отличаются дозой, сроком, частотой или процентом,
 * полный числовой режим в релевантной строке должен весить сильнее, чем общий
 * chunk, где рядом могут встречаться несколько альтернативных значений.
 */
export function bestExactNumericOptionSupport({ mode, pages, topQuestionPages, question, answer, answers, answerTokens, questionTokens, focusTokens }) {
  if (!denseNumericSingleQuestion(mode, answers) || !numericOptionAnswer(answer.text)) return null;
  if (!exactNumericOptionQuestion(question)) return null;
  const phrases = numericExactPhrases(answer.text).slice(0, 12);
  if (!phrases.length) return null;
  const usefulFocus = (focusTokens?.length ? focusTokens : questionTokens).filter((token) => token.length >= 4 && !FOCUS_STOPWORDS.has(token));
  let best = null;

  for (const page of pages) {
    const nearTopPage =
      !topQuestionPages?.size || topQuestionPages.has(page.page) || topQuestionPages.has(page.page - 1) || topQuestionPages.has(page.page + 1);
    if (!nearTopPage) continue;
    for (const segment of cachedLineWindowSegments(page)) {
      const phraseHit = phrases.some((phrase) => containsNormalizedPhrase(segment.normalized, phrase));
      if (!phraseHit) continue;
      const numericCoverage = numberCoverage(answer.text, segment.normalized);
      const focusHits = tokenHitCount(usefulFocus, segment.tokens);
      const questionCoverage = coverage(questionTokens, segment.tokens);
      if (questionCoverage < 0.14 && focusHits < Math.min(2, usefulFocus.length)) continue;
      const answerCoverage = strictSoftCoverage(answerTokens, segment.tokens);
      const score =
        12.8 +
        4.2 +
        numericCoverage * 3.0 +
        answerCoverage * 2.8 +
        Math.min(0.52, questionCoverage) * 5.6 +
        Math.min(2, focusHits) * 0.8;
      best = betterEvidence(best, {
        answerId: answer.id,
        page: page.page,
        text: segment.text,
        score,
        kind: "exact_numeric_option_segment",
      });
    }
  }

  return best;
}

/**
 * Узко поддерживает варианты времени, где PDF использует сокращение (`6 ч`),
 * а вариант ответа дан полностью (`6 часов`). Это отдельный слой, чтобы не
 * расширять общий numeric scorer и не усиливать соседние дозировки/сроки.
 */
export function bestExactHourAliasOptionSupport({ mode, pages, topQuestionPages, question, answer, answers, answerTokens, questionTokens, focusTokens }) {
  if (mode !== "single" || answers.filter((candidate) => extractNumbers(candidate.text).length > 0).length < 2) return null;
  if (!exactNumericOptionQuestion(question)) return null;
  const phrases = hourAliasPhrases(answer.text);
  if (!phrases.length) return null;

  const answerNumbers = new Set(extractNumbers(answer.text));
  const questionConditionNumbers = extractNumbers(question).filter((number) => !answerNumbers.has(number));
  const usefulFocus = (focusTokens?.length ? focusTokens : questionTokens).filter((token) => token.length >= 4 && !FOCUS_STOPWORDS.has(token));
  let best = null;

  for (const page of pages) {
    const nearTopPage =
      !topQuestionPages?.size || topQuestionPages.has(page.page) || topQuestionPages.has(page.page - 1) || topQuestionPages.has(page.page + 1);
    if (!nearTopPage) continue;
    for (const segment of cachedLineWindowSegments(page)) {
      const phraseHit = phrases.some((phrase) => segmentContainsBoundedPhrase(segment.normalized, phrase));
      if (!phraseHit) continue;
      if (questionConditionNumbers.length && !questionConditionNumbers.some((number) => containsNormalizedPhrase(segment.normalized, number))) continue;
      const focusHits = tokenHitCount(usefulFocus, segment.tokens);
      const questionCoverage = coverage(questionTokens, segment.tokens);
      if (questionCoverage < 0.14 && focusHits < Math.min(2, usefulFocus.length)) continue;
      const answerCoverage = strictSoftCoverage(answerTokens, segment.tokens);
      const numericCoverage = numberCoverage(answer.text, segment.normalized);
      const score =
        15.2 +
        numericCoverage * 3.2 +
        answerCoverage * 2.2 +
        Math.min(0.52, questionCoverage) * 5.2 +
        Math.min(2, focusHits) * 0.9;
      best = betterEvidence(best, {
        answerId: answer.id,
        page: page.page,
        text: segment.text,
        score,
        kind: "exact_hour_alias_segment",
      });
    }
  }

  return best;
}


function conditionNumberCueHit(local, question, answer) {
  const questionNorm = normalizeForSearch(question);
  let hasCue = false;

  if (containsNormalizedPhrase(questionNorm, "hbeag")) {
    const nearestStatus = nearestCueName(local, [
      ["negative", ["\u043e\u0442\u0440\u0438\u0446"]],
      ["positive", ["\u043f\u043e\u043b\u043e\u0436"]],
    ]);
    if (containsNormalizedPhrase(questionNorm, "\u043e\u0442\u0440\u0438\u0446")) {
      hasCue = true;
      if (!(containsNormalizedPhrase(local, "hbeag") && nearestStatus === "negative")) return false;
    } else if (containsNormalizedPhrase(questionNorm, "\u043f\u043e\u043b\u043e\u0436")) {
      hasCue = true;
      if (!(containsNormalizedPhrase(local, "hbeag") && nearestStatus === "positive")) return false;
    }
  }

  if (containsNormalizedPhrase(questionNorm, "\u0431\u0435\u0437 \u0446\u0438\u0440\u0440\u043e\u0437")) {
    hasCue = true;
    if (!containsNormalizedPhrase(local, "\u0431\u0435\u0437 \u0446\u0438\u0440\u0440\u043e\u0437")) return false;
  } else if (containsNormalizedPhrase(questionNorm, "\u043f\u0440\u0438 \u0446\u0438\u0440\u0440\u043e\u0437") || containsNormalizedPhrase(questionNorm, "\u0441 \u0446\u0438\u0440\u0440\u043e\u0437")) {
    hasCue = true;
    if (containsNormalizedPhrase(local, "\u0431\u0435\u0437 \u0446\u0438\u0440\u0440\u043e\u0437") || !containsNormalizedPhrase(local, "\u0446\u0438\u0440\u0440\u043e\u0437")) return false;
  }

  const family = conditionFamily(question);
  if (family) {
    const nearestFamily = nearestCueName(local, [
      ["heavy", ["\u0442\u044f\u0436\u0435\u043b"]],
      ["moderate", ["\u0443\u043c\u0435\u0440\u0435\u043d", "\u0441\u0440\u0435\u0434\u043d"]],
      ["mild", ["\u043b\u0435\u0433\u043a"]],
    ]);
    hasCue = true;
    if (nearestFamily !== family) return false;
  }

  const answerNumbers = new Set(extractNumbers(answer.text).flatMap(expandNumberToken));
  const conditionNumbers = extractNumbers(question)
    .flatMap(expandNumberToken)
    .filter((number) => !answerNumbers.has(number));
  if (conditionNumbers.length) {
    hasCue = true;
    if (!conditionNumbers.some((number) => tokenBoundaryIncludes(local, number))) return false;
  }

  return hasCue;
}

function conditionNumberAnswerPhrases(answerText) {
  const phrases = new Set([...answerSearchPhrases(answerText), ...frequencySearchPhrases(answerText)]);
  if (/%/.test(answerText)) {
    for (const number of extractNumbers(answerText).flatMap(expandNumberToken)) {
      if (/^\d+(?:\.\d+)?$/.test(number)) phrases.add(number);
    }
  }
  return [...phrases].filter((phrase) => normalizeForSearch(phrase).length >= 1).slice(0, 20);
}

const CONDITION_NUMBER_GENERIC_FOCUS = new Set(
  [
    "\u0440\u0438\u0441\u043a",
    "\u0441\u043e\u0441\u0442\u0430\u0432\u043b\u044f\u0435\u0442",
    "\u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434",
    "\u043f\u0430\u0446\u0438\u0435\u043d\u0442",
    "\u043c\u0430\u0442\u0435\u0440\u0435\u0439",
    "\u043f\u043e\u043b\u043e\u0436\u0438\u0442\u0435\u043b\u044c\u043d",
    "\u043e\u0442\u0440\u0438\u0446\u0430\u0442\u0435\u043b\u044c\u043d",
    "\u0442\u044f\u0436\u0435\u043b\u044b\u043c",
    "\u0442\u044f\u0436\u0435\u043b\u043e\u043c",
    "\u0441\u0440\u0435\u0434\u043d\u0435\u0439",
    "\u0446\u0438\u0440\u0440\u043e\u0437",
    "hbeag",
  ].flatMap((item) => uniqueTokens(item)),
);

function specificConditionNumberFocusTokens(focusTokens) {
  return (focusTokens ?? []).filter((token) => token.length >= 4 && !/^\d/.test(token) && !CONDITION_NUMBER_GENERIC_FOCUS.has(token));
}

function bestConditionNumberSupport({ mode, pages, question, answer, answerTokens, focusTokens }) {
  if (mode !== "single") return null;
  if (!extractNumbers(answer.text).length && !frequencyAnswer(answer.text)) return null;
  const phrases = conditionNumberAnswerPhrases(answer.text);
  if (!phrases.length) return null;
  const specificTokens = specificConditionNumberFocusTokens(focusTokens);
  let best = null;

  for (const page of pages) {
    for (const phrase of phrases) {
      const phraseNorm = normalizeForSearch(phrase);
      if (!phraseNorm) continue;
      const hits = findPhraseOccurrences(page.normalized, phrase, { textIsNormalized: true });
      for (const hit of hits) {
        if (/%/.test(answer.text) && /^\d+(?:\.\d+)?$/.test(phraseNorm) && !page.normalized.slice(hit, hit + 14).includes("%")) continue;
        const local = page.normalized.slice(Math.max(0, hit - 160), hit + phraseNorm.length + 180);
        if (!conditionNumberCueHit(local, question, answer)) continue;
        const localTokens = tokenizeNormalized(local);
        const focusHits = tokenHitCount(specificTokens, localTokens);
        if (specificTokens.length >= 2 && focusHits < 2) continue;
        const score =
          12.6 +
          strictSoftCoverage(answerTokens, localTokens) * 2.2 +
          numberCoverage(answer.text, local) * 3.4 +
          focusHits * 1.1;
        best = betterEvidence(best, {
          answerId: answer.id,
          page: page.page,
          text: evidenceSnippet(page.text, phrase, question),
          score,
          kind: "condition_number_segment",
        });
      }
    }
  }

  return best;
}

function questionMarkerConditions(question) {
  const normalized = normalizeForSearch(question);
  const conditions = [];
  if (containsNormalizedPhrase(normalized, "hbeag")) {
    if (containsNormalizedPhrase(normalized, "\u043e\u0442\u0440\u0438\u0446")) conditions.push({ type: "hbeag", value: "negative" });
    if (containsNormalizedPhrase(normalized, "\u043f\u043e\u043b\u043e\u0436")) conditions.push({ type: "hbeag", value: "positive" });
  }
  if (containsNormalizedPhrase(normalized, "\u0431\u0435\u0437 \u0446\u0438\u0440\u0440\u043e\u0437")) {
    conditions.push({ type: "cirrhosis", value: "without" });
  } else if (containsNormalizedPhrase(normalized, "\u043f\u0440\u0438 \u0446\u0438\u0440\u0440\u043e\u0437") || containsNormalizedPhrase(normalized, "\u0441 \u0446\u0438\u0440\u0440\u043e\u0437")) {
    conditions.push({ type: "cirrhosis", value: "with" });
  }
  return conditions;
}

function markerConditionsMatch(local, conditions) {
  for (const condition of conditions) {
    if (condition.type === "hbeag") {
      const nearestStatus = nearestCueName(local, [
        ["negative", ["\u043e\u0442\u0440\u0438\u0446"]],
        ["positive", ["\u043f\u043e\u043b\u043e\u0436"]],
      ]);
      if (!containsNormalizedPhrase(local, "hbeag") || nearestStatus !== condition.value) return false;
    } else if (condition.type === "cirrhosis") {
      if (condition.value === "without") {
        if (!containsNormalizedPhrase(local, "\u0431\u0435\u0437 \u0446\u0438\u0440\u0440\u043e\u0437")) return false;
      } else if (!containsNormalizedPhrase(local, "\u0446\u0438\u0440\u0440\u043e\u0437") || containsNormalizedPhrase(local, "\u0431\u0435\u0437 \u0446\u0438\u0440\u0440\u043e\u0437")) {
        return false;
      }
    }
  }
  return true;
}

function conditionedNumberPhrases(answerText) {
  const phrases = new Set();
  for (const number of extractNumbers(answerText)) {
    phrases.add(number);
    for (const expanded of expandNumberToken(number)) phrases.add(expanded);
    const withoutPercent = String(number).replace("%", "");
    if (withoutPercent) phrases.add(withoutPercent);
  }
  for (const phrase of frequencySearchPhrases(answerText)) phrases.add(phrase);
  return [...phrases].map((phrase) => normalizeForSearch(phrase)).filter((phrase) => phrase.length >= 1).slice(0, 18);
}

function exactNumericForms(text) {
  const forms = new Set();
  for (const number of extractNumbers(text)) {
    const normalized = normalizeForSearch(number);
    if (!normalized) continue;
    forms.add(normalized);
    forms.add(normalized.replace(/\.0+$/u, ""));
    if (normalized.includes(".")) forms.add(normalized.replace(/0+$/u, "").replace(/\.$/u, ""));
  }
  return [...forms].filter(Boolean);
}

function numericSearchBoundary(normalizedText, hit, length) {
  const before = hit > 0 ? normalizedText[hit - 1] : "";
  const after = hit + length < normalizedText.length ? normalizedText[hit + length] : "";
  const beforeBefore = hit > 1 ? normalizedText[hit - 2] : "";
  const afterAfter = hit + length + 1 < normalizedText.length ? normalizedText[hit + length + 1] : "";
  const tokenChar = /[a-zа-я0-9%.+/]/iu;
  if (before && tokenChar.test(before)) return false;
  if (after && tokenChar.test(after)) return false;
  if (before === "-" && /\d/u.test(beforeBefore)) return false;
  if (after === "-" && /\d/u.test(afterAfter)) return false;
  return true;
}

function findNumericFormHits(normalizedText, form) {
  const hits = [];
  if (!form) return hits;
  let start = 0;
  while (start < normalizedText.length) {
    const index = normalizedText.indexOf(form, start);
    if (index < 0) break;
    if (numericSearchBoundary(normalizedText, index, form.length)) hits.push({ index, length: form.length });
    start = index + Math.max(1, form.length);
    if (hits.length > 80) break;
  }
  return hits;
}

function sourceConditionHits(normalizedText, anchor) {
  if (anchor.pattern) {
    const hits = [];
    for (const match of normalizedText.matchAll(anchor.pattern)) {
      hits.push({ index: match.index ?? 0, length: match[0].length });
      if (hits.length > 80) break;
    }
    return hits;
  }
  const hits = [];
  for (const phrase of anchor.phrases ?? []) {
    let start = 0;
    while (start < normalizedText.length) {
      const index = normalizedText.indexOf(phrase, start);
      if (index < 0) break;
      if (hasSearchBoundaries(normalizedText, index, phrase.length)) hits.push({ index, length: phrase.length });
      start = index + Math.max(1, phrase.length);
      if (hits.length > 80) break;
    }
  }
  return hits;
}

function nextConditionHit(normalizedText, anchor, start) {
  if (!anchor.nextPattern) return -1;
  anchor.nextPattern.lastIndex = start;
  const match = anchor.nextPattern.exec(normalizedText);
  anchor.nextPattern.lastIndex = 0;
  return match?.index ?? -1;
}

function interveningNumberCount(normalizedText) {
  return extractNumbers(normalizedText).length;
}

function numericConditionDirectionOk(normalizedText, conditionHit, answerHit, anchor) {
  const conditionEnd = conditionHit.index + conditionHit.length;
  const answerEnd = answerHit.index + answerHit.length;
  if (anchor.direction === "before") {
    if (answerHit.index < conditionEnd) return false;
    if (answerHit.index - conditionEnd > anchor.after) return false;
    const next = nextConditionHit(normalizedText, anchor, conditionEnd + 1);
    if (next >= 0 && answerHit.index >= next) return false;
    if (interveningNumberCount(normalizedText.slice(conditionEnd, answerHit.index)) > 0) return false;
    return true;
  }
  if (answerEnd > conditionHit.index) return false;
  if (conditionHit.index - answerEnd > anchor.before) return false;
  if (interveningNumberCount(normalizedText.slice(answerEnd, conditionHit.index)) > 0) return false;
  return true;
}

function numericConditionAnchorSatisfied(local, anchor) {
  if (!anchor.phrases?.length || !anchor.minPhraseHits) return true;
  let hits = 0;
  for (const phrase of anchor.phrases) {
    if (local.includes(phrase)) hits += 1;
  }
  return hits >= anchor.minPhraseHits;
}

function questionNumericConditionAnchors(question) {
  const raw = normalizeText(question);
  const normalized = normalizeForSearch(question);
  const anchors = [];
  const weekCue = normalizeForSearch("\u043d\u0435\u0434\u0435\u043b");
  const kgCue = normalizeForSearch("\u043a\u0433");

  const weekMatch = normalized.match(new RegExp(`(?:^|\\s)(\\d{1,2})(?:\\s*-?\\s*[a-zа-я]{1,2})?\\s+${escapeRegExp(weekCue)}`, "iu"));
  if (weekMatch?.[1]) {
    const number = weekMatch[1];
    anchors.push({
      kind: "week_number",
      direction: "before",
      after: 170,
      before: 10,
      base: 58,
      pattern: new RegExp(`(?:^|\\s)${escapeRegExp(number)}(?:\\s*-?\\s*[a-zа-я]{1,2})?\\s+${escapeRegExp(weekCue)}`, "giu"),
      nextPattern: new RegExp(`(?:^|\\s)\\d{1,2}(?:\\s*-?\\s*[a-zа-я]{1,2})?\\s+${escapeRegExp(weekCue)}`, "giu"),
    });
  }

  for (const number of extractNumbers(question)) {
    const normalizedNumber = normalizeForSearch(number);
    if (!normalizedNumber.includes("-")) continue;
    const hits = findNumericFormHits(normalized, normalizedNumber);
    const hasKg = hits.some((hit) => normalized.slice(hit.index, Math.min(normalized.length, hit.index + 48)).includes(kgCue));
    if (!hasKg && !containsNormalizedPhrase(normalized, "\u043c\u0430\u0441\u0441\u0430") && !containsNormalizedPhrase(normalized, "\u0432\u0435\u0441")) continue;
    anchors.push({
      kind: "weight_range",
      direction: "before",
      after: 90,
      before: 8,
      base: 60,
      pattern: new RegExp(`(?:^|\\s)${escapeRegExp(normalizedNumber)}\\s*${escapeRegExp(kgCue)}`, "giu"),
      nextPattern: new RegExp(`(?:^|\\s)\\d+(?:-\\d+)?\\s*${escapeRegExp(kgCue)}`, "giu"),
    });
  }

  if (containsNormalizedPhrase(normalized, "\u0444\u0430\u0437")) {
    if (containsNormalizedPhrase(normalized, "\u0445\u0440\u043e\u043d\u0438\u0447")) {
      anchors.push({
        kind: "phase_abbreviation",
        direction: "after",
        after: 18,
        before: 95,
        base: 59,
        phrases: [normalizeForSearch("\u0445\u0444")],
        minPhraseHits: 1,
      });
    }
    const phasePhrases = [];
    if (containsNormalizedPhrase(normalized, "\u0430\u043a\u0441\u0435\u043b\u0435\u0440\u0430\u0446")) phasePhrases.push(normalizeForSearch("\u0444\u0430"));
    if (containsNormalizedPhrase(normalized, "\u0431\u043b\u0430\u0441\u0442")) phasePhrases.push(normalizeForSearch("\u0431\u043a"));
    if (phasePhrases.length) {
      anchors.push({
        kind: "phase_abbreviation",
        direction: "after",
        after: 24,
        before: 105,
        base: 59,
        phrases: phasePhrases,
        minPhraseHits: 1,
      });
    }
  }

  return anchors;
}

function numericConditionSources(pages, topQuestionPages) {
  const sources = [];
  for (const page of pages) {
    const topPage = topQuestionPages?.has(page.page);
    const adjacentTopPage =
      topQuestionPages?.has(page.page - 1) || topQuestionPages?.has(page.page + 1);
    if (topQuestionPages?.size && !topPage && !adjacentTopPage) continue;
    for (const segment of cachedLineWindowSegments(page)) {
      sources.push({ page: page.page, text: segment.text, normalized: segment.normalized });
    }
  }
  return sources;
}

export function bestNumericConditionSupport({ mode, pages, topQuestionPages, question, answer, answerTokens, focusTokens }) {
  if (mode !== "single") return null;
  const answerForms = exactNumericForms(answer.text);
  if (!answerForms.length) return null;
  const anchors = questionNumericConditionAnchors(question);
  if (!anchors.length) return null;
  const specificTokens = specificConditionNumberFocusTokens(focusTokens);
  let best = null;

  for (const source of numericConditionSources(pages, topQuestionPages)) {
    const sourceTokens = tokenizeNormalized(source.normalized);
    const focusHits = tokenHitCount(specificTokens, sourceTokens);
    for (const anchor of anchors) {
      const conditionHits = sourceConditionHits(source.normalized, anchor);
      if (!conditionHits.length) continue;
      for (const answerForm of answerForms) {
        const answerHits = findNumericFormHits(source.normalized, answerForm);
        for (const conditionHit of conditionHits) {
          for (const answerHit of answerHits) {
            if (!numericConditionDirectionOk(source.normalized, conditionHit, answerHit, anchor)) continue;
            const localStart = Math.max(0, Math.min(conditionHit.index, answerHit.index) - 32);
            const localEnd = Math.min(source.normalized.length, Math.max(conditionHit.index + conditionHit.length, answerHit.index + answerHit.length) + 56);
            const local = source.normalized.slice(localStart, localEnd);
            if (!numericConditionAnchorSatisfied(local, anchor)) continue;
            const score =
              anchor.base +
              numberCoverage(answer.text, local) * 5.4 +
              strictSoftCoverage(answerTokens, tokenizeNormalized(local)) * 1.6 +
              Math.min(3, focusHits) * 0.55;
            best = betterEvidence(best, {
              answerId: answer.id,
              page: source.page,
              text: source.text,
              score,
              kind: `numeric_condition_${anchor.kind}`,
            });
          }
        }
      }
    }
  }

  return best;
}

export function bestConditionedNumberSupport({ mode, pages, topQuestionPages, question, answer, answerTokens, focusTokens }) {
  if (mode !== "single") return null;
  if (!extractNumbers(answer.text).length && !frequencyAnswer(answer.text)) return null;
  const conditions = questionMarkerConditions(question);
  if (!conditions.length) return null;
  const phrases = conditionedNumberPhrases(answer.text);
  if (!phrases.length) return null;
  const specificTokens = specificConditionNumberFocusTokens(focusTokens);
  let best = null;

  for (const page of pages) {
    if (topQuestionPages?.size && !topQuestionPages.has(page.page)) continue;
    for (const phrase of phrases) {
      let start = 0;
      while (start < page.normalized.length) {
        const hit = page.normalized.indexOf(phrase, start);
        if (hit < 0) break;
        const numericRangeStart = /^\d+(?:\.\d+)?%?$/.test(phrase) && page.normalized[hit + phrase.length] === "-";
        if (phrase.length > 1 && !hasSearchBoundaries(page.normalized, hit, phrase.length) && !numericRangeStart) {
          start = hit + Math.max(1, phrase.length);
          continue;
        }
        if (page.normalized.slice(Math.max(0, hit - 3), hit).includes("-")) {
          start = hit + Math.max(1, phrase.length);
          continue;
        }
        const local = page.normalized.slice(Math.max(0, hit - 180), Math.min(page.normalized.length, hit + phrase.length + 190));
        if (!markerConditionsMatch(local, conditions)) {
          start = hit + Math.max(1, phrase.length);
          continue;
        }
        const localTokens = tokenizeNormalized(local);
        const focusHits = tokenHitCount(specificTokens, localTokens);
        const score =
          15.0 +
          strictSoftCoverage(answerTokens, localTokens) * 2.6 +
          numberCoverage(answer.text, local) * 3.2 +
          Math.min(3, focusHits) * 0.9;
        best = betterEvidence(best, {
          answerId: answer.id,
          page: page.page,
          text: evidenceSnippet(page.text, phrase, question),
          score,
          kind: "conditioned_number_segment",
        });
        start = hit + Math.max(1, phrase.length);
      }
    }
  }

  return best;
}

const COUNT_NUMBER_WORDS = new Map(
  Object.entries({
    "1": ["\u043e\u0434\u0438\u043d", "\u043e\u0434\u043d"],
    "2": ["\u0434\u0432\u0430", "\u0434\u0432\u0435", "\u0434\u0432\u0443"],
    "3": ["\u0442\u0440\u0438", "\u0442\u0440\u0435"],
    "4": ["\u0447\u0435\u0442\u044b\u0440"],
    "5": ["\u043f\u044f\u0442"],
    "6": ["\u0448\u0435\u0441\u0442"],
    "7": ["\u0441\u0435\u043c"],
    "8": ["\u0432\u043e\u0441\u0435\u043c"],
    "9": ["\u0434\u0435\u0432\u044f\u0442"],
    "10": ["\u0434\u0435\u0441\u044f\u0442"],
    "11": ["\u043e\u0434\u0438\u043d\u043d\u0430\u0434\u0446\u0430\u0442"],
    "12": ["\u0434\u0432\u0435\u043d\u0430\u0434\u0446\u0430\u0442"],
  }).map(([number, words]) => [number, words.map((word) => normalizeForSearch(word))]),
);

const COUNT_QUESTION_CUES = ["\u043a\u043e\u043b\u0438\u0447\u0435\u0441\u0442\u0432", "\u0447\u0438\u0441\u043b\u043e", "\u0441\u043a\u043e\u043b\u044c\u043a"].map((item) => normalizeForSearch(item));
const COUNT_LOCAL_CUES = [
  "\u0441\u043e\u0441\u0442\u0430\u0432\u043b",
  "\u0432\u044b\u0434\u0435\u043b\u044f",
  "\u0432\u044b\u0437\u0432\u0430\u043d",
  "\u043a\u043e\u0434\u0438\u0440",
  "\u0432\u043a\u043b\u044e\u0447",
  "\u0431\u043e\u043b\u044c\u0448\u0438\u043d\u0441\u0442\u0432",
  "\u0441\u0440\u0435\u0434\u0438 \u043a\u043e\u0442\u043e\u0440",
  "\u0440\u0430\u0437\u043b\u0438\u0447\u043d",
  "\u0440\u0430\u0437\u043b\u0438\u0447\u0430",
  "\u043f\u043e\u0434\u0440\u0430\u0437\u0434\u0435\u043b",
].map((item) => normalizeForSearch(item));

const COUNT_GENERIC_TOKENS = new Set(
  [
    "\u043a\u043e\u043b\u0438\u0447\u0435\u0441\u0442\u0432\u043e",
    "\u0441\u043e\u0441\u0442\u0430\u0432\u043b\u044f\u0435\u0442",
    "\u0447\u0438\u0441\u043b\u043e",
    "\u0441\u043a\u043e\u043b\u044c\u043a\u043e",
    "\u0432\u044b\u0434\u0435\u043b\u044f\u044e\u0442",
    "\u043d\u0430\u0441\u0442\u043e\u044f\u0449\u0435\u0435",
    "\u0432\u0440\u0435\u043c\u044f",
  ].flatMap((item) => uniqueTokens(item)),
);

function countQuestion(question) {
  const normalized = normalizeForSearch(question);
  return COUNT_QUESTION_CUES.some((cue) => normalized.includes(cue));
}

function countFocusTokens(question) {
  return uniqueTokens(question).filter((token) => token.length >= 3 && !FOCUS_STOPWORDS.has(token) && !COUNT_GENERIC_TOKENS.has(token) && !/^\d/.test(token));
}

function countNumberSearchPhrases(answerText) {
  const phrases = new Set<string>();
  for (const number of extractNumbers(answerText)) {
    for (const expanded of expandNumberToken(number)) {
      const clean = String(expanded).replace("%", "");
      if (!clean || !/^\d+$/.test(clean)) continue;
      phrases.add(clean);
      for (const word of COUNT_NUMBER_WORDS.get(clean) ?? []) phrases.add(word);
    }
  }
  return [...phrases].filter(Boolean);
}

function countRelationAnswerOption(answerText) {
  const normalized = normalizeForSearch(answerText);
  const tokens = phraseTokens(answerText).filter((token) => token.length > 0);
  const numbers = extractNumbers(answerText);
  if (!numbers.length || tokens.length > 4 || normalized.length > 36) return false;
  const numberLike = new Set(numbers.flatMap(expandNumberToken).map((item) => String(item).replace("%", "")));
  for (const [number, words] of COUNT_NUMBER_WORDS.entries()) {
    if (numberLike.has(number)) {
      for (const word of words) numberLike.add(word);
    }
  }
  const nonNumericTokens = tokens.filter((token) => {
    const clean = token.replace(/[%.,+-]/g, "");
    if (!clean) return false;
    if (/^\d+$/u.test(clean)) return false;
    return !numberLike.has(clean);
  });
  return nonNumericTokens.length <= 1;
}

function countCueHit(local) {
  return COUNT_LOCAL_CUES.some((cue) => local.includes(cue));
}

function positiveStructuralHit(local) {
  const cue = normalizeForSearch("\u0441\u0442\u0440\u0443\u043a\u0442\u0443\u0440");
  for (let index = local.indexOf(cue); index >= 0; index = local.indexOf(cue, index + cue.length)) {
    const before = local.slice(Math.max(0, index - 4), index);
    if (!before.includes(normalizeForSearch("\u043d\u0435"))) return true;
  }
  return false;
}

function countTargetNear(normalizedPage, hit, phraseLength, question) {
  const questionNorm = normalizeForSearch(question);
  const local = normalizedPage.slice(Math.max(0, hit - 25), Math.min(normalizedPage.length, hit + phraseLength + 55));
  const after = normalizedPage.slice(hit + phraseLength, Math.min(normalizedPage.length, hit + phraseLength + 58));
  if (containsNormalizedPhrase(questionNorm, "\u0433\u0435\u043d\u043e\u0442\u0438\u043f")) {
    return containsNormalizedPhrase(after, "\u0433\u0435\u043d\u043e\u0442\u0438\u043f");
  }
  if (containsNormalizedPhrase(questionNorm, "\u043d\u0435\u0441\u0442\u0440\u0443\u043a\u0442\u0443\u0440")) {
    return containsNormalizedPhrase(after, "\u043d\u0435\u0441\u0442\u0440\u0443\u043a\u0442\u0443\u0440");
  }
  if (containsNormalizedPhrase(questionNorm, "\u0441\u0442\u0440\u0443\u043a\u0442\u0443\u0440") && containsNormalizedPhrase(questionNorm, "\u0431\u0435\u043b\u043a")) {
    return positiveStructuralHit(after);
  }
  if (containsNormalizedPhrase(questionNorm, "\u0441\u0435\u0440\u043e\u0433\u0440\u0443\u043f")) {
    return containsNormalizedPhrase(after, "\u0441\u0435\u0440\u043e\u0433\u0440\u0443\u043f");
  }
  if (containsNormalizedPhrase(questionNorm, "\u0441\u0435\u0440\u043e\u0442\u0438\u043f")) {
    return containsNormalizedPhrase(after, "\u0441\u0435\u0440\u043e\u0442\u0438\u043f");
  }
  return true;
}

export function bestCountRelationSupport({ mode, pages, topQuestionPages, question, answer, answerTokens }) {
  if (mode !== "single" || !countQuestion(question)) return null;
  if (!extractNumbers(answer.text).length) return null;
  if (!countRelationAnswerOption(answer.text)) return null;
  const phrases = countNumberSearchPhrases(answer.text);
  if (!phrases.length) return null;
  const focusTokens = countFocusTokens(question);
  if (focusTokens.length < 2) return null;
  let best = null;

  for (const page of pages) {
    if (topQuestionPages?.size && !topQuestionPages.has(page.page)) continue;
    for (const phrase of phrases) {
      let start = 0;
      while (start < page.normalized.length) {
        const hit = page.normalized.indexOf(phrase, start);
        if (hit < 0) break;
        if (/^\d+$/.test(phrase)) {
          const before = hit > 0 ? page.normalized[hit - 1] : "";
          const after = page.normalized[hit + phrase.length] ?? "";
          if (/[0-9]/.test(before) || /[0-9]/.test(after)) {
            start = hit + Math.max(1, phrase.length);
            continue;
          }
          const nearBefore = page.normalized.slice(Math.max(0, hit - 3), hit);
          const nearAfter = page.normalized.slice(hit + phrase.length, hit + phrase.length + 3);
          if (nearBefore.includes("[") || nearAfter.includes("]")) {
            start = hit + Math.max(1, phrase.length);
            continue;
          }
        }
        if (!countTargetNear(page.normalized, hit, phrase.length, question)) {
          start = hit + Math.max(1, phrase.length);
          continue;
        }
        const local = page.normalized.slice(Math.max(0, hit - 210), Math.min(page.normalized.length, hit + phrase.length + 230));
        const localTokens = tokenizeNormalized(local);
        const focusCoverage = strictSoftCoverage(focusTokens, localTokens);
        if (focusCoverage < 0.34 || !countCueHit(local)) {
          start = hit + Math.max(1, phrase.length);
          continue;
        }
        const score =
          14.2 +
          focusCoverage * 6.2 +
          strictSoftCoverage(answerTokens, localTokens) * 1.2 +
          numberCoverage(answer.text, local) * 2.6;
        best = betterEvidence(best, {
          answerId: answer.id,
          page: page.page,
          text: evidenceSnippet(page.text, phrase, question),
          score,
          kind: "count_relation_segment",
        });
        start = hit + Math.max(1, phrase.length);
      }
    }
  }

  return best;
}

