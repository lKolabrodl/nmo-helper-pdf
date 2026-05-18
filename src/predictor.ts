import {
  coverage,
  detectQuestionIntent,
  extractNumbers,
  jaccard,
  normalizeText,
  normalizeForSearch,
  phraseTokens,
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
import { bestRecommendationItemSupport, explicitRecommendationTargetAdjustment } from "./predictor/scorers/recommendation-item.js";
import {
  bestAnchorSupport,
  bestPhraseSupport,
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
  numberCoverage,
  pageWindow,
  proximityBonus,
  rawSoftCoverage,
  rawTokens,
  softCoverage,
  strictSoftCoverage,
  tokenizeNormalized,
  tokenHitCount,
  tokenProximity,
  tokenSequenceIncludes,
} from "./predictor/text-utils.js";

const POLARITY_UP_CUES = ["повыш", "увелич", "возраста", "рост", "высок", "более", "выше"].map((item) => normalizeForSearch(item));
const POLARITY_DOWN_CUES = ["сниж", "уменьш", "низк", "менее", "ниже"].map((item) => normalizeForSearch(item));
const OCR_LATIN_MAP = new Map(
  Object.entries({
    А: "a",
    В: "b",
    Е: "e",
    К: "k",
    М: "m",
    Н: "h",
    О: "o",
    Р: "p",
    С: "c",
    Т: "t",
    У: "y",
    Х: "x",
    а: "a",
    в: "b",
    е: "e",
    к: "k",
    м: "m",
    н: "h",
    о: "o",
    р: "p",
    с: "c",
    т: "t",
    у: "y",
    х: "x",
    Б: "b",
    Г: "r",
    Д: "d",
    З: "z",
    И: "n",
    Й: "n",
    Л: "l",
    П: "n",
    Ф: "f",
    Ц: "c",
    Ч: "y",
    Ш: "w",
    Щ: "w",
    Ы: "h",
    Ь: "b",
    Ъ: "b",
    Ю: "io",
    Я: "r",
    б: "b",
    г: "r",
    д: "d",
    з: "z",
    и: "n",
    й: "n",
    л: "l",
    п: "n",
    ф: "f",
    ц: "c",
    ч: "y",
    ш: "w",
    щ: "w",
    ы: "h",
    ь: "b",
    ъ: "b",
    ю: "io",
    я: "r",
    "§": "g",
    "%": "g",
  }),
);

function questionFocusTokens(question) {
  const allTokens = uniqueTokens(question);
  const cueTokens = cueFocusTokens(question);
  const numbers = new Set(extractNumbers(question).flatMap(expandNumberToken));
  const filtered = allTokens.filter((token) => {
    if (!token) return false;
    if (numbers.has(token) || /^\d/.test(token)) return true;
    if (FOCUS_STOPWORDS.has(token)) return false;
    return token.length > 2;
  });
  const merged = [];
  for (const token of [...cueTokens, ...filtered]) {
    if (!merged.includes(token)) merged.push(token);
  }
  return merged.slice(0, 16);
}

function cueFocusTokens(question) {
  const raw = normalizeText(question);
  const parts = [];
  const patterns = [
    /с\s+целью\s+(.+?)(?:\s+рекоменд|\s+провод|\s+назнач|$)/u,
    /для\s+(.+?)(?:\s+рекоменд|\s+провод|\s+назнач|$)/u,
    /(?:старше|младше|моложе|до|после)\s+\d+(?:[.,]\d+)?\s+(?:лет|года|месяц|дней|сут)/u,
    /по\s+([а-яa-z0-9 -]{4,48})/u,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[0]) parts.push(match[1] ?? match[0]);
  }
  return uniqueTokens(parts.join(" ")).filter((token) => !FOCUS_STOPWORDS.has(token));
}

function bestFocusedSupport({ pages, topQuestionPages, question, answer, answerTokens, focusTokens, intent }) {
  if (!focusTokens?.length) return null;
  const answerPhrases = focusedAnswerSearchPhrases(answer.text).slice(0, 24);
  let best = null;
  for (const page of pages) {
    if (topQuestionPages?.size && !topQuestionPages.has(page.page)) continue;
    const pageNorm = page.normalized;
    for (const phrase of answerPhrases) {
      const normalizedPhrase = normalizeForSearch(phrase);
      if (!normalizedPhrase || normalizedPhrase.length < 5) continue;
      const hits = findPhraseOccurrences(pageNorm, phrase, { textIsNormalized: true });
      for (const hit of hits) {
        const local = pageWindow(page, hit, 260);
        const localTokens = tokenizeNormalized(local);
        const focusCoverage = coverage(focusTokens, localTokens);
        const questionNumberCoverage = numberCoverage(question, local);
        if (focusCoverage < 0.22 && questionNumberCoverage <= 0) continue;
        const answerCoverage = coverage(answerTokens, localTokens);
        const limitedPenalty = intent.negative || intent.exception ? 0 : limitedCuePenalty(local);
        const score =
          2.2 +
          focusCoverage * 5.2 +
          answerCoverage * 1.2 +
          questionNumberCoverage * (intent.numeric ? 4.0 : 2.2) -
          limitedPenalty;
        if (score <= 2.6) continue;
        best = betterEvidence(best, {
          answerId: answer.id,
          page: page.page,
          text: evidenceSnippet(page.text, phrase, question),
          score,
          kind: "focused_answer_window",
        });
      }
    }
  }
  return best;
}

function lineTokenSegments(page) {
  const lines = page.lines ?? [];
  const segments = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line?.length >= 8) segments.push({ text: line, kind: "line" });
    if (index + 1 < lines.length) {
      const pair = `${line} ${lines[index + 1]}`.replace(/\s+/g, " ").trim();
      if (pair.length >= 16 && pair.length <= 700) segments.push({ text: pair, kind: "line_pair" });
    }
  }
  return segments;
}

function cachedLineTokenSegments(page) {
  if (!page.__lineTokenSegments) {
    Object.defineProperty(page, "__lineTokenSegments", {
      value: lineTokenSegments(page).map((segment) => ({
        ...segment,
        normalized: normalizeForSearch(segment.text),
        tokens: tokenize(segment.text),
      })),
      enumerable: false,
    });
  }
  return page.__lineTokenSegments;
}

function bestLineTokenSupport({ pages, topQuestionPages, question, answer, questionTokens, answerTokens, focusTokens, intent }) {
  if (!answerTokens.length) return null;
  const numericAnswer = extractNumbers(answer.text).length > 0;
  const minAnswerSupport = numericAnswer ? 0.65 : answerTokens.length <= 2 ? 0.95 : 0.62;
  const usefulFocusTokens = (focusTokens?.length ? focusTokens : questionTokens).filter((token) => token.length > 2 || /^\d/.test(token));
  if (!usefulFocusTokens.length) return null;
  const answerPhrases = answerSearchPhrases(answer.text);
  let best = null;

  for (const page of pages) {
    const isTopPage = topQuestionPages?.has(page.page);
    const pageTokens = cachedPageTokens(page);
    const pageFocusHits = tokenHitCount(usefulFocusTokens, pageTokens);
    const pageAnswerSupport = Math.max(strictSoftCoverage(answerTokens, pageTokens), numberCoverage(answer.text, page.normalized));
    if (!isTopPage && (pageFocusHits < 2 || pageAnswerSupport < minAnswerSupport)) continue;
    for (const segment of cachedLineTokenSegments(page)) {
      const segmentTokens = segment.tokens;
      if (!segmentTokens.length) continue;
      const answerCoverage = strictSoftCoverage(answerTokens, segmentTokens);
      const numericCoverage = numberCoverage(answer.text, segment.text);
      const answerSupport = Math.max(answerCoverage, numericCoverage);
      if (answerSupport < minAnswerSupport) continue;

      const focusHits = tokenHitCount(usefulFocusTokens, segmentTokens);
      const focusCoverage = coverage(usefulFocusTokens, segmentTokens);
      const questionNumberCoverage = numberCoverage(question, segment.text);
      const enoughFocus = isTopPage ? focusHits >= 1 || focusCoverage >= 0.16 : focusHits >= 2 || focusCoverage >= 0.24;
      if (!enoughFocus && questionNumberCoverage <= 0) continue;

      const exactPhrase = answerPhrases.some((phrase) => containsNormalizedPhrase(segment.normalized, phrase));
      const lengthPenalty = segment.text.length > 420 ? Math.min(1.4, (segment.text.length - 420) / 220) : 0;
      const score =
        3.2 +
        answerSupport * 4.4 +
        Math.min(0.55, focusCoverage) * 5.2 +
        Math.min(4, focusHits) * 0.42 +
        questionNumberCoverage * (intent.numeric ? 2.5 : 1.2) +
        (exactPhrase ? 0.8 : 0) +
        (isTopPage ? 0.5 : 0) -
        lengthPenalty;
      if (score < 6.2) continue;
      best = betterEvidence(best, {
        answerId: answer.id,
        page: page.page,
        text: segment.text,
        score,
        kind: `line_token_${segment.kind}`,
      });
    }
  }
  return best;
}

function limitedCuePenalty(normalizedText) {
  const limitedCues = ["не рекомендуется", "не рекомендовано", "только в случаях", "при невозможности", "невозможности", "за исключением"];
  let penalty = 0;
  for (const cue of limitedCues) {
    if (containsNormalizedPhrase(normalizedText, cue)) penalty += 0.8;
  }
  return Math.min(1.6, penalty);
}

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

function polarityAdjustment({ pages, topQuestionPages, mode, question, questionTokens, answer }) {
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
  if (containsNormalizedPhrase(normalized, "\u043d\u043e\u0447")) return "night";
  if (containsNormalizedPhrase(normalized, "\u0434\u043d\u0435\u043c") || containsNormalizedPhrase(normalized, "\u0434\u043d\u0435\u0432")) return "day";
  return null;
}

function nearestTemporalCue(local) {
  return nearestCueName(local, [
    ["night", ["\u043d\u043e\u0447"]],
    ["day", ["\u0434\u043d\u0435\u043c", "\u0434\u043d\u0435\u0432"]],
  ]);
}

