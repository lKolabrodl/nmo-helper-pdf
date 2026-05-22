import { normalizeForSearch, normalizeText } from "./normalize.js";

let configuredPdfJs: any = null;

/**
 * Настраивает модуль PDF.js, который будет использовать runtime.
 *
 * В браузере это удобно вызывать, когда PDF.js загружен с CDN или через
 * собственный bundler. В Node.js обычно достаточно пакетного импорта.
 *
 * @param pdfjsLib Объект модуля с методом `getDocument`.
 */
export function setPdfJsLib(pdfjsLib: any) {
  configuredPdfJs = pdfjsLib;
}

async function resolvePdfJs(options: any = {}) {
  if (options.pdfjsLib?.getDocument) return options.pdfjsLib;
  if (configuredPdfJs?.getDocument) return configuredPdfJs;

  const fromGlobal = (globalThis as any).pdfjsLib ?? (globalThis as any).PDFJS;
  if (fromGlobal?.getDocument) return fromGlobal;

  try {
    return await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch {
    throw new Error(
      "PDF.js is not available. In the browser, include pdf.js before this library or call setPdfJsLib(pdfjsLib).",
    );
  }
}

async function toUint8Array(input: any): Promise<Uint8Array> {
  if (input instanceof Uint8Array) {
    return new Uint8Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
  }
  if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0));

  if (typeof Blob !== "undefined" && input instanceof Blob) {
    return new Uint8Array(await input.arrayBuffer());
  }

  if (typeof input === "string") {
    if (typeof fetch !== "function") {
      throw new Error("String PDF input is treated as a URL, but fetch() is not available in this environment.");
    }
    const response = await fetch(input);
    if (!response.ok) throw new Error(`Failed to fetch PDF: ${response.status} ${response.statusText}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  if (input?.arrayBuffer && typeof input.arrayBuffer === "function") {
    return new Uint8Array(await input.arrayBuffer());
  }

  throw new Error("PDF input must be ArrayBuffer, Uint8Array, Blob/File, or URL string.");
}

function lineKey(item: any) {
  const [, , , , , y] = item.transform ?? [1, 0, 0, 1, 0, 0];
  return Math.round(y / 3) * 3;
}

function itemX(item: any) {
  return item.transform?.[4] ?? 0;
}

function itemY(item: any) {
  return item.transform?.[5] ?? 0;
}

function groupItemsIntoLineObjects(items: any[]) {
  const useful = items
    .filter((item) => typeof item.str === "string" && item.str.trim())
    .sort((a, b) => itemY(b) - itemY(a) || itemX(a) - itemX(b));
  const groups: any[] = [];
  for (const item of useful) {
    const key = lineKey(item);
    let group = groups.find((candidate) => Math.abs(candidate.key - key) <= 2);
    if (!group) {
      group = { key, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }

  groups.sort((a, b) => b.key - a.key);
  return groups
    .map((group) => {
      const sortedItems = group.items.sort((a: any, b: any) => itemX(a) - itemX(b));
      const text = sortedItems
        .map((item: any) => item.str.trim())
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      return {
        text,
        y: group.key,
        items: sortedItems.map((item: any) => ({
          text: item.str.trim(),
          x: itemX(item),
          y: itemY(item),
          width: item.width ?? 0,
          height: item.height ?? 0,
        })),
      };
    })
    .filter((line) => line.text);
}

/**
 * Убирает повторяющийся служебный текст PDF (running header/footer, ссылки),
 * который не несет содержательной информации для скоринга.
 *
 * Сопоставление идет с `normalizeText` (чистая кириллица в нижнем регистре),
 * а не с `normalizeForSearch`, потому что последняя сворачивает кириллические
 * lookalike-символы в латиницу. Правила нарочно общие и не привязаны к
 * конкретному документу: колонтитул "страница N из M", бегущий заголовок
 * "клинические рекомендации - <название> - <годы>" и строки-ссылки.
 */
function stripLikelyBoilerplate(lines: any[]) {
  return lines.filter((line) => {
    const text = typeof line === "string" ? line : line.text;
    if (!normalizeForSearch(text)) return false;
    const clean = normalizeText(text);
    if (/^страниц[аы]\s+\d+\s+из\s+\d+\b/.test(clean)) return false;
    if (/^[-\s]*\d{1,3}[-\s]*$/.test(clean)) return false;
    if (/(https?:\/\/|www\.|disuria\.ru)/.test(clean)) return false;
    return true;
  });
}

function buildPageText(lines: string[]) {
  const out: string[] = [];
  for (const line of lines) {
    const previous = out[out.length - 1] ?? "";
    const startsList = /^(\d+(?:\.\d+)*[.)]?|[-*вЂў]|[a-zР°-СЏ]\))\s+/iu.test(line);
    const previousEnds = /[.!?;:]$/.test(previous) || previous.length < 30;
    if (out.length && !startsList && !previousEnds && line.length < 100) {
      out[out.length - 1] = `${previous} ${line}`.replace(/\s+/g, " ");
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

/**
 * Извлекает текст и легкие layout-метаданные из PDF.
 *
 * Экстрактор принимает байты, браузерные File/Blob, ArrayBuffer-подобные
 * объекты или URL-строки. Возвращает текст страниц, строки, нормализованный
 * текст и флаг `ocrNeeded`, если в PDF найдено подозрительно мало текста.
 *
 * @param pdfInput Байты PDF, File/Blob, ArrayBuffer, Uint8Array или URL.
 * @param options Необязательный `cacheKey` и явно переданный `pdfjsLib`.
 * @returns Текст страниц и метаданные, которые использует predictor.
 */
export async function extractPdfText(pdfInput: any, options: any = {}) {
  const pdfjs = await resolvePdfJs(options);
  const data = await toUint8Array(pdfInput);
  const loadingTask = pdfjs.getDocument({
    data,
    disableWorker: true,
    useSystemFonts: true,
    isEvalSupported: false,
  });
  const pdf = await loadingTask.promise;
  const pages: any[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent({
      disableCombineTextItems: false,
      includeMarkedContent: false,
    });
    const lineObjects = stripLikelyBoilerplate(groupItemsIntoLineObjects(content.items));
    const lines = lineObjects.map((line) => line.text);
    const text = buildPageText(lines);
    pages.push({
      page: pageNumber,
      text,
      lines,
      lineItems: lineObjects,
      normalized: normalizeForSearch(text),
      charLength: text.length,
    });
  }

  const pageTextChars = pages.reduce((sum, page) => sum + page.text.length, 0);
  return {
    pdfId: options.cacheKey ?? (typeof pdfInput === "string" ? pdfInput : "<browser-pdf>"),
    cacheVersion: 1,
    pageCount: pdf.numPages,
    extractedAt: new Date().toISOString(),
    pages,
    ocrNeeded: pageTextChars < Math.max(1000, pdf.numPages * 100),
  };
}

/**
 * Очищает кеш извлечения PDF.
 *
 * Текущая browser-first реализация хранит текст PDF в runtime-кеше predictor,
 * поэтому эта функция намеренно оставлена как совместимый no-op.
 */
export function clearPdfMemoryCache() {
  // Browser build keeps PDF text in the predictor runtime cache.
}
