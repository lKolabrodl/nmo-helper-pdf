# Browser Port Analysis, Plan, Testing

## Analysis

The workspace has two prior implementations.

`nmo-pdf-easy-chat-gpt` is the best accuracy donor. Its documented and rechecked holdout result is above the acceptance target: `446/550 = 0.8109`. It uses local PDF text extraction, BM25, structural evidence scorers, multi-answer calibration, and conservative post-scoring guards. Runtime leakage checks pass: predictor code does not import test fixtures or answer keys. The weakness is packaging: it was written as a Node/TypeScript runtime and used `node:fs`, `node:path`, `node:crypto`, and file-path PDF input.

`nmo-pdf-easy-claude4.7` is the better library/API donor. It has a cleaner `answerQuestion` export, package-style `index.ts`, model/index separation, and useful coordinate/table ideas. Its quality is lower: docs report roughly `73-74%`, and the full vitest case suite fails on hundreds of cases. It is also Node-bound through filesystem model loading, PDF path extraction, and package dependencies.

Decision: use the ChatGPT scorer as the production algorithm, and borrow the Claude-style public library shape. The browser port must not read `__test__`, `cases.test.ts`, `expected`, or answer keys in runtime code.

## Work Plan

1. Create a browser-first package, now named `med-pdf-nmo`.
2. Copy the best scorer and test corpus from `nmo-pdf-easy-chat-gpt`.
3. Replace Node PDF runtime with browser-compatible input: `ArrayBuffer`, `Uint8Array`, `Blob/File`, or URL string.
4. Expose both low-level `predict` and user-facing `answerQuestion`.
5. Build a plain browser JS bundle at `dist/med-pdf-nmo.browser.js` with global `MedPdfNmo`.
6. Keep Node-only code limited to CLI/eval/test tooling.
7. Verify no fixture/answer leakage and run typecheck, build, dev eval, and holdout eval.

## Testing

Commands run in `med-pdf-nmo`:

- `npm test`: passed. Leakage guard has 3 passing tests; dataset case tests are skipped unless explicitly enabled.
- `npm run typecheck`: passed.
- `npm run build`: passed. Browser bundle generated: `dist/med-pdf-nmo.browser.js`.
- Bundle smoke check: passed. The built JS exposes global `MedPdfNmo` and `answerQuestion`.
- Browser-like VM smoke check with injected PDF.js module: passed.
- `npm run eval`: passed with dev exact accuracy `355/473 = 0.7505`.
- `npm run eval:holdout`: passed with holdout exact accuracy `446/550 = 0.8109`.

Runtime notes:

- Browser runtime under `src/` has no fixture or answer-key references.
- Browser runtime has no Node built-in imports; `src/cli.ts` is the only Node file and is developer tooling.
- Eval scripts read PDFs and expected answers only to measure accuracy.
