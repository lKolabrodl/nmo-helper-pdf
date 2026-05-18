# Research

## Constraints

Runtime inference is JavaScript/Node.js only. It does not use LLMs, transformer inference, remote AI services, generated embeddings, HuggingFace inference, or answer keys. Correct labels are read only by eval scripts.

## Data found

The current corpus has 42 PDF groups under `__test__/NN-name/`. Each group contains `doc.pdf` and `cases.test.ts`. The TypeScript case files contain the question, variants, mode, and expected labels. The predictor never imports these files; `scripts/eval.ts`, `scripts/cases.ts`, and offline diagnostic scripts read them only for scoring or feature-label export.

Current parsed cases: 2637, including 17 unkeyed cases that are skipped by exact eval.

- answer-keyed cases: 2620
- single-answer answer-keyed cases: 1811
- multi-answer answer-keyed cases: 809

## Approaches considered

| Approach | Pros | Cons | Decision |
| --- | --- | --- | --- |
| Exact string matching | Strong when a question is a literal PDF prefix | Brittle to line breaks, OCR noise, inflection, and tables | Kept as one high-confidence signal |
| TF-IDF/BM25 retrieval | Fast, transparent, no model serving | Needs careful normalization and chunking | Implemented in repo |
| Question+answer phrase scoring | Good for cloze-style NMO questions | Can over-score distractors when all options are nearby | Implemented with proximity signals |
| Contrastive answer scoring | Compares options against the same retrieved context | Still confused by flattened tables | Implemented through per-answer raw scores and calibrated relative scores |
| List/anchor scoring | Improves "относятся/являются/следующие" multi questions | Requires robust anchor extraction | Implemented and kept |
| Line/table chunks | Can recover some table rows | `pdfjs-dist` often flattens table order into one paragraph | Tried; partially kept line chunks, not sufficient |
| Compact numeric windows | Intended to fix numeric table rows | Over-scored neighboring values in flattened text | Tried and reverted |
| Russian number-word aliases | Helps digits vs words like "six" | Folded Cyrillic/Latin extraction produced false numeric matches in nearby context | Tried and reverted |
| OCR fallback | Needed for scanned PDFs | JS OCR is heavy and not needed for current text-extractable corpus | Not implemented; low-text PDFs are flagged |
| Small non-LLM feature calibrator | Could improve near-ties and multi pruning without medical text memorization | Dangerous if trained on question/answer text, PDF ids, or labels leaking into features | Exporter and experiment script exist; learned weights are still rejected because dev/holdout stability is worse than fixed structural rules |

## Selected best architecture

The best retained version extracts PDF text with `pdfjs-dist`, normalizes Russian/medical text, builds sentence/list/line chunks, indexes them with BM25, and scores each answer using an ensemble of non-LLM evidence signals:

- direct normalized `question + answer` phrase support;
- answer occurrence near or after question-like text on the same page;
- list-like question anchor segments;
- prefix continuation matching;
- BM25 for `question`, `answer`, and `question + answer`;
- answer coverage and token proximity inside top question chunks;
- calibrated relative scoring and dev-tuned multi thresholds;
- minimum multi-answer cardinality and a narrow third-answer near-tie rule;
- single-character numeric token preservation for dosage/frequency variants.
- narrow line-level binding for dose frequency, conditional-only recommendations, first-line therapy rows, biological/mechanical valve prosthesis recommendation rows, and fibrosis stage rows extracted from the PDF.
- explicit recommendation target binding for multi questions about `назначение/проведение/выполнение X`, so an answer must be supported by the recommendation block for target `X`;
- conservative multi contrast-cue pruning for opposite option cues such as upper/lower, increased/decreased, and distal-proximal/proximal-distal.
- conservative coordinate table-group reconstruction for explicit `Таблица` layouts, binding left row labels to right-side values in multi questions and using a small high-confidence RU route dictionary (`per os`/`внутрь`, `в/в`, `в/м`, `п/к`) for administration-route rows.
- inverse coordinate table binding when the question matches the right-side value and answer options are left-side labels, plus multi-cell row reconstruction with numeric direction checks and structural completion for answers from the same table row.
- narrow full-answer exact matching for single oral-dose questions where the answer is a multi-number phrase and the PDF contains it near the question focus.

The best current algorithm reaches dev exact accuracy `0.7759` and holdout exact accuracy `0.8309`, passing the required holdout `0.80` acceptance target. The answer-keyed overall score is still `1930/2620 = 0.7366`, so future work is focused on multi-answer set selection and layout-aware evidence.

## Feature Calibrator Research Guardrails

The next non-LLM research direction is a small frozen feature calibrator. To avoid fitting the current 40+ PDFs instead of the task, the first step is diagnostic export only:

- `npm run features:export -- --split dev` writes `.cache/features/dev-features.json`.
- Feature rows include labels for offline analysis, but labels are outside `features`.
- Feature rows do not contain question text, answer text, PDF text, PDF names, case ids, or PDF group ids.
- `pdfGroup`, `caseId`, and `answerId` are metadata only and must not be used as model inputs.
- Candidate features are abstract: raw score, calibrated score, rank/gap metrics, answer/question token counts, numeric flags, intent flags, selected-count ratios, and evidence-kind counters.
- Any learned coefficients must be validated by group split by PDF and a leave-PDF-out sanity check before being frozen into runtime.
- Holdout labels are for final reporting only, not for coefficient selection.

Current dev diagnostic export:

- baseline exact: `363/473 = 0.7674`
- single exact: `0.8328`
- multi exact: `0.6181`
- oracle top-k with known cardinality: `0.8076` overall and `0.7500` for multi
- selected false-positive answer rows: `103`
- missed positive answer rows: `99`

The oracle result means cardinality calibration is useful but not sufficient; the remaining gap also needs better structural evidence for tables, lists, and recommendation rows.

Train/dev/holdout feature files are now available under `.cache/features/`. They are generated artifacts for local analysis and are not package runtime assets.

## First Calibrator Experiment

`npm run calibrator:experiment` trains a small logistic model on train feature rows only. It then tries two offline selection families:

- replacing the selector with model probabilities;
- keeping baseline selections and using the model only as a conservative multi-answer post-corrector.

Current result:

- full selector replacement remains worse than baseline on dev and holdout;
- after enabling the current fixed structural rules, the best dev-selected post-corrector no longer improves dev (`363/473 = 0.7674`);
- the same dev-selected strategy is slightly better on train (`1108/1597`) but weaker on holdout report-only (`454/550`), so it is still not stable enough to freeze into runtime.

Decision: keep the experiment script, reject the learned selector for now. The next calibrator attempt needs either richer structural features or leave-PDF-out stability checks before any runtime integration.