function temporalCueAdjustment({ mode, pages, topQuestionPages, answer, focusTokens, questionTokens }) {
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

function latinAnswerTokens(text) {
  return String(text ?? "").match(/[A-Za-z][A-Za-z0-9-]{1,}/g) ?? [];
}

function latinTokenVariants(token) {
  const normalized = token.toLowerCase().replace(/[^a-z0-9]/g, "");
  const variants = new Set([normalized]);
  const th = normalized.match(/^th(\d+)$/);
  if (th) {
    if (th[1] === "1") variants.add("th");
    variants.add(`th${th[1].slice(-1)}`);
  }
  return [...variants].filter(Boolean);
}

function geneTokenVariants(token) {
  const normalized = token.toLowerCase().replace(/[^a-z0-9]/g, "");
  const variants = new Set(latinTokenVariants(normalized));
  if (!normalized || normalized.length > 10) return [...variants].filter(Boolean);

  const alternatives = {
    f: ["f", "p"],
    g: ["g", "o", "q"],
    r: ["r", "k"],
    o: ["o", "0"],
    d: ["d", "0"],
    z: ["z", "3"],
    3: ["3", "z"],
    b: ["b", "8"],
    s: ["s", "5"],
    l: ["l", "1", "i"],
    i: ["i", "1", "l"],
  };
  let generated = [""];
  for (const char of normalized) {
    const choices = alternatives[char] ?? [char];
    const next = [];
    for (const prefix of generated) {
      for (const choice of choices) {
        next.push(`${prefix}${choice}`);
        if (next.length >= 96) break;
      }
      if (next.length >= 96) break;
    }
    generated = next;
  }
  for (const variant of generated) variants.add(variant);
  return [...variants].filter(Boolean);
}

function relaxedLatinText(text) {
  let out = "";
  for (const char of String(text ?? "").normalize("NFKC")) {
    out += OCR_LATIN_MAP.get(char) ?? char;
  }
  return out.toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

function relaxedLatinTokens(text) {
  const rawTokens = relaxedLatinText(text).match(/[a-z0-9]+/g) ?? [];
  const joined = [];
  for (let index = 0; index < rawTokens.length - 1; index += 1) {
    if (/^[a-z]+$/.test(rawTokens[index]) && /^\d+$/.test(rawTokens[index + 1])) joined.push(`${rawTokens[index]}${rawTokens[index + 1]}`);
    if (/^[a-z]{1,5}$/.test(rawTokens[index])) {
      let digits = "";
      for (let cursor = index + 1; cursor < rawTokens.length && cursor <= index + 5; cursor += 1) {
        if (!/^\d$/.test(rawTokens[cursor])) break;
        digits += rawTokens[cursor];
        if (digits.length >= 2) joined.push(`${rawTokens[index]}${digits}`);
      }
    }
  }
  const tokens = rawTokens.filter((token) => token.length >= 2);
  return [...tokens, ...joined];
}

function cachedLatinTokens(page) {
  if (!page.__latinTokens) Object.defineProperty(page, "__latinTokens", { value: relaxedLatinTokens(page.text), enumerable: false });
  return page.__latinTokens;
}

function diceSimilarity(left, right) {
  const a = String(left ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const b = String(right ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length <= 3 || b.length <= 3) {
    if (/\d/.test(a) || /\d/.test(b)) return 0;
    return a.startsWith(b) || b.startsWith(a) ? 0.72 : 0;
  }
  const counts = new Map();
  for (let index = 0; index < a.length - 1; index += 1) {
    const gram = a.slice(index, index + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let hit = 0;
  for (let index = 0; index < b.length - 1; index += 1) {
    const gram = b.slice(index, index + 2);
    const count = counts.get(gram) ?? 0;
    if (count > 0) {
      hit += 1;
      counts.set(gram, count - 1);
    }
  }
  return (2 * hit) / Math.max(1, a.length + b.length - 2);
}

function bestLatinFuzzySupport({ pages, topQuestionPages, questionTokens, answer }) {
  const latinTokens = latinAnswerTokens(answer.text);
  if (!latinTokens.length) return null;
  let best = null;

  for (const page of pages) {
    if (topQuestionPages?.size && !topQuestionPages.has(page.page)) continue;
    const questionCoverage = coverage(questionTokens, cachedPageTokens(page));
    if (questionCoverage < 0.12) continue;
    const pageTokens = cachedLatinTokens(page);
    if (!pageTokens.length) continue;
    let total = 0;
    let strong = 0;
    for (const token of latinTokens) {
      let tokenBest = 0;
      for (const variant of latinTokenVariants(token)) {
        for (const pageToken of pageTokens) {
          tokenBest = Math.max(tokenBest, diceSimilarity(variant, pageToken));
        }
      }
      if (tokenBest >= 0.58) strong += 1;
      total += tokenBest;
    }
    const average = total / latinTokens.length;
    if (average < 0.32 && strong < latinTokens.length) continue;
    const score = 4.2 + average * 5.0 + strong * 0.9 + questionCoverage * 2.0;
    best = betterEvidence(best, {
      answerId: answer.id,
      page: page.page,
      text: evidenceSnippet(page.text, latinTokens[0]),
      score,
      kind: "latin_fuzzy_ocr",
    });
  }
  return best;
}

const GENE_QUESTION_GENERIC_TOKENS = new Set(
  [
    "\u0433\u0435\u043d",
    "\u0433\u0435\u043d\u0430",
    "\u0433\u0435\u043d\u0430\u0445",
    "\u0433\u0435\u043d\u043e\u0432",
    "\u043c\u0443\u0442\u0430\u0446\u0438\u044f",
    "\u043c\u0443\u0442\u0430\u0446\u0438\u0438",
    "\u043c\u0443\u0442\u0430\u0446\u0438\u0439",
    "\u043f\u043e\u043b\u0438\u043c\u043e\u0440\u0444\u0438\u0437\u043c",
    "\u043f\u043e\u043b\u0438\u043c\u043e\u0440\u0444\u0438\u0437\u043c\u044b",
    "\u043e\u043f\u0440\u0435\u0434\u0435\u043b\u044f\u044e\u0442\u0441\u044f",
    "\u0441\u0432\u044f\u0437\u044b\u0432\u0430\u044e\u0442",
    "\u0440\u0438\u0441\u043a",
    "\u0440\u0430\u0437\u0432\u0438\u0442\u0438\u044f",
  ].flatMap((item) => uniqueTokens(item)),
);

function geneMutationQuestion(question) {
  const normalized = normalizeForSearch(question);
  const tokens = new Set(tokenize(question, { keepStopwords: true }));
  const geneRoot = normalizeForSearch("\u0433\u0435\u043d");
  const hasGeneToken = [...tokens].some((token) => token === geneRoot || token.startsWith(geneRoot));
  const hasMutationCue =
    containsNormalizedPhrase(normalized, "\u043c\u0443\u0442\u0430\u0446") ||
    containsNormalizedPhrase(normalized, "\u043f\u043e\u043b\u0438\u043c\u043e\u0440\u0444");
  return hasGeneToken && hasMutationCue;
}

function geneQuestionFocusTokens(question) {
  return uniqueTokens(question).filter((token) => token.length >= 4 && !GENE_QUESTION_GENERIC_TOKENS.has(token));
}

function sentenceSegments(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 24);
}

function geneSentenceHit(sentence, answerText) {
  const answerTokens = latinAnswerTokens(answerText);
  if (!answerTokens.length || answerTokens.length > 2) return null;
  const sentenceTokens = new Set(relaxedLatinTokens(sentence));
  for (const token of answerTokens) {
    let bestVariant = null;
    for (const variant of geneTokenVariants(token)) {
      if (sentenceTokens.has(variant)) {
        bestVariant = variant;
        break;
      }
    }
    if (bestVariant) return { token, variant: bestVariant };
  }
  return null;
}

function bestGeneSentenceSupport({ pages, topQuestionPages, question, answer }) {
  if (!geneMutationQuestion(question)) return null;
  const focusTokens = geneQuestionFocusTokens(question);
  let best = null;

  for (const page of pages) {
    const nearTopPage =
      !topQuestionPages?.size || topQuestionPages.has(page.page) || topQuestionPages.has(page.page - 1) || topQuestionPages.has(page.page + 1);
    if (!nearTopPage) continue;
    for (const sentence of sentenceSegments(page.text)) {
      const normalized = normalizeForSearch(sentence);
      const hasGeneCue = containsNormalizedPhrase(normalized, "\u0433\u0435\u043d");
      if (!hasGeneCue) continue;
      const sentenceTokens = tokenizeNormalized(normalized);
      const focusHits = tokenHitCount(focusTokens, sentenceTokens);
      if (focusTokens.length && focusHits <= 0) continue;
      const hit = geneSentenceHit(sentence, answer.text);
      if (!hit) continue;
      const score = 13.6 + Math.min(3, focusHits) * 1.35 + (hit.variant === hit.token.toLowerCase() ? 2.2 : 1.4);
      best = betterEvidence(best, {
        answerId: answer.id,
        page: page.page,
        text: sentence,
        score,
        kind: "gene_sentence_segment",
      });
    }
  }
  return best;
}

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
    const nearTopPage =
      !topQuestionPages?.size || topQuestionPages.has(page.page) || topQuestionPages.has(page.page - 1) || topQuestionPages.has(page.page + 1);
    if (!nearTopPage) continue;
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

function bestClozeGapSupport({ mode, pages, topQuestionPages, question, answer, answerTokens, focusTokens }) {
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

const COORDINATE_TABLE_GENERIC_TOKENS = new Set(
  [
    "\u0442\u0430\u0431\u043b\u0438\u0446\u0430 \u0442\u0430\u0431\u043b\u0438\u0446\u0435 \u0442\u0430\u0431\u043b\u0438\u0447\u043d\u044b\u0439 \u0441\u043e\u0433\u043b\u0430\u0441\u043d\u043e",
    "\u043f\u043e\u043a\u0430\u0437\u0430\u0442\u0435\u043b\u044c \u043f\u043e\u043a\u0430\u0437\u0430\u0442\u0435\u043b\u0438 \u0437\u043d\u0430\u0447\u0435\u043d\u0438\u0435 \u0437\u043d\u0430\u0447\u0435\u043d\u0438\u044f",
    "\u043a\u0440\u0438\u0442\u0435\u0440\u0438\u0439 \u043a\u0440\u0438\u0442\u0435\u0440\u0438\u0438 \u043f\u0440\u0438\u0437\u043d\u0430\u043a \u043f\u0440\u0438\u0437\u043d\u0430\u043a\u0438",
    "\u043a\u043b\u0430\u0441\u0441\u0438\u0444\u0438\u043a\u0430\u0446\u0438\u044f \u043a\u043b\u0430\u0441\u0441\u0438\u0444\u0438\u043a\u0430\u0446\u0438\u0438 \u0433\u0440\u0430\u0434\u0430\u0446\u0438\u044f",
    "\u043f\u043e\u043a\u0430\u0437\u0430\u043d\u0438\u044f \u043f\u043e\u043a\u0430\u0437\u0430\u043d\u0438\u0435 \u0441\u043e\u0441\u0442\u0430\u0432\u043b\u044f\u0435\u0442 \u0441\u043e\u0441\u0442\u0430\u0432\u043b\u044f\u044e\u0442",
  ].flatMap((item) => uniqueTokens(item)),
);

const COORDINATE_TABLE_CUE_TOKENS = new Set(
  [
    "\u0442\u0430\u0431\u043b\u0438\u0446\u0430 \u0442\u0430\u0431\u043b\u0438\u0446\u0435 \u0448\u043a\u0430\u043b\u0430 \u0448\u043a\u0430\u043b\u0435 \u043a\u043b\u0430\u0441\u0441\u0438\u0444\u0438\u043a\u0430\u0446\u0438\u044f \u043a\u043b\u0430\u0441\u0441\u0438\u0444\u0438\u043a\u0430\u0446\u0438\u0438",
    "\u0441\u0442\u0435\u043f\u0435\u043d\u044c \u0441\u0442\u0435\u043f\u0435\u043d\u0438 \u0441\u0442\u0430\u0434\u0438\u044f \u0441\u0442\u0430\u0434\u0438\u0438 \u043a\u043b\u0430\u0441\u0441 \u043a\u043b\u0430\u0441\u0441\u0430 \u043a\u0430\u0442\u0435\u0433\u043e\u0440\u0438\u044f \u043a\u0430\u0442\u0435\u0433\u043e\u0440\u0438\u0438",
    "\u043f\u043e\u043a\u0430\u0437\u0430\u0442\u0435\u043b\u044c \u043f\u043e\u043a\u0430\u0437\u0430\u0442\u0435\u043b\u0438 \u043f\u043e\u043a\u0430\u0437\u0430\u043d\u0438\u044f \u043f\u043e\u043a\u0430\u0437\u0430\u043d\u0438\u0435",
    "\u043a\u0440\u0438\u0442\u0435\u0440\u0438\u0439 \u043a\u0440\u0438\u0442\u0435\u0440\u0438\u0438 \u0433\u0440\u0430\u0434\u0430\u0446\u0438\u044f \u0430\u0431\u0441\u043e\u043b\u044e\u0442\u043d\u044b\u0435 \u043e\u0442\u043d\u043e\u0441\u0438\u0442\u0435\u043b\u044c\u043d\u044b\u0435",
  ].flatMap((item) => uniqueTokens(item)),
);

function hasCoordinateTableCue(question, focusTokens) {
  const raw = String(question ?? "").toLowerCase();
  const rawCue = [
    "\u0442\u0430\u0431\u043b\u0438\u0446",
    "\u0448\u043a\u0430\u043b",
    "\u043a\u043b\u0430\u0441\u0441\u0438\u0444",
    "\u0441\u0442\u0435\u043f\u0435\u043d",
    "\u0441\u0442\u0430\u0434",
    "\u043a\u043b\u0430\u0441\u0441",
    "\u043a\u0430\u0442\u0435\u0433\u043e\u0440",
    "\u043f\u043e\u043a\u0430\u0437\u0430\u0442\u0435\u043b",
    "\u043f\u043e\u043a\u0430\u0437\u0430\u043d",
    "\u043a\u0440\u0438\u0442\u0435\u0440",
    "\u0433\u0440\u0430\u0434\u0430\u0446",
    "\u0430\u0431\u0441\u043e\u043b\u044e\u0442",
    "\u043e\u0442\u043d\u043e\u0441\u0438\u0442\u0435\u043b",
  ].some((cue) => raw.includes(cue));
  if (rawCue) return true;
  const tokens = [...new Set([...(focusTokens ?? []), ...uniqueTokens(question)])];
  return tokens.some((token) => COORDINATE_TABLE_CUE_TOKENS.has(token));
}

function hasCoordinateTableGroupCue(question, focusTokens, intent) {
  if (hasCoordinateTableCue(question, focusTokens)) return true;
  if (intent?.listLike) return true;
  const normalized = normalizeForSearch(question);
  const cuePhrases = [
    "\u0433\u0440\u0443\u043f\u043f",
    "\u043e\u0442\u043d\u043e\u0441",
    "\u0432\u043a\u043b\u044e\u0447",
    "\u0441\u043e\u0441\u0442\u0430\u0432",
    "\u043f\u0440\u0435\u0434\u0441\u0442\u0430\u0432",
    "\u043a\u043e\u043c\u0431\u0438\u043d\u0430\u0446",
  ].map((item) => normalizeForSearch(item));
  if (cuePhrases.some((cue) => containsNormalizedPhrase(normalized, cue))) return true;
  const tokens = [...new Set([...(focusTokens ?? []), ...uniqueTokens(question)])];
  return tokenHitCount([...COORDINATE_TABLE_CUE_TOKENS], tokens) > 0;
}

function coordinateCellText(cell) {
  return String(cell?.text ?? "").replace(/\s+/g, " ").trim();
}

function coordinateLineCells(line) {
  const items = [...(line?.items ?? [])]
    .filter((item) => String(item?.text ?? "").trim())
    .sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
  const cells = [];

  for (const item of items) {
    const text = String(item.text ?? "").replace(/\s+/g, " ").trim();
    const x = item.x ?? 0;
    const width = item.width ?? Math.max(8, text.length * 4.2);
    const endX = x + Math.max(width, 4);
    const previous = cells[cells.length - 1];
    if (!previous) {
      cells.push({ text, x, endX, y: item.y ?? line?.y ?? 0, itemCount: 1 });
      continue;
    }

    const visualGap = x - previous.endX;
    const originGap = x - previous.x;
    if (visualGap > 18 && originGap > 34) {
      cells.push({ text, x, endX, y: item.y ?? line?.y ?? 0, itemCount: 1 });
    } else {
      previous.text = `${previous.text} ${text}`.replace(/\s+/g, " ").trim();
      previous.endX = Math.max(previous.endX, endX);
      previous.itemCount += 1;
    }
  }

  return cells.filter((cell) => coordinateCellText(cell));
}

function coordinateGroupLineCells(line) {
  const items = [...(line?.items ?? [])]
    .filter((item) => String(item?.text ?? "").trim())
    .sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
  const cells = [];

  for (const item of items) {
    const text = String(item.text ?? "").replace(/\s+/g, " ").trim();
    const x = item.x ?? 0;
    const width = item.width ?? Math.max(8, text.length * 4.2);
    const endX = x + Math.max(width, 4);
    const previous = cells[cells.length - 1];
    if (!previous) {
      cells.push({ text, x, endX, y: item.y ?? line?.y ?? 0, itemCount: 1 });
      continue;
    }

    const visualGap = x - previous.endX;
    const originGap = x - previous.x;
    if (visualGap > 18 || originGap > 64) {
      cells.push({ text, x, endX, y: item.y ?? line?.y ?? 0, itemCount: 1 });
    } else {
      previous.text = `${previous.text} ${text}`.replace(/\s+/g, " ").trim();
      previous.endX = Math.max(previous.endX, endX);
      previous.itemCount += 1;
    }
  }

  return cells.filter((cell) => coordinateCellText(cell));
}

function coordinateCellsSpread(cells) {
  if (cells.length < 2) return 0;
  return Math.max(...cells.map((cell) => cell.endX)) - Math.min(...cells.map((cell) => cell.x));
}

function coordinateCellsHaveNumericValue(cells) {
  return cells.some((cell) => extractNumbers(cell.text).length > 0 || /[<>≤≥=]/u.test(String(cell.text ?? "")));
}

function isCoordinateTableLine(line, cells = coordinateLineCells(line)) {
  if (!cells.length) return false;
  const text = String(line?.text ?? "").replace(/\s+/g, " ").trim();
  const spread = coordinateCellsSpread(cells);
  if (text.length > 340) return false;
  if (cells.length >= 3 && spread >= 135) return true;
  if (cells.length >= 2 && spread >= 190 && coordinateCellsHaveNumericValue(cells)) return true;
  return false;
}

function coordinateLineHasHeaderCue(line) {
  const tokens = tokenize(line?.text ?? "");
  return tokenHitCount([...COORDINATE_TABLE_CUE_TOKENS], tokens) > 0;
}

function coordinateTextHasTableCaption(text) {
  const normalized = normalizeForSearch(text);
  if (containsNormalizedPhrase(normalized, "\u0441\u043e\u0433\u043b\u0430\u0441\u043d\u043e \u0442\u0430\u0431\u043b\u0438\u0446")) return false;
  return (
    containsNormalizedPhrase(normalized, "\u0442\u0430\u0431\u043b\u0438\u0446") ||
    containsNormalizedPhrase(normalized, "\u0448\u043a\u0430\u043b") ||
    containsNormalizedPhrase(normalized, "\u0433\u0440\u0430\u0434\u0430\u0446") ||
    containsNormalizedPhrase(normalized, "\u043a\u043b\u0430\u0441\u0441\u0438\u0444")
  );
}

function coordinateTextHasExplicitTableCaption(text) {
  const normalized = normalizeForSearch(text);
  if (containsNormalizedPhrase(normalized, "\u0441\u043e\u0433\u043b\u0430\u0441\u043d\u043e \u0442\u0430\u0431\u043b\u0438\u0446")) return false;
  return containsNormalizedPhrase(normalized, "\u0442\u0430\u0431\u043b\u0438\u0446");
}

function coordinateTextIsRecommendationMeta(text) {
  const raw = String(text ?? "").toLowerCase();
  if (
    raw.includes("\u0443\u0440\u043e\u0432\u0435\u043d\u044c \u0443\u0431\u0435\u0434\u0438\u0442\u0435\u043b\u044c\u043d\u043e\u0441\u0442") ||
    raw.includes("\u0434\u043e\u0441\u0442\u043e\u0432\u0435\u0440\u043d\u043e\u0441\u0442") ||
    raw.includes("\u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434") ||
    raw.includes("\u043a\u043e\u043c\u043c\u0435\u043d\u0442")
  ) {
    return true;
  }
  const normalized = normalizeForSearch(text);
  return (
    containsNormalizedPhrase(normalized, "\u0443\u0440\u043e\u0432\u0435\u043d\u044c \u0443\u0431\u0435\u0434\u0438\u0442\u0435\u043b\u044c\u043d\u043e\u0441\u0442") ||
    containsNormalizedPhrase(normalized, "\u0434\u043e\u0441\u0442\u043e\u0432\u0435\u0440\u043d\u043e\u0441\u0442\u0438 \u0434\u043e\u043a\u0430\u0437") ||
    containsNormalizedPhrase(normalized, "\u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434") ||
    containsNormalizedPhrase(normalized, "\u043a\u043e\u043c\u043c\u0435\u043d\u0442\u0430\u0440")
  );
}

function coordinateLineLooksLikeDataRow(line, cells = coordinateLineCells(line)) {
  if (!cells.length) return false;
  if (coordinateLineHasHeaderCue(line)) return false;
  const firstCell = normalizeForSearch(cells[0]?.text ?? "");
  const firstTwoText = cells
    .slice(0, 2)
    .map((cell) => cell.text)
    .join(" ");
  if (/^(?:[ivxlcdm]+|\d+(?:[.)])?)$/iu.test(firstCell)) return true;
  if (severityCue(firstTwoText)) return true;
  if (cells.length >= 3 && coordinateCellsHaveNumericValue(cells) && !containsNormalizedPhrase(normalizeForSearch(line?.text ?? ""), "\u0442\u0430\u0431\u043b\u0438\u0446")) return true;
  return false;
}

function coordinateSeverityCueCount(text) {
  const normalized = normalizeForSearch(text);
  const cues = [
    "\u043a\u0440\u0430\u0439\u043d",
    "\u0441\u0440\u0435\u0434\u043d\u0435\u0442\u044f\u0436",
    "\u0441\u0440\u0435\u0434\u043d",
    "\u0443\u043c\u0435\u0440\u0435\u043d",
    "\u0442\u044f\u0436\u0435\u043b",
    "\u043b\u0435\u0433\u043a",
  ];
  let count = 0;
  for (const cue of cues) {
    if (containsNormalizedPhrase(normalized, cue)) count += 1;
  }
  return count;
}

function coordinateRowHasTableContext(row) {
  const firstCell = normalizeForSearch(row.cells?.[0]?.text ?? "");
  const firstTwoText = (row.cells ?? [])
    .slice(0, 2)
    .map((cell) => cell.text)
    .join(" ");
  const structuralFirstCell =
    ((row.cells?.length ?? 0) >= 3 && /^(?:[ivxlcdm]+|\d+(?:[.)])?)$/iu.test(firstCell)) ||
    ((row.cells?.length ?? 0) >= 3 && severityCue(firstTwoText));
  if (coordinateTextIsRecommendationMeta(row.sourceText || row.text) && !structuralFirstCell) return false;
  if (coordinateTextHasTableCaption(row.headerText)) return true;
  if (structuralFirstCell) return true;
  return false;
}

function coordinateTableQuestionBlocked(question) {
  const normalized = normalizeForSearch(question);
  return containsNormalizedPhrase(normalized, "\u0444\u0438\u0431\u0440\u043e\u0437") || containsNormalizedPhrase(normalized, "metavir");
}

function nearestCoordinateCell(cells, x) {
  let best = null;
  let bestDistance = Infinity;
  for (const cell of cells) {
    const center = (cell.x + cell.endX) / 2;
    const distance = Math.min(Math.abs(cell.x - x), Math.abs(center - x));
    if (distance < bestDistance) {
      best = cell;
      bestDistance = distance;
    }
  }
  return bestDistance <= 54 ? best : null;
}

function appendCoordinateContinuation(baseCells, continuationCells) {
  let appended = false;
  for (const cell of continuationCells) {
    const target = nearestCoordinateCell(baseCells, cell.x);
    if (!target) continue;
    target.text = `${target.text} ${cell.text}`.replace(/\s+/g, " ").trim();
    target.endX = Math.max(target.endX, cell.endX);
    target.itemCount += cell.itemCount ?? 1;
    appended = true;
  }
  return appended;
}

function coordinateHeaderText(lines, index) {
  const parts = [];
  for (let current = index - 1; current >= 0 && parts.length < 5; current -= 1) {
    const line = lines[current];
    const text = String(line?.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (coordinateTextIsRecommendationMeta(text)) break;
    const cells = coordinateLineCells(line);
    if (coordinateLineLooksLikeDataRow(line, cells)) break;
    const normalized = normalizeForSearch(text);
    const headerLike =
      isCoordinateTableLine(line, cells) ||
      containsNormalizedPhrase(normalized, "\u0442\u0430\u0431\u043b\u0438\u0446") ||
      (text.length <= 140 && (cells.length <= 2 || coordinateCellsSpread(cells) < 180));
    if (!headerLike) break;
    parts.unshift(text);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function coordinateNearbyTableContext(lines, index) {
  const localHeader = coordinateHeaderText(lines, index);
  if (coordinateTextHasTableCaption(localHeader)) return localHeader;
  const parts = [];
  for (let current = index - 1; current >= 0 && current >= index - 24; current -= 1) {
    const line = lines[current];
    const text = String(line?.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (coordinateTextHasTableCaption(text)) {
      parts.unshift(text);
      break;
    }
  }
  return [...parts, localHeader].join(" ").replace(/\s+/g, " ").trim();
}

function coordinateTableRows(page) {
  if (page.__coordinateTableRows) return page.__coordinateTableRows;
  const lines = page.lineItems ?? [];
  const rows = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const baseCells = coordinateLineCells(line).map((cell) => ({ ...cell }));
    if (!isCoordinateTableLine(line, baseCells)) continue;

    let previousY = line?.y ?? 0;
    const rowLineTexts = [line.text];
    for (let nextIndex = index + 1; nextIndex < lines.length && nextIndex <= index + 4; nextIndex += 1) {
      const nextLine = lines[nextIndex];
      const y = nextLine?.y ?? previousY;
      if (Math.abs(y - previousY) > 25) break;
      const nextCells = coordinateLineCells(nextLine);
      if (!nextCells.length) break;
      const looksLikeNewRow =
        isCoordinateTableLine(nextLine, nextCells) &&
        nextCells.length >= Math.max(2, baseCells.length - 1) &&
        Math.abs((nextCells[0]?.x ?? 0) - (baseCells[0]?.x ?? 0)) <= 32;
      if (looksLikeNewRow) break;
      const appended = appendCoordinateContinuation(baseCells, nextCells);
      if (!appended) break;
      rowLineTexts.push(nextLine.text);
      previousY = y;
    }

    const text = baseCells.map((cell) => cell.text).join(" ").replace(/\s+/g, " ").trim();
    if (text.length < 8) continue;
    rows.push({
      page: page.page,
      index,
      y: line?.y ?? 0,
      headerText: coordinateHeaderText(lines, index),
      text,
      sourceText: rowLineTexts.join(" ").replace(/\s+/g, " ").trim(),
      cells: baseCells.map((cell, cellIndex) => ({
        ...cell,
        index: cellIndex,
        normalized: normalizeForSearch(cell.text),
        tokens: tokenize(cell.text),
      })),
    });
  }

  Object.defineProperty(page, "__coordinateTableRows", {
    value: rows,
    enumerable: false,
  });
  return rows;
}

function buildCoordinateTableRowsByPage(pages, topQuestionPages) {
  const byPage = new Map();
  for (const page of pages) {
    const nearTopPage =
      !topQuestionPages?.size || topQuestionPages.has(page.page) || topQuestionPages.has(page.page - 1) || topQuestionPages.has(page.page + 1);
    if (!nearTopPage) continue;
    const rows = coordinateTableRows(page);
    if (rows.length) byPage.set(page.page, rows);
  }
  return byPage;
}

function coordinateGroupLineLooksLikeStart(cells) {
  if (cells.length < 2) return false;
  const spread = coordinateCellsSpread(cells);
  if (spread < 115) return false;
  const firstX = cells[0]?.x ?? 0;
  const lastX = cells[cells.length - 1]?.x ?? firstX;
  return lastX - firstX >= 85;
}

function coordinateLooksLikeTableBoundary(line) {
  const text = String(line?.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) return true;
  const normalized = normalizeForSearch(text);
  if (containsNormalizedPhrase(normalized, "\u0442\u0430\u0431\u043b\u0438\u0446") && !/^\s*\u0442\u0430\u0431\u043b\u0438\u0446/u.test(text.toLowerCase())) return false;
  if (/^\s*(?:\d+\.){1,3}\s+/u.test(text)) return true;
  if (text.length <= 90 && /^(?:\u0440\u0438\u0441\u0443\u043d\u043e\u043a|\u0441\u043f\u0438\u0441\u043e\u043a|\u043f\u0440\u0438\u043b\u043e\u0436\u0435\u043d\u0438\u0435)\b/iu.test(text)) return true;
  return false;
}

function coordinateShortCodeLike(text) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!value) return false;
  if (value.length > 44) return false;
  if (/[a-z\u0430-\u044f]{3,}/u.test(value)) return false;
  if (/[()]/u.test(value) && /[A-Z\u0410-\u042f0-9]{2,}/u.test(value)) return true;
  if (/\*\*/u.test(value)) return true;
  return /^[A-Z\u0410-\u042f0-9./+-]{2,}(?:\s+[A-Z\u0410-\u042f0-9./+-]{2,}){0,2}$/u.test(value);
}

function coordinateLabelContinuationLikely(labelText, nextLabelText, nextValueText) {
  const labelTokens = uniqueTokens(labelText);
  const nextTokens = uniqueTokens(nextLabelText);
  if (!labelTokens.length || !nextTokens.length) return false;
  if (coordinateShortCodeLike(nextValueText)) return true;
  if (String(labelText ?? "").length <= 48 && /[()/]/u.test(String(nextLabelText ?? ""))) return true;
  return false;
}

function coordinateGroupHeaderCells(cells) {
  const text = cells
    .map((cell) => cell.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const normalized = normalizeForSearch(text);
  const columnCueCount = [
    "\u043a\u043b\u0430\u0441\u0441",
    "\u0433\u0440\u0443\u043f\u043f",
    "\u043f\u0440\u0435\u043f\u0430\u0440\u0430\u0442",
    "\u043f\u043e\u043a\u0430\u0437\u0430\u0442",
    "\u0437\u043d\u0430\u0447\u0435\u043d",
    "\u043a\u0440\u0438\u0442\u0435\u0440",
    "\u043f\u0440\u0438\u0437\u043d\u0430\u043a",
    "\u043a\u0430\u0442\u0435\u0433\u043e\u0440",
    "\u044d\u0444\u0444\u0435\u043a\u0442",
  ]
    .map((item) => normalizeForSearch(item))
    .filter((cue) => containsNormalizedPhrase(normalized, cue)).length;
  return columnCueCount >= 2 && cells.every((cell) => coordinateCellText(cell).length <= 70);
}

function coordinateSplitGroupCells(cells, valueX) {
  const labelCells = [];
  const valueCells = [];
  for (const cell of cells) {
    const x = cell.x ?? 0;
    const center = (x + (cell.endX ?? x)) / 2;
    if (center < valueX - 28) labelCells.push(cell);
    else valueCells.push(cell);
  }
  return { labelCells, valueCells };
}

function coordinateAppendGroupText(parts, cells) {
  for (const cell of cells) {
    const text = coordinateCellText(cell);
    if (text) parts.push(text);
  }
}

function coordinateTableGroups(page) {
  if (page.__coordinateTableGroups) return page.__coordinateTableGroups;
  const lines = page.lineItems ?? [];
  const groups = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const cells = coordinateGroupLineCells(line).map((cell) => ({ ...cell }));
    if (!coordinateGroupLineLooksLikeStart(cells)) continue;
    if (coordinateGroupHeaderCells(cells)) continue;

    const valueX = cells[cells.length - 1]?.x ?? 0;
    const labelX = cells[0]?.x ?? 0;
    const baseSplit = coordinateSplitGroupCells(cells, valueX);
    if (!baseSplit.labelCells.length || !baseSplit.valueCells.length) continue;

    const labelParts = [];
    const valueParts = [];
    const rowLineTexts = [line.text];
    coordinateAppendGroupText(labelParts, baseSplit.labelCells);
    coordinateAppendGroupText(valueParts, baseSplit.valueCells);

    let previousY = line?.y ?? 0;
    for (let nextIndex = index + 1; nextIndex < lines.length && nextIndex <= index + 9; nextIndex += 1) {
      const nextLine = lines[nextIndex];
      const y = nextLine?.y ?? previousY;
      if (Math.abs(y - previousY) > 28) break;
      if (coordinateLooksLikeTableBoundary(nextLine)) break;
      const nextCells = coordinateGroupLineCells(nextLine).map((cell) => ({ ...cell }));
      if (!nextCells.length) break;

      const split = coordinateSplitGroupCells(nextCells, valueX);
      const nextLabelText = split.labelCells.map((cell) => cell.text).join(" ").replace(/\s+/g, " ").trim();
      const nextValueText = split.valueCells.map((cell) => cell.text).join(" ").replace(/\s+/g, " ").trim();
      const hasAlignedLabel = split.labelCells.some((cell) => Math.abs((cell.x ?? 0) - labelX) <= 34);
      const hasAlignedValue = split.valueCells.some((cell) => Math.abs((cell.x ?? 0) - valueX) <= 58);
      const looksLikeNewStart = coordinateGroupLineLooksLikeStart(nextCells) && hasAlignedLabel && hasAlignedValue;
      const shouldMergeStart =
        looksLikeNewStart &&
        coordinateLabelContinuationLikely(labelParts.join(" "), nextLabelText, nextValueText);

      if (looksLikeNewStart && !shouldMergeStart) break;
      if (!hasAlignedValue && !hasAlignedLabel) break;
      coordinateAppendGroupText(labelParts, split.labelCells);
      coordinateAppendGroupText(valueParts, split.valueCells);
      rowLineTexts.push(nextLine.text);
      previousY = y;
    }

    const labelText = labelParts.join(" ").replace(/\s+/g, " ").trim();
    const valueText = valueParts.join(" ").replace(/\s+/g, " ").trim();
    const text = `${labelText} ${valueText}`.replace(/\s+/g, " ").trim();
    if (labelText.length < 3 || valueText.length < 3 || text.length < 12) continue;

    groups.push({
      page: page.page,
      index,
      y: line?.y ?? 0,
      headerText: coordinateNearbyTableContext(lines, index),
      labelText,
      valueText,
      text,
      sourceText: rowLineTexts.join(" ").replace(/\s+/g, " ").trim(),
      valueX,
      labelX,
      labelTokens: uniqueTokens(labelText),
      valueTokens: uniqueTokens(valueText),
    });
  }

  Object.defineProperty(page, "__coordinateTableGroups", {
    value: groups,
    enumerable: false,
  });
  return groups;
}

function buildCoordinateTableGroupsByPage(pages, topQuestionPages) {
  const byPage = new Map();
  for (const page of pages) {
    const nearTopPage =
      !topQuestionPages?.size || topQuestionPages.has(page.page) || topQuestionPages.has(page.page - 1) || topQuestionPages.has(page.page + 1);
    if (!nearTopPage) continue;
    const groups = coordinateTableGroups(page).filter((group) => coordinateTextHasExplicitTableCaption(group.headerText));
    if (groups.length) byPage.set(page.page, groups);
  }
  return byPage;
}

function coordinateMultiCellHeaderRow(cells) {
  const first = normalizeForSearch(cells[0]?.text ?? "");
  const rest = normalizeForSearch(
    cells
      .slice(1)
      .map((cell) => cell.text)
      .join(" "),
  );
  const firstHeader =
    containsNormalizedPhrase(first, "\u0441\u0442\u0435\u043f\u0435\u043d") ||
    containsNormalizedPhrase(first, "\u0441\u0442\u0430\u0434") ||
    containsNormalizedPhrase(first, "\u043a\u043b\u0430\u0441\u0441") ||
    containsNormalizedPhrase(first, "\u043a\u0430\u0442\u0435\u0433\u043e\u0440") ||
    containsNormalizedPhrase(first, "\u0433\u0440\u0443\u043f\u043f");
  const restHeader =
    containsNormalizedPhrase(rest, "\u043a\u043b\u0438\u043d\u0438\u0447") ||
    containsNormalizedPhrase(rest, "\u043f\u0440\u0438\u0437\u043d\u0430\u043a") ||
    containsNormalizedPhrase(rest, "\u043e\u0431\u044a\u0435\u043c") ||
    containsNormalizedPhrase(rest, "\u0437\u043d\u0430\u0447\u0435\u043d") ||
    containsNormalizedPhrase(rest, "\u043f\u043e\u043a\u0430\u0437");
  return firstHeader && restHeader;
}

function coordinateMultiCellGenericLabel(text) {
  const normalized = normalizeForSearch(text);
  return [
    "\u044d\u0444\u0444\u0435\u043a\u0442",
    "\u0433\u0440\u0443\u043f\u043f\u0430",
    "\u043f\u0440\u0438\u0437\u043d\u0430\u043a",
    "\u043f\u043e\u043a\u0430\u0437\u0430\u0442\u0435\u043b\u044c",
    "\u0437\u043d\u0430\u0447\u0435\u043d\u0438\u0435",
    "\u043f\u0440\u0435\u043f\u0430\u0440\u0430\u0442\u044b",
    "\u0441\u043f\u043e\u0441\u043e\u0431",
  ].some((cue) => containsNormalizedPhrase(normalized, cue));
}

function coordinateMultiCellGenericValue(text) {
  const normalized = normalizeForSearch(text);
  return [
    "\u0433\u0440\u0443\u043f\u043f\u0430",
    "\u043f\u0440\u0435\u043f\u0430\u0440\u0430\u0442\u044b",
    "\u0441\u043f\u043e\u0441\u043e\u0431 \u043f\u0440\u0438\u043c\u0435\u043d\u0435\u043d\u0438\u044f",
  ].some((cue) => containsNormalizedPhrase(normalized, cue));
}

function coordinateMultiCellRows(page) {
  if (page.__coordinateMultiCellRows) return page.__coordinateMultiCellRows;
  const lines = page.lineItems ?? [];
  const rows = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const cells = coordinateGroupLineCells(line).map((cell) => ({ ...cell }));
    if (!coordinateGroupLineLooksLikeStart(cells)) continue;
    if (coordinateGroupHeaderCells(cells) || coordinateMultiCellHeaderRow(cells)) continue;
    const headerText = coordinateNearbyTableContext(lines, index);
    if (!coordinateTextHasExplicitTableCaption(headerText)) continue;

    const labelCell = cells[0];
    const labelText = coordinateCellText(labelCell);
    if (labelText.length < 3 || labelText.length > 90) continue;
    if (coordinateMultiCellGenericLabel(labelText) && coordinateMultiCellGenericValue(cells.slice(1).map((cell) => cell.text).join(" "))) continue;

    const labelX = labelCell.x ?? 0;
    const valueParts = cells.slice(1).map((cell) => coordinateCellText(cell)).filter(Boolean);
    if (!valueParts.length) continue;
    const rowLineTexts = [line.text];

    let previousY = line?.y ?? 0;
    for (let nextIndex = index + 1; nextIndex < lines.length && nextIndex <= index + 12; nextIndex += 1) {
      const nextLine = lines[nextIndex];
      const y = nextLine?.y ?? previousY;
      if (Math.abs(y - previousY) > 28) break;
      if (coordinateLooksLikeTableBoundary(nextLine)) break;
      const nextCells = coordinateGroupLineCells(nextLine).map((cell) => ({ ...cell }));
      if (!nextCells.length) break;
      const nextStartsRow =
        coordinateGroupLineLooksLikeStart(nextCells) &&
        Math.abs((nextCells[0]?.x ?? 0) - labelX) <= 36 &&
        coordinateCellText(nextCells[0]).length >= 3;
      if (nextStartsRow) break;

      const continuation = nextCells
        .filter((cell) => (cell.x ?? 0) > labelX + 48)
        .map((cell) => coordinateCellText(cell))
        .filter(Boolean);
      if (!continuation.length) break;
      valueParts.push(...continuation);
      rowLineTexts.push(nextLine.text);
      previousY = y;
    }

    const valueText = valueParts.join(" ").replace(/\s+/g, " ").trim();
    const text = `${labelText} ${valueText}`.replace(/\s+/g, " ").trim();
    if (valueText.length < 8 || text.length < 14) continue;
    rows.push({
      page: page.page,
      index,
      y: line?.y ?? 0,
      headerText,
      labelText,
      valueText,
      text,
      sourceText: rowLineTexts.join(" ").replace(/\s+/g, " ").trim(),
      labelX,
      labelTokens: uniqueTokens(labelText),
      valueTokens: uniqueTokens(valueText),
    });
  }

  Object.defineProperty(page, "__coordinateMultiCellRows", {
    value: rows,
    enumerable: false,
  });
  return rows;
}

function buildCoordinateMultiCellRowsByPage(pages, topQuestionPages) {
  const byPage = new Map();
  for (const page of pages) {
    const nearTopPage =
      !topQuestionPages?.size || topQuestionPages.has(page.page) || topQuestionPages.has(page.page - 1) || topQuestionPages.has(page.page + 1);
    if (!nearTopPage) continue;
    const rows = coordinateMultiCellRows(page);
    if (rows.length) byPage.set(page.page, rows);
  }
  return byPage;
}

function coordinateTableFocusTokens(question, focusTokens, answerTokens) {
  const answerSet = new Set(answerTokens ?? []);
  const out = [];
  for (const token of [...(focusTokens ?? []), ...uniqueTokens(question)]) {
    if (!token || token.length < 3) continue;
    if (FOCUS_STOPWORDS.has(token) || COORDINATE_TABLE_GENERIC_TOKENS.has(token)) continue;
    if (answerSet.has(token) && !/^\d/u.test(token)) continue;
    if (!out.includes(token)) out.push(token);
  }
  return out.slice(0, 12);
}

function coordinateCompoundFocusMatches(tableFocus, labelTokens) {
  const compound = tableFocus.filter((token) => /[+/]/u.test(token));
  if (!compound.length) return true;
  const labelSet = new Set(labelTokens ?? []);
  for (const token of compound) {
    if (labelSet.has(token)) return true;
    const parts = token
      .split(/[+/]+/u)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2);
    if (parts.length >= 2 && parts.every((part) => labelSet.has(part))) return true;
  }
  return false;
}

function coordinateRouteSynonymSupport(answerText, cellText) {
  const answer = normalizeForSearch(answerText);
  const cell = normalizeForSearch(cellText);
  const routeGroups = [
    ["\u043f\u0435\u0440\u043e\u0440\u0430\u043b", "\u0432\u043d\u0443\u0442\u0440\u044c", "per os", "peros", "p o"],
    ["\u0432\u043d\u0443\u0442\u0440\u0438\u0432", "\u0432/\u0432"],
    ["\u0432\u043d\u0443\u0442\u0440\u0438\u043c\u044b\u0448", "\u0432/\u043c"],
    ["\u043f\u043e\u0434\u043a\u043e\u0436", "\u043f/\u043a"],
  ];
  for (const cues of routeGroups) {
    const answerHit = cues.some((cue) => containsNormalizedPhrase(answer, cue));
    if (!answerHit) continue;
    const cellHit = cues.some((cue) => containsNormalizedPhrase(cell, cue));
    if (cellHit) return 0.96;
  }
  return 0;
}

function severityCue(text) {
  const normalized = normalizeForSearch(text);
  if (containsNormalizedPhrase(normalized, "\u043a\u0440\u0430\u0439\u043d") && containsNormalizedPhrase(normalized, "\u0442\u044f\u0436")) return "very_severe";
  if (
    containsNormalizedPhrase(normalized, "\u0441\u0440\u0435\u0434\u043d\u0435\u0442\u044f\u0436") ||
    containsNormalizedPhrase(normalized, "\u0441\u0440\u0435\u0434\u043d") ||
    containsNormalizedPhrase(normalized, "\u0443\u043c\u0435\u0440\u0435\u043d")
  ) {
    return "moderate";
  }
  if (containsNormalizedPhrase(normalized, "\u0442\u044f\u0436\u0435\u043b")) return "severe";
  if (containsNormalizedPhrase(normalized, "\u043b\u0435\u0433\u043a")) return "mild";
  return null;
}

function coordinateDirectionCuesAroundNumber(normalizedText, number) {
  const forms = [...new Set(expandNumberToken(number).map((item) => normalizeForSearch(item)).filter(Boolean))];
  const directions = new Set();
  for (const form of forms) {
    let start = 0;
    while (start < normalizedText.length) {
      const index = normalizedText.indexOf(form, start);
      if (index < 0) break;
      if (!numericSearchBoundary(normalizedText, index, form.length)) {
        start = index + Math.max(1, form.length);
        continue;
      }
      const local = normalizedText.slice(Math.max(0, index - 32), Math.min(normalizedText.length, index + form.length + 20));
      if (
        containsNormalizedPhrase(local, "\u0431\u043e\u043b\u0435\u0435") ||
        containsNormalizedPhrase(local, "\u0431\u043e\u043b\u044c\u0448\u0435") ||
        containsNormalizedPhrase(local, "\u0432\u044b\u0448\u0435") ||
        />|>=/u.test(local)
      ) {
        directions.add("gt");
      }
      if (
        containsNormalizedPhrase(local, "\u043c\u0435\u043d\u0435\u0435") ||
        containsNormalizedPhrase(local, "\u043c\u0435\u043d\u044c\u0448\u0435") ||
        containsNormalizedPhrase(local, "\u043d\u0438\u0436\u0435") ||
        containsNormalizedPhrase(local, "\u0434\u043e ") ||
        /<|<=/u.test(local)
      ) {
        directions.add("lt");
      }
      if (
        containsNormalizedPhrase(local, "\u043d\u0435 \u0431\u043e\u043b\u0435\u0435") ||
        containsNormalizedPhrase(local, "\u043d\u0435\u0431\u043e\u043b\u0435\u0435")
      ) {
        directions.delete("gt");
        directions.add("lt");
      }
      if (
        containsNormalizedPhrase(local, "\u043d\u0435 \u043c\u0435\u043d\u0435\u0435") ||
        containsNormalizedPhrase(local, "\u043d\u0435\u043c\u0435\u043d\u0435\u0435")
      ) {
        directions.delete("lt");
        directions.add("gt");
      }
      start = index + Math.max(1, form.length);
    }
  }
  return directions;
}

function coordinateNumericDirectionCompatible(cellText, answerText, answerNumbers) {
  if (!answerNumbers.length) return true;
  const normalizedCell = normalizeForSearch(cellText);
  const normalizedAnswer = normalizeForSearch(answerText);
  for (const number of answerNumbers) {
    const answerDirections = coordinateDirectionCuesAroundNumber(normalizedAnswer, number);
    if (!answerDirections.size) continue;
    const cellDirections = coordinateDirectionCuesAroundNumber(normalizedCell, number);
    if (!cellDirections.size) continue;
    const sameDirection = [...answerDirections].some((direction) => cellDirections.has(direction));
    if (!sameDirection) return false;
  }
  return true;
}

function coordinateCellAnswerSupport(cell, answer, answerTokens, answerPhrases, answerNumbers) {
  const text = coordinateCellText(cell);
  const normalized = normalizeForSearch(text);
  const tokens = tokenizeNormalized(normalized);
  const numericCoverage = numberCoverage(answer.text, normalized);
  const phraseHit = answerPhrases.some((phrase) => containsNormalizedPhrase(normalized, phrase));
  const tokenSupport = answerTokens.length ? strictSoftCoverage(answerTokens, tokens) : 0;
  let support = Math.max(tokenSupport, phraseHit ? 1 : 0, numericCoverage);
  if (answerNumbers.length) {
    const expanded = [...new Set(answerNumbers.flatMap(expandNumberToken))];
    const required = expanded.length > 1 ? 0.82 : 0.5;
    if (numericCoverage < required) support = Math.min(support, numericCoverage * 0.7);
  }
  return { support, numericCoverage, phraseHit, tokens, normalized };
}

function coordinateRowContrastBonus(row, bestCell, tableFocus, bestCellSupport, wholeRowAnswerMatch) {
  if (!row?.cells?.length || !bestCell || wholeRowAnswerMatch) return -0.35;
  const cellIndex = bestCell.index ?? -1;
  if (cellIndex < 0) return -0.35;

  const labelText = row.cells
    .filter((cell) => (cell.index ?? 0) < cellIndex)
    .slice(-2)
    .map((cell) => cell.text)
    .join(" ");
  const labelTokens = tokenize(labelText);
  const leftFocusHits = tokenHitCount(tableFocus, labelTokens);
  const leftFocusCoverage = tableFocus.length ? coverage(tableFocus, labelTokens) : 0;
  const headerCue = coordinateTextHasTableCaption(row.headerText) ? 0.25 : 0;
  const numericSpecificity = bestCellSupport?.numericCoverage >= 0.82 ? 0.35 : 0;

  if (leftFocusHits <= 0 && leftFocusCoverage < 0.18) return headerCue + numericSpecificity - 0.2;
  return Math.min(1.4, leftFocusHits * 0.35 + leftFocusCoverage * 1.6 + headerCue + numericSpecificity);
}

function bestCoordinateTableRowSupport({
  mode,
  question,
  answer,
  answerTokens,
  focusTokens,
  coordinateTableRowsByPage,
}) {
  if (!coordinateTableRowsByPage) return null;
  if (mode !== "single") return null;
  if (coordinateTableQuestionBlocked(question)) return null;
  const answerNumbers = extractNumbers(answer.text);

  const answerPhrases = answerSearchPhrases(answer.text).slice(0, 12);
  const tableFocus = coordinateTableFocusTokens(question, focusTokens, answerTokens);
  if (!tableFocus.length && !answerNumbers.length) return null;
  const questionSeverity = severityCue(question);
  let best = null;

  for (const rows of coordinateTableRowsByPage.values()) {
    for (const row of rows) {
      if (!row.cells?.length) continue;
      if (!coordinateRowHasTableContext(row)) continue;
      if (questionSeverity && coordinateSeverityCueCount(row.text) > 1) continue;
      let bestCell = null;
      let bestCellSupport = null;
      for (const cell of row.cells) {
        const support = coordinateCellAnswerSupport(cell, answer, answerTokens, answerPhrases, answerNumbers);
        if (!bestCellSupport || support.support > bestCellSupport.support) {
          bestCell = cell;
          bestCellSupport = support;
        }
      }
      const minAnswerSupport = answerNumbers.length ? 0.5 : 0.64;
      let wholeRowAnswerMatch = false;
      if ((!bestCellSupport || bestCellSupport.support < minAnswerSupport) && answerNumbers.length) {
        const rowSupport = coordinateCellAnswerSupport(
          { text: `${row.headerText} ${row.text}`.replace(/\s+/g, " ").trim(), index: -1 },
          answer,
          answerTokens,
          answerPhrases,
          answerNumbers,
        );
        if (rowSupport.support >= minAnswerSupport) {
          bestCell = { text: "", index: -1 };
          bestCellSupport = rowSupport;
          wholeRowAnswerMatch = true;
        }
      }
      if (!bestCell || !bestCellSupport || bestCellSupport.support < minAnswerSupport) continue;

      const otherCellsText = row.cells
        .filter((cell) => wholeRowAnswerMatch || cell.index !== bestCell.index)
        .map((cell) => cell.text)
        .join(" ");
      const rowSpecificTokens = tokenize(otherCellsText);
      const rowSpecificCoverage = tableFocus.length ? coverage(tableFocus, rowSpecificTokens) : 0;
      const rowSpecificHits = tokenHitCount(tableFocus, rowSpecificTokens);
      const headerTokens = tokenize(row.headerText);
      const headerCoverage = tableFocus.length ? coverage(tableFocus, headerTokens) : 0;
      if (tableFocus.length && rowSpecificCoverage < 0.16 && rowSpecificHits < 1) continue;

      const rowLabelText = row.cells
        .filter((cell) => cell.index !== bestCell.index)
        .slice(0, 2)
        .map((cell) => cell.text)
        .join(" ");
      const rowSeverity = severityCue(rowLabelText || otherCellsText);
      if (questionSeverity && rowSeverity !== questionSeverity) continue;

      const score =
        13.4 +
        Math.min(1, bestCellSupport.support) * 8.4 +
        Math.min(0.75, rowSpecificCoverage) * 7.0 +
        Math.min(3, rowSpecificHits) * 1.2 +
        Math.min(0.45, headerCoverage) * 2.4 +
        bestCellSupport.numericCoverage * 2.6 +
        (bestCellSupport.phraseHit ? 1.1 : 0) +
        (row.cells.length >= 3 ? 1.3 : 0) +
        coordinateRowContrastBonus(row, bestCell, tableFocus, bestCellSupport, wholeRowAnswerMatch);
      best = betterEvidence(best, {
        answerId: answer.id,
        page: row.page,
        text: `${row.headerText} ${row.sourceText || row.text}`.replace(/\s+/g, " ").trim(),
        score,
        kind: "coordinate_table_row",
      });
    }
  }

  return best;
}

function bestCoordinateTableGroupSupport({
  mode,
  question,
  answer,
  answerTokens,
  focusTokens,
  coordinateTableGroupsByPage,
}) {
  if (mode !== "multi") return null;
  if (!coordinateTableGroupsByPage) return null;
  const answerNumbers = extractNumbers(answer.text);
  const answerPhrases = answerSearchPhrases(answer.text).slice(0, 12);
  const tableFocus = coordinateTableFocusTokens(question, focusTokens, answerTokens);
  if (tableFocus.length < 2 && !answerNumbers.length) return null;
  let best = null;

  for (const groups of coordinateTableGroupsByPage.values()) {
    for (const group of groups) {
      const answerSupport = coordinateCellAnswerSupport(
        { text: group.valueText, index: 1 },
        answer,
        answerTokens,
        answerPhrases,
        answerNumbers,
      );
      const synonymSupport = coordinateRouteSynonymSupport(answer.text, `${group.valueText} ${group.headerText}`);
      const effectiveAnswerSupport = Math.max(answerSupport.support, synonymSupport);
      const minAnswerSupport = answerNumbers.length ? 0.5 : 0.58;
      const lexicalAnswerSupport = answerTokens.length ? strictSoftCoverage(answerTokens, answerSupport.tokens) : 0;
      if (effectiveAnswerSupport >= minAnswerSupport && (answerSupport.phraseHit || synonymSupport > 0 || lexicalAnswerSupport >= 0.42)) {
        const labelCoverage = tableFocus.length ? coverage(tableFocus, group.labelTokens) : 0;
        const labelHits = tokenHitCount(tableFocus, group.labelTokens);
        const headerCoverage = tableFocus.length ? coverage(tableFocus, uniqueTokens(group.headerText)) : 0;
        const hasSpecificLabel = labelCoverage >= 0.22 || labelHits >= Math.min(3, Math.max(2, Math.ceil(tableFocus.length * 0.25)));
        if ((hasSpecificLabel || headerCoverage >= 0.42) && coordinateCompoundFocusMatches(tableFocus, group.labelTokens)) {
          const score =
            14.6 +
            Math.min(1, effectiveAnswerSupport) * 8.6 +
            Math.min(0.78, labelCoverage) * 8.2 +
            Math.min(4, labelHits) * 1.45 +
            Math.min(0.5, headerCoverage) * 2.0 +
            (answerSupport.phraseHit ? 1.4 : 0) +
            synonymSupport * 1.4 +
            lexicalAnswerSupport * 2.0 +
            answerSupport.numericCoverage * 2.2;
          best = betterEvidence(best, {
            answerId: answer.id,
            page: group.page,
            text: `${group.headerText} | ${group.labelText} -> ${group.valueText}`.replace(/\s+/g, " ").trim(),
            score,
            kind: "coordinate_table_group",
          });
        }
      }

      const inverseFocusCoverage = tableFocus.length ? coverage(tableFocus, group.valueTokens) : 0;
      const inverseFocusHits = tokenHitCount(tableFocus, group.valueTokens);
      const inverseHeaderCoverage = tableFocus.length ? coverage(tableFocus, uniqueTokens(group.headerText)) : 0;
      const inverseFocusSupported =
        inverseFocusCoverage >= 0.28 ||
        inverseFocusHits >= Math.min(3, Math.max(2, Math.ceil(tableFocus.length * 0.25))) ||
        (inverseHeaderCoverage >= 0.42 && inverseFocusHits >= 1);
      if (!inverseFocusSupported) continue;

      const inverseAnswerSupport = coordinateCellAnswerSupport(
        { text: group.labelText, index: 0 },
        answer,
        answerTokens,
        answerPhrases,
        answerNumbers,
      );
      const inverseSynonymSupport = coordinateRouteSynonymSupport(answer.text, `${group.labelText} ${group.headerText}`);
      const inverseEffectiveAnswerSupport = Math.max(inverseAnswerSupport.support, inverseSynonymSupport);
      const inverseMinAnswerSupport = answerNumbers.length ? 0.5 : 0.58;
      if (inverseEffectiveAnswerSupport < inverseMinAnswerSupport) continue;
      const inverseLexicalAnswerSupport = answerTokens.length ? strictSoftCoverage(answerTokens, inverseAnswerSupport.tokens) : 0;
      if (!inverseAnswerSupport.phraseHit && inverseSynonymSupport <= 0 && inverseLexicalAnswerSupport < 0.42) continue;

      const inverseScore =
        14.4 +
        Math.min(1, inverseEffectiveAnswerSupport) * 8.2 +
        Math.min(0.78, inverseFocusCoverage) * 8.0 +
        Math.min(4, inverseFocusHits) * 1.35 +
        Math.min(0.5, inverseHeaderCoverage) * 1.6 +
        (inverseAnswerSupport.phraseHit ? 1.2 : 0) +
        inverseSynonymSupport * 1.2 +
        inverseLexicalAnswerSupport * 1.8 +
        inverseAnswerSupport.numericCoverage * 2.0;
      best = betterEvidence(best, {
        answerId: answer.id,
        page: group.page,
        text: `${group.headerText} | ${group.valueText} <- ${group.labelText}`.replace(/\s+/g, " ").trim(),
        score: inverseScore,
        kind: "coordinate_table_group_inverse",
      });
    }
  }

  return best;
}

function bestCoordinateMultiCellRowSupport({
  mode,
  question,
  answer,
  answerTokens,
  focusTokens,
  coordinateMultiCellRowsByPage,
}) {
  if (mode !== "multi") return null;
  if (!coordinateMultiCellRowsByPage) return null;
  const answerNumbers = extractNumbers(answer.text);
  const answerPhrases = answerSearchPhrases(answer.text).slice(0, 12);
  const tableFocus = coordinateTableFocusTokens(question, focusTokens, answerTokens);
  if (tableFocus.length < 1 && !answerNumbers.length) return null;
  const questionSeverity = severityCue(question);
  let best = null;

  for (const rows of coordinateMultiCellRowsByPage.values()) {
    for (const row of rows) {
      const rowSeverity = severityCue(row.labelText);
      if (questionSeverity && rowSeverity !== questionSeverity) continue;
      const labelCoverage = tableFocus.length ? coverage(tableFocus, row.labelTokens) : 0;
      const labelHits = tokenHitCount(tableFocus, row.labelTokens);
      const headerCoverage = tableFocus.length ? coverage(tableFocus, uniqueTokens(row.headerText)) : 0;
      const labelSupported = questionSeverity || labelCoverage >= 0.18 || labelHits >= 1;
      if (!labelSupported && headerCoverage < 0.38) continue;

      const answerSupport = coordinateCellAnswerSupport(
        { text: row.valueText, index: 1 },
        answer,
        answerTokens,
        answerPhrases,
        answerNumbers,
      );
      if (!coordinateNumericDirectionCompatible(row.valueText, answer.text, answerNumbers)) continue;
      const synonymSupport = coordinateRouteSynonymSupport(answer.text, `${row.valueText} ${row.headerText}`);
      const effectiveAnswerSupport = Math.max(answerSupport.support, synonymSupport);
      const answerTokenHits = tokenHitCount(answerTokens, answerSupport.tokens);
      const longListSupport = answerTokens.length >= 6 && answerTokenHits >= 4 && answerSupport.support >= 0.52;
      const minAnswerSupport = longListSupport ? 0.52 : answerNumbers.length ? 0.5 : 0.58;
      if (effectiveAnswerSupport < minAnswerSupport) continue;
      const lexicalAnswerSupport = answerTokens.length ? strictSoftCoverage(answerTokens, answerSupport.tokens) : 0;
      const minLexicalSupport = longListSupport ? 0.5 : 0.38;
      if (!answerSupport.phraseHit && synonymSupport <= 0 && lexicalAnswerSupport < minLexicalSupport) continue;

      const score =
        14.2 +
        Math.min(1, effectiveAnswerSupport) * 8.3 +
        Math.min(0.75, labelCoverage) * 7.4 +
        Math.min(3, labelHits) * 1.4 +
        (questionSeverity ? 2.2 : 0) +
        Math.min(0.5, headerCoverage) * 2.0 +
        (answerSupport.phraseHit ? 1.4 : 0) +
        synonymSupport * 1.3 +
        lexicalAnswerSupport * 1.8 +
        answerSupport.numericCoverage * 2.0 +
        (longListSupport ? 1.2 : 0);
      best = betterEvidence(best, {
        answerId: answer.id,
        page: row.page,
        text: `${row.headerText} | ${row.labelText} -> ${row.valueText}`.replace(/\s+/g, " ").trim(),
        score,
        kind: "coordinate_table_multicell_row",
      });
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

function conditionPairAdjustment({ pages, topQuestionPages, answer }) {
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

function tokenBoundaryIncludes(normalizedText, normalizedToken) {
  if (!normalizedText || !normalizedToken) return false;
  const pattern = new RegExp(`(^|\\s)${escapeRegExp(normalizedToken)}(\\s|$)`, "iu");
  return pattern.test(normalizedText);
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
  return Math.max(0, index - 260);
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
        if (target.kind !== "step" && specificTokens.length && focusHits <= 0) continue;
        const answerCoverage = strictSoftCoverage(answerTokens, tokens);
        const phraseHit = answerPhrases.some((phrase) => containsNormalizedPhrase(window, phrase));
        const abbreviation = abbreviationSupport(answer.text, window);
        if (!phraseHit && answerCoverage < 0.58 && abbreviation <= 0) continue;
        const score = 12.2 + (phraseHit ? 2.4 : 0) + Math.max(answerCoverage, abbreviation) * 4.4 + Math.min(2, focusHits) * 1.1;
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

function sharedMultiTokens(answerText) {
  return uniqueTokens(answerText).filter((token) => token.length >= 3 && !FOCUS_STOPWORDS.has(token) && !SHARED_MULTI_GENERIC_TOKENS.has(token));
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

function sharedMultiSegmentHit(segmentText, answer, question) {
  const normalized = sharedMultiFocusedNormalized(segmentText, question);
  if (!normalized || normalized.length < 30) return null;
  if (sharedMultiRequiredCueMismatch(answer.text, normalized)) return null;

  const phraseHit = focusedAnswerSearchPhrases(answer.text)
    .map((phrase) => normalizeForSearch(phrase))
    .filter((phrase) => phrase.length >= 9)
    .some((phrase) => containsNormalizedPhrase(normalized, phrase));
  const tokens = sharedMultiTokens(answer.text);
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

function nearestCueName(local, entries) {
  const center = Math.floor(local.length / 2);
  let best = null;
  for (const [name, cues] of entries) {
    for (const cueText of cues) {
      const cue = normalizeForSearch(cueText);
      for (let index = local.indexOf(cue); index >= 0; index = local.indexOf(cue, index + cue.length)) {
        const distance = Math.abs(index - center);
        if (!best || distance < best.distance) best = { name, distance };
      }
    }
  }
  return best?.name ?? null;
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

function bestNumericConditionSupport({ mode, pages, topQuestionPages, question, answer, answerTokens, focusTokens }) {
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

function bestConditionedNumberSupport({ mode, pages, topQuestionPages, question, answer, answerTokens, focusTokens }) {
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
  return true;
}

function bestCountRelationSupport({ mode, pages, topQuestionPages, question, answer, answerTokens }) {
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

const CONTRAST_CUE_GROUPS = [
  {
    answer: ["\u0432\u0435\u0440\u0445\u043d"],
    opposite: ["\u043d\u0438\u0436\u043d", "\u0431\u0430\u0437\u0430\u043b"],
  },
  {
    answer: ["\u043d\u0438\u0436\u043d", "\u0431\u0430\u0437\u0430\u043b"],
    opposite: ["\u0432\u0435\u0440\u0445\u043d"],
  },
  {
    answer: ["\u043f\u043e\u0432\u044b\u0448", "\u0443\u0432\u0435\u043b\u0438\u0447"],
    opposite: ["\u043f\u043e\u043d\u0438\u0436", "\u0441\u043d\u0438\u0436", "\u0443\u043c\u0435\u043d\u044c\u0448"],
  },
  {
    answer: ["\u043f\u043e\u043d\u0438\u0436", "\u0441\u043d\u0438\u0436", "\u0443\u043c\u0435\u043d\u044c\u0448"],
    opposite: ["\u043f\u043e\u0432\u044b\u0448", "\u0443\u0432\u0435\u043b\u0438\u0447"],
  },
  {
    answer: ["\u0434\u0438\u0441\u0442\u0430\u043b\u044c\u043d\u043e\u043f\u0440\u043e\u043a\u0441\u0438\u043c"],
    opposite: ["\u043f\u0440\u043e\u043a\u0441\u0438\u043c\u0430\u043b\u044c\u043d\u043e\u0434\u0438\u0441\u0442"],
  },
  {
    answer: ["\u043f\u0440\u043e\u043a\u0441\u0438\u043c\u0430\u043b\u044c\u043d\u043e\u0434\u0438\u0441\u0442"],
    opposite: ["\u0434\u0438\u0441\u0442\u0430\u043b\u044c\u043d\u043e\u043f\u0440\u043e\u043a\u0441\u0438\u043c"],
  },
].map((group) => ({
  answer: group.answer.map((item) => normalizeForSearch(item)),
  opposite: group.opposite.map((item) => normalizeForSearch(item)),
}));

function contrastCueMismatchAdjustment({ mode, answer }, evidence) {
  if (mode !== "multi" || !evidence?.length) return { adjustment: 0, evidence: null };
  const answerNorm = normalizeForSearch(answer.text);
  const group = CONTRAST_CUE_GROUPS.find((item) => item.answer.some((cue) => answerNorm.includes(cue)));
  if (!group) return { adjustment: 0, evidence: null };

  for (const item of evidence.slice(0, 4)) {
    if ((item.score ?? 0) < 5.5 || !item.text) continue;
    const sourceNorm = normalizeForSearch(item.text);
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

function scoreAnswer(context) {
  const anchor = bestAnchorSupport(context);
  const section = bestSectionSupport(context);
  const rowLabel = bestRowLabelSupport(context);
  const focused = bestFocusedSupport(context);
  const lineToken = lineTokenApplicable(context) ? bestLineTokenSupport(context) : null;
  const prefix = bestPrefixSupport(context);
  const phrase = bestPhraseSupport(context);
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
  const ageEligibility = ageEligibilityAdjustment(context);
  const drugDose = bestDrugDoseSupport(context);
  const termDefinition = bestTermDefinitionSupport(context);
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
    ageEligibility.adjustment +
    (drugDose?.score ?? 0) * 1.15 +
    (termDefinition?.score ?? 0) * 1.15 +
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
    ageEligibility.evidence,
    drugDose,
    termDefinition,
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
  const selectedScores = selected.map((id) => calibrated.find((item) => item.answer.id === id)?.score ?? 0);
  const confidence = mode === "single" ? Math.max(...selectedScores, 0) : selectedScores.reduce((sum, score) => sum + score, 0) / (selectedScores.length || 1);
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
