# med-pdf-nmo

[English README](./README.md)

`med-pdf-nmo` - browser-first JavaScript/Node.js пакет, который выбирает наиболее вероятный ответ или набор ответов на НМО-вопрос по PDF-файлу с медицинскими или клиническими рекомендациями.

Runtime работает локально и не использует LLM. В inference нет ChatGPT, OpenAI API, Anthropic, Gemini, HuggingFace inference, transformer-моделей или внешних интеллектуальных сервисов. Алгоритм основан на извлечении текста PDF, нормализации, поиске, структурных эвристиках, скоринге и evidence-фрагментах из PDF.

## Что делает пакет

- Принимает PDF медицинских рекомендаций, вопрос и варианты ответа.
- Извлекает текст из PDF через `pdfjs-dist`.
- Нормализует русский медицинский текст, PDF-артефакты, греческие буквы, числовые ссылки, дозировки и частые OCR-искажения.
- Считает score для каждого варианта ответа.
- Поддерживает `single` и `multi` вопросы.
- Возвращает выбранные ответы, confidence, score по вариантам, raw score, evidence из PDF и метаданные.
- Работает в Node.js, browser bundle и Chrome-extension окружениях.

## Текущие метрики

Цифры получены на локальном корпусе PDF-групп с answer key. Это не гарантия качества на любом новом PDF, а текущий ориентир после финального прогона.

| Набор | Exact accuracy | Single-answer | Multi-answer exact set |
| --- | ---: | ---: | ---: |
| Все keyed cases | `73.53%` (`2069/2814`) | `81.17%` (`1573/1938`) | `56.62%` (`496/876`) |
| Holdout split | `83.79%` (`486/580`) | `87.39%` | `72.92%` |
| Dev split | `77.14%` (`388/503`) | `83.09%` | `63.64%` |

Для `single` правильным считается только точный выбор одного ответа. Для `multi` правильным считается только полное совпадение множества ответов, поэтому multi-метрика строже и обычно ниже.

## Установка

Из npm, когда пакет опубликован:

```bash
npm install med-pdf-nmo
```

Напрямую из Git HTTPS URL:

```bash
npm install git+https://github.com/lKolabrodl/nmo-helper-pdf.git#main
```

Или в `package.json`:

```json
{
  "dependencies": {
    "med-pdf-nmo": "git+https://github.com/lKolabrodl/nmo-helper-pdf.git#main"
  }
}
```

При установке из Git npm выполнит `prepare`, поэтому пакет сам соберет `dist`.

## Browser / React / Chrome Extension

Для браузерного окружения используй browser entrypoint:

```ts
import { answerQuestion } from "med-pdf-nmo/browser";

const result = await answerQuestion(new Uint8Array(pdfData.slice(0)), {
  question,
  variants,
  type: isSingle ? "single" : "multi",
});
```

Browser entrypoint уже содержит и регистрирует PDF.js внутри пакета. В обычном React, Vite, Webpack или Chrome-extension коде не нужно отдельно импортировать `pdfjs-dist`, настраивать `GlobalWorkerOptions.workerSrc` или передавать `pdfjsLib` в каждый вызов.

## Подключение через script tag

Для прямого подключения в браузере:

```html
<script src="./dist/med-pdf-nmo.browser.js"></script>
```

Глобальный объект:

```html
<input id="pdf" type="file" accept="application/pdf" />

<script>
  document.querySelector("#pdf").addEventListener("change", async (event) => {
    const file = event.target.files[0];

    const result = await MedPdfNmo.answerQuestion(file, {
      question: "Текст вопроса",
      variants: ["Ответ A", "Ответ B", "Ответ C"],
      type: "single"
    });

    console.log(result.selectedIds, result.selected, result.confidence);
  });
</script>
```

Для публичного GitHub-репозитория можно использовать CDN:

```html
<script src="https://cdn.jsdelivr.net/gh/lKolabrodl/nmo-helper-pdf@main/dist/med-pdf-nmo.browser.js"></script>
```

## Node.js

```js
import fs from "node:fs/promises";
import { answerQuestion } from "med-pdf-nmo";

const pdfBuffer = await fs.readFile("./doc.pdf");

const result = await answerQuestion(pdfBuffer, {
  question: "Какой препарат показан пациенту?",
  variants: ["Ответ A", "Ответ B", "Ответ C", "Ответ D"],
  type: "single"
});

console.log(result.selectedIds);
console.log(result.selected);
console.log(result.confidence);
console.log(result.evidence);
```

В Node.js PDF можно передавать как `Buffer`, `Uint8Array`, `ArrayBuffer` или URL-строку.

