# med-pdf-nmo

[Русская версия](./README.ru.md)

`med-pdf-nmo` is a browser-first JavaScript/Node.js package that selects the most likely answer, or answer set, for NMO-style medical questions using a source PDF with clinical recommendations.

The runtime is fully local and non-LLM. It does not use ChatGPT, OpenAI, Anthropic, Gemini, HuggingFace inference, transformer models, or any external AI service. The predictor is based on PDF text extraction, normalization, lexical search, structural heuristics, scoring, and evidence snippets from the PDF.

## What It Does

- Accepts a medical recommendations PDF, a question, and answer variants.
- Extracts PDF text with `pdfjs-dist`.
- Normalizes Russian medical text, PDF artifacts, Greek letters, numeric references, dosage forms, and common OCR quirks.
- Scores every answer using local evidence from the PDF.
- Supports both `single` and `multi` questions.
- Returns selected answers, confidence, per-answer scores, raw scores, evidence snippets, and PDF metadata.
- Works in Node.js, browser bundles, and Chrome-extension style environments.

## Current Accuracy

These numbers come from the local keyed validation corpus. They are not a guarantee for every new PDF, but they are the current reference quality after the final test run.

| Dataset | Exact accuracy | Single-answer | Multi-answer exact set |
| --- | ---: | ---: | ---: |
| All keyed cases | `73.53%` (`2069/2814`) | `81.17%` (`1573/1938`) | `56.62%` (`496/876`) |
| Holdout split | `83.79%` (`486/580`) | `87.39%` | `72.92%` |
| Dev split | `77.14%` (`388/503`) | `83.09%` | `63.64%` |

For `single`, only one exact selected answer is counted as correct. For `multi`, the selected set must exactly match the full expected set, so the metric is naturally stricter.

## Installation

From npm, once published:

```bash
npm install med-pdf-nmo
```

Directly from a Git HTTPS URL:

```bash
npm install git+https://github.com/lKolabrodl/nmo-helper-pdf.git#main
```

Or in `package.json`:

```json
{
  "dependencies": {
    "med-pdf-nmo": "git+https://github.com/lKolabrodl/nmo-helper-pdf.git#main"
  }
}
```

When installed from Git, npm runs `prepare`, so the package builds `dist` during installation.

## Browser / React / Chrome Extension

Use the browser entrypoint when your app runs in a browser-like environment:

```ts
import { answerQuestion } from "med-pdf-nmo/browser";

const result = await answerQuestion(new Uint8Array(pdfData.slice(0)), {
  question,
  variants,
  type: isSingle ? "single" : "multi",
});
```

The browser entrypoint bundles and registers PDF.js internally. In normal React, Vite, Webpack, and Chrome-extension usage you do not need to import `pdfjs-dist`, configure `GlobalWorkerOptions.workerSrc`, or pass `pdfjsLib` into every call.

## Browser Script Tag

For direct browser usage, load the IIFE bundle:

```html
<script src="./dist/med-pdf-nmo.browser.js"></script>
```

Then call the global object:

```html
<input id="pdf" type="file" accept="application/pdf" />

<script>
  document.querySelector("#pdf").addEventListener("change", async (event) => {
    const file = event.target.files[0];

    const result = await MedPdfNmo.answerQuestion(file, {
      question: "Question text",
      variants: ["Answer A", "Answer B", "Answer C"],
      type: "single"
    });

    console.log(result.selectedIds, result.selected, result.confidence);
  });
</script>
```

For public GitHub repositories, CDN usage is also possible:

```html
<script src="https://cdn.jsdelivr.net/gh/lKolabrodl/nmo-helper-pdf@main/dist/med-pdf-nmo.browser.js"></script>
```

## Node.js

```js
import fs from "node:fs/promises";
import { answerQuestion } from "med-pdf-nmo";

const pdfBuffer = await fs.readFile("./doc.pdf");

const result = await answerQuestion(pdfBuffer, {
  question: "Which drug is recommended?",
  variants: ["Answer A", "Answer B", "Answer C", "Answer D"],
  type: "single"
});

console.log(result.selectedIds);
console.log(result.selected);
console.log(result.confidence);
console.log(result.evidence);
```

