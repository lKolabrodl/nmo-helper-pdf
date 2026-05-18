import { extractNumbers, normalizeForSearch, normalizeText, phraseTokens, stemToken, tokenize } from "../normalize.js";

export function rawTokens(text) {
  return normalizeText(text).match(/[a-zа-я0-9]+/giu) ?? [];
}

export function findPhraseOccurrences(text, phrase, { textIsNormalized = false } = {}) {
  const normalizedText = textIsNormalized ? String(text ?? "") : normalizeForSearch(text);
  const normalizedPhrase = normalizeForSearch(phrase);
  if (!normalizedText || !normalizedPhrase || normalizedPhrase.length < 2) return [];

  const hits = [];
  let start = 0;
  while (start < normalizedText.length) {
    const index = normalizedText.indexOf(normalizedPhrase, start);
    if (index < 0) break;
    hits.push(index);
    start = index + Math.max(1, normalizedPhrase.length);
    if (hits.length > 80) break;
  }
  return hits;
}

export function hasSearchBoundaries(text, index, length) {
  const before = index > 0 ? text[index - 1] : "";
  const after = index + length < text.length ? text[index + length] : "";
  return !isSearchTokenChar(before) && !isSearchTokenChar(after);
}

function isSearchTokenChar(char) {
  return !!char && /[a-zа-я0-9%./+-]/iu.test(char);
}