## API

### `answerQuestion(pdf, options)`

```ts
const result = await answerQuestion(pdf, {
  question: "Текст вопроса",
  variants: ["Ответ A", "Ответ B", "Ответ C"],
  type: "single"
});
```

`pdf` может быть:

- `File`
- `Blob`
- `Buffer`
- `ArrayBuffer`
- `Uint8Array`
- URL-строка
- объект с методом `arrayBuffer()`

`options`:

- `question`: текст вопроса.
- `variants`: варианты ответа.
- `answers`: алиас для `variants`.
- `type`: `"single"` или `"multi"`.
- `mode`: алиас для `type`.
- `cacheKey`: необязательный ключ кеша для текста PDF.
- `pdfjsLib`: необязательная явная передача PDF.js модуля.

Варианты можно передавать строками:

```js
variants: ["Ответ A", "Ответ B", "Ответ C"]
```

Или объектами со стабильными ID:

```js
variants: [
  { id: "A", text: "Ответ A" },
  { id: "B", text: "Ответ B" },
  { id: "C", text: "Ответ C" }
]
```

### Результат

```js
{
  selected: ["Ответ B"],
  selectedIds: ["B"],
  mode: "single",
  confidence: 0.73,
  scores: [
    { id: "A", variant: "Ответ A", score: 0.12, raw: 0.41 },
    { id: "B", variant: "Ответ B", score: 0.73, raw: 1.92 }
  ],
  evidence: [],
  meta: {},
  raw: {}
}
```

Главные поля:

- `selected`: выбранные тексты ответов.
- `selectedIds`: ID выбранных ответов.
- `confidence`: относительная уверенность.
- `scores`: score по всем вариантам.
- `evidence`: найденные фрагменты PDF.
- `raw`: низкоуровневый результат predictor.

## Multi-answer вопросы

```js
const result = await answerQuestion(pdfBuffer, {
  question: "Какие утверждения верны?",
  variants: [
    { id: "A", text: "Утверждение A" },
    { id: "B", text: "Утверждение B" },
    { id: "C", text: "Утверждение C" },
    { id: "D", text: "Утверждение D" }
  ],
  type: "multi"
});
```

В `selectedIds` будет массив выбранных ID.

## Низкоуровневые exports

```js
import {
  predict,
  answerQuestion,
  setPdfJsLib,
  clearPredictorCache
} from "med-pdf-nmo";
```

- `answerQuestion`: удобный высокоуровневый API.
- `predict`: низкоуровневый predictor API.
- `setPdfJsLib`: ручная настройка PDF.js.
- `clearPredictorCache`: очистка runtime-кеша predictor.

## CLI

После установки пакет добавляет команду:

```bash
med-pdf-nmo --help
```

Пример:

```bash
med-pdf-nmo --pdf doc.pdf --question "Текст вопроса" --mode single --answer A="Ответ A" --answer B="Ответ B"
```

Локально в репозитории:

```bash
npm run predict -- --pdf doc.pdf --question "Текст вопроса" --mode single --answer A="Ответ A" --answer B="Ответ B"
```

## Сборка

```bash
npm install
npm run build
```

Сборка создает:

- `dist/index.js`: основной ESM entrypoint.
- `dist/index.d.ts`: TypeScript-типы.
- `dist/med-pdf-nmo.browser.js`: браузерный global bundle `MedPdfNmo`.
- `dist/med-pdf-nmo.browser.mjs`: браузерный ESM bundle с PDF.js внутри.
- `dist/browser-shims/*`: browser alias targets для Node built-ins.
- `dist/cli.js`: CLI entrypoint.

## Проверки разработки

```bash
npm test
npm run typecheck
npm run build
npm pack --dry-run
npm run eval
npm run eval:holdout
```

`npm run eval` и `npm run eval:holdout` - developer tooling. Они читают локальные тестовые PDF и answer key, чтобы посчитать accuracy.

Runtime API пакета во время inference не читает eval-файлы, split-файлы, правильные ответы или тестовые fixtures.

## Ограничения

- Пакет не является медицинским советником и не заменяет эксперта.
- Качество зависит от того, насколько хорошо PDF.js извлек текст из конкретного PDF.
- Сканированные PDF без текстового слоя могут потребовать OCR до передачи в пакет.
- Алгоритм выбирает вероятные ответы по PDF evidence, но не гарантирует абсолютную правильность.
- Runtime inference не использует LLM и не обращается к внешним интеллектуальным сервисам.

## Лицензия

MIT. Подробнее см. [LICENSE](./LICENSE).