In Node.js, the PDF input can be a `Buffer`, `Uint8Array`, `ArrayBuffer`, or URL string.

## API

### `answerQuestion(pdf, options)`

```ts
const result = await answerQuestion(pdf, {
  question: "Question text",
  variants: ["Answer A", "Answer B", "Answer C"],
  type: "single"
});
```

`pdf` can be:

- `File`
- `Blob`
- `Buffer`
- `ArrayBuffer`
- `Uint8Array`
- URL string
- any object with `arrayBuffer()`

`options`:

- `question`: question text.
- `variants`: answer variants.
- `answers`: alias for `variants`.
- `type`: `"single"` or `"multi"`.
- `mode`: alias for `type`.
- `cacheKey`: optional PDF text cache key.
- `pdfjsLib`: optional explicit PDF.js module override.

Variants can be plain strings:

```js
variants: ["Answer A", "Answer B", "Answer C"]
```

Or objects with stable IDs:

```js
variants: [
  { id: "A", text: "Answer A" },
  { id: "B", text: "Answer B" },
  { id: "C", text: "Answer C" }
]
```

### Result Shape

```js
{
  selected: ["Answer B"],
  selectedIds: ["B"],
  mode: "single",
  confidence: 0.73,
  scores: [
    { id: "A", variant: "Answer A", score: 0.12, raw: 0.41 },
    { id: "B", variant: "Answer B", score: 0.73, raw: 1.92 }
  ],
  evidence: [],
  meta: {},
  raw: {}
}
```

Important fields:

- `selected`: selected answer texts.
- `selectedIds`: selected answer IDs.
- `confidence`: relative confidence for the selected answer or set.
- `scores`: calibrated and raw score per variant.
- `evidence`: PDF snippets used by the scorer.
- `raw`: low-level predictor output.

## Multi-Answer Questions

```js
const result = await answerQuestion(pdfBuffer, {
  question: "Which statements are correct?",
  variants: [
    { id: "A", text: "Statement A" },
    { id: "B", text: "Statement B" },
    { id: "C", text: "Statement C" },
    { id: "D", text: "Statement D" }
  ],
  type: "multi"
});
```

`selectedIds` will contain all selected answer IDs.

## Low-Level Exports

```js
import {
  predict,
  answerQuestion,
  setPdfJsLib,
  clearPredictorCache
} from "med-pdf-nmo";
```

- `answerQuestion`: convenient high-level API.
- `predict`: low-level predictor API.
- `setPdfJsLib`: explicit PDF.js configuration hook.
- `clearPredictorCache`: clears the runtime predictor cache.

## CLI

After installation, the package provides:

```bash
med-pdf-nmo --help
```

Example:

```bash
med-pdf-nmo --pdf doc.pdf --question "Question text" --mode single --answer A="Answer A" --answer B="Answer B"
```

Local development:

```bash
npm run predict -- --pdf doc.pdf --question "Question text" --mode single --answer A="Answer A" --answer B="Answer B"
```

## Build

```bash
npm install
npm run build
```

Build outputs:

- `dist/index.js`: main ESM entrypoint.
- `dist/index.d.ts`: TypeScript declarations.
- `dist/med-pdf-nmo.browser.js`: browser global bundle with `MedPdfNmo`.
- `dist/med-pdf-nmo.browser.mjs`: browser ESM bundle with PDF.js included.
- `dist/browser-shims/*`: browser alias targets for Node built-ins.
- `dist/cli.js`: CLI entrypoint.

## Development Checks

```bash
npm test
npm run typecheck
npm run build
npm pack --dry-run
npm run eval
npm run eval:holdout
```

`npm run eval` and `npm run eval:holdout` are development-only quality checks. They read local test PDFs and answer keys to calculate accuracy.

The runtime package API does not read eval files, split files, answer keys, or test fixtures during inference.

## Limitations

- This package is not medical advice and does not replace expert review.
- Quality depends on how well PDF.js extracts text from a specific PDF.
- Scanned PDFs without a text layer may require OCR before being passed to the package.
- The algorithm selects likely answers from PDF evidence, but it cannot guarantee absolute correctness.
- Runtime inference is non-LLM and does not call external intelligent services.

## License

MIT. See [LICENSE](./LICENSE).