export function answerSearchPhrases(answerText) {
  const normalized = normalizeForSearch(answerText);
  const phrases = new Set([answerText, normalized]);
  const withoutParentheses = normalized.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  if (withoutParentheses) phrases.add(withoutParentheses);
  const rawAnswerText = String(answerText ?? "");
  const rawHyphenSplit = rawAnswerText.replace(/\s*[-\u2010-\u2015]\s*/g, " ").replace(/\s+/g, " ").trim();
  if (rawHyphenSplit) phrases.add(rawHyphenSplit);
  const hyphenSplit = normalizeForSearch(rawAnswerText.replace(/\s*[-\u2010-\u2015]\s*/g, " "));
  if (hyphenSplit) phrases.add(hyphenSplit);
  const rawHyphenSpaced = rawAnswerText.replace(/\s*[-\u2010-\u2015]\s*/g, " - ").replace(/\s+/g, " ").trim();
  if (rawHyphenSpaced) phrases.add(rawHyphenSpaced);
  const hyphenSpaced = normalizeForSearch(rawAnswerText.replace(/\s*[-\u2010-\u2015]\s*/g, " - "));
  if (hyphenSpaced) phrases.add(hyphenSpaced);
  const inhibitorMatch = rawAnswerText.match(new RegExp(`\u0438\u043d\u0433\u0438\u0431\u0438\u0442\\S*\\s+([A-Z\\u0410-\\u042F]{2,8})(.*)$`, "iu"));
  if (inhibitorMatch?.[1]) {
    const abbreviated = `\u0438${inhibitorMatch[1]}${inhibitorMatch[2] ?? ""}`.replace(/\s+/g, " ").trim();
    if (abbreviated) {
      phrases.add(abbreviated);
      phrases.add(abbreviated.replace(/\s*\/\s*/g, " / ").replace(/\s+/g, " ").trim());
      phrases.add(abbreviated.replace(/\s*\/\s*/g, " ").replace(/\s+/g, " ").trim());
      phrases.add(normalizeForSearch(abbreviated));
    }
  }
  if (withoutParentheses.includes("/")) {
    phrases.add(withoutParentheses.replace(/\s*\/\s*/g, " ").replace(/\s+/g, " ").trim());
    phrases.add(withoutParentheses.replace(/\s*\/\s*/g, " и ").replace(/\s+/g, " ").trim());
  }
  const withoutUnits = withoutParentheses
    .replace(/\b(ме|мг|мкг|г|мл|л|мм|см|сут|час|день|дня|дней|неделя|недели|недель)\b(?:\s*\/\s*\b(мл|л|сут|час)\b)?/g, " ")
    .replace(/\b(рт\.?\s*ст\.?|log\s*10\s*ме\s*\/\s*мл|ме\s*\/\s*мл|мг\s*\/\s*л|ммоль\s*\/\s*л)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (withoutUnits) phrases.add(withoutUnits);
  const tokens = phraseTokens(withoutUnits || normalized);
  if (tokens.length >= 3) {
    phrases.add(tokens.slice(0, Math.min(tokens.length, 5)).join(" "));
  }
  const numbers = extractNumbers(answerText);
  if (numbers.length === 1) {
    const aroundNumber = normalized.match(new RegExp(`(?:\\S+\\s+){0,2}${numbers[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s+\\S+){0,3}`));
    if (aroundNumber?.[0]) phrases.add(aroundNumber[0]);
  }
  return [...phrases].filter((phrase) => normalizeForSearch(phrase).length >= 2);
}

export function focusedAnswerSearchPhrases(answerText) {
  const phrases = new Set();
  const plusParts = normalizeText(answerText)
    .split(/\s*\+\s*/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (plusParts.length > 1) {
    phrases.add(plusParts.join(" + "));
    const firstTokens = rawTokens(plusParts[0]);
    if (firstTokens.length > 1) {
      phrases.add([firstTokens.slice(1).join(" "), ...plusParts.slice(1)].join(" + "));
    }
  }
  const tokens = rawTokens(answerText);
  if (tokens.length >= 3) {
    for (const length of [6, 5, 4]) {
      if (tokens.length < length) continue;
      for (let index = 0; index <= tokens.length - length; index += 1) {
        phrases.add(tokens.slice(index, index + length).join(" "));
      }
    }
  }
  for (const phrase of answerSearchPhrases(answerText)) phrases.add(phrase);
  return [...phrases].filter((phrase) => normalizeForSearch(phrase).length >= 2);
}

export function containsPhrase(haystack, needle) {
  const normalizedNeedle = normalizeForSearch(needle);
  if (!normalizedNeedle) return false;
  return normalizeForSearch(haystack).includes(normalizedNeedle);
}

export function containsNormalizedPhrase(normalizedHaystack, needle) {
  const normalizedNeedle = normalizeForSearch(needle);
  if (!normalizedNeedle) return false;
  return String(normalizedHaystack ?? "").includes(normalizedNeedle);
}

export function tokenizeNormalized(text) {
  return (String(text ?? "").match(/[a-zа-я0-9]+(?:[.%/+-][a-zа-я0-9]+)*/giu) ?? []).map((token) => stemToken(token));
}

export function tokenSequenceIncludes(haystackTokens, needleTokens) {
  if (!needleTokens.length || needleTokens.length > haystackTokens.length) return false;
  for (let index = 0; index <= haystackTokens.length - needleTokens.length; index += 1) {
    let ok = true;
    for (let offset = 0; offset < needleTokens.length; offset += 1) {
      if (haystackTokens[index + offset] !== needleTokens[offset]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

export function rawSoftCoverage(queryTokens, documentTokens) {
  if (!queryTokens.length || !documentTokens.length) return 0;
  let hit = 0;
  for (const token of queryTokens) {
    if (/^(?:[ivx]+|\d+)$/iu.test(token)) {
      if (documentTokens.includes(token)) hit += 1;
      continue;
    }
    const prefixLength = Math.min(10, Math.max(4, token.length - 2));
    const prefix = token.slice(0, prefixLength);
    if (documentTokens.some((candidate) => candidate === token || candidate.startsWith(prefix) || token.startsWith(candidate.slice(0, prefixLength)))) {
      hit += 1;
    }
  }
  return hit / queryTokens.length;
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function softCoverage(queryTokens: string[], documentTokens: string[]) {
  if (!queryTokens.length || !documentTokens.length) return 0;
  const doc = [...new Set(documentTokens)];
  let hit = 0;
  for (const token of new Set(queryTokens)) {
    const prefixLength = Math.min(8, Math.max(4, token.length - 2));
    const prefix = token.slice(0, prefixLength);
    if (doc.some((candidate) => candidate === token || candidate.startsWith(prefix) || token.startsWith(candidate.slice(0, prefixLength)))) {
      hit += 1;
    }
  }
  return hit / new Set(queryTokens).size;
}

export function strictSoftCoverage(queryTokens: string[], documentTokens: string[]) {
  if (!queryTokens.length || !documentTokens.length) return 0;
  const doc = [...new Set(documentTokens)];
  let hit = 0;
  for (const token of new Set(queryTokens)) {
    if (doc.includes(token)) {
      hit += 1;
      continue;
    }
    if (token.length < 8) continue;
    const prefixLength = Math.min(10, Math.max(7, token.length - 3));
    const prefix = token.slice(0, prefixLength);
    if (doc.some((candidate) => candidate.length >= 8 && (candidate.startsWith(prefix) || token.startsWith(candidate.slice(0, prefixLength))))) {
      hit += 1;
    }
  }
  return hit / new Set(queryTokens).size;
}

export function tokenHitCount(queryTokens, documentTokens) {
  if (!queryTokens.length || !documentTokens.length) return 0;
  const doc = new Set(documentTokens);
  let hit = 0;
  for (const token of new Set(queryTokens)) {
    if (doc.has(token)) hit += 1;
  }
  return hit;
}

export function evidenceFromChunk(answerIdValue, chunk, score, kind) {
  return {
    answerId: answerIdValue,
    page: chunk.page,
    text: chunk.text.slice(0, 900),
    score,
    kind,
  };
}

export function betterEvidence(left, right) {
  if (!right) return left;
  if (!left || right.score > left.score) return right;
  return left;
}

export function evidenceSnippet(pageText, ...needles) {
  const clean = String(pageText ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const normalizedPage = normalizeForSearch(clean);
  let bestIndex = -1;
  for (const needle of needles) {
    const normalizedNeedle = normalizeForSearch(needle);
    if (!normalizedNeedle) continue;
    const index = normalizedPage.indexOf(normalizedNeedle.slice(0, Math.min(80, normalizedNeedle.length)));
    if (index >= 0 && (bestIndex < 0 || index < bestIndex)) bestIndex = index;
  }
  if (bestIndex < 0) return clean.slice(0, 900);
  const start = Math.max(0, bestIndex - 300);
  const end = Math.min(clean.length, bestIndex + 700);
  return clean.slice(start, end);
}

export function numberCoverage(answer, text) {
  const answerNumbers = extractNumbers(answer).flatMap(expandNumberToken);
  if (!answerNumbers.length) return 0;
  const textNumbers = new Set(extractNumbers(text).flatMap(expandNumberToken));
  if (!textNumbers.size) return 0;
  let hit = 0;
  for (const number of answerNumbers) {
    if (textNumbers.has(number)) hit += 1;
  }
  return hit / answerNumbers.length;
}

export function expandNumberToken(token) {
  const cleaned = String(token).replace("%", "");
  const parts = cleaned.split("-").filter(Boolean);
  const out = [];
  for (const part of parts) {
    if (/^0+\d/.test(part)) out.push(part.replace(/^0+/, "") || "0");
    const value = Number(part);
    if (!Number.isFinite(value)) {
      out.push(part);
      continue;
    }
    out.push(String(value));
    if (Number.isInteger(value) && value > 1) out.push(String(value - 1));
  }
  return out;
}

export function tokenProximity(questionTokens, answerTokens, documentTokens) {
  if (!questionTokens.length || !answerTokens.length || !documentTokens.length) return 0;
  const qSet = new Set(questionTokens);
  const aSet = new Set(answerTokens);
  const qPositions = [];
  const aPositions = [];
  documentTokens.forEach((token, index) => {
    if (qSet.has(token)) qPositions.push(index);
    if (aSet.has(token)) aPositions.push(index);
  });
  if (!qPositions.length || !aPositions.length) return 0;
  let total = 0;
  for (const aPos of aPositions) {
    let best = Infinity;
    for (const qPos of qPositions) {
      best = Math.min(best, Math.abs(aPos - qPos));
    }
    total += Math.exp(-best / 18);
  }
  return total / aPositions.length;
}

export function cachedPageTokens(page) {
  if (!page.__tokens) Object.defineProperty(page, "__tokens", { value: tokenize(page.text), enumerable: false });
  return page.__tokens;
}

export function lineWindowSegments(page, radius = 2) {
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

export function cachedLineWindowSegments(page) {
  if (!page.__lineWindowSegments) {
    Object.defineProperty(page, "__lineWindowSegments", {
      value: lineWindowSegments(page, 3),
      enumerable: false,
    });
  }
  return page.__lineWindowSegments;
}

export function pageWindow(page, center, radius = 1000) {
  const normalized = page.normalized;
  const start = Math.max(0, center - radius);
  const end = Math.min(normalized.length, center + radius);
  return normalized.slice(start, end);
}

export function proximityBonus(distance, radius) {
  if (distance < 0 || distance > radius) return 0;
  return 1 - distance / radius;
}

export function answerHasQuestionNumbers(answer, question) {
  const answerNumbers = new Set(extractNumbers(answer));
  if (!answerNumbers.size) return false;
  for (const number of extractNumbers(question)) {
    if (answerNumbers.has(number)) return true;
  }
  return false;
}
