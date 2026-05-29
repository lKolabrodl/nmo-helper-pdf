# Algorithm

## Input

`npm run predict` accepts either a JSON request file or CLI flags.

JSON shape:

```json
{
  "pdfPath": "doc.pdf",
  "question": "Question text",
  "answers": [
    { "id": "A", "text": "Option 1" },
    { "id": "B", "text": "Option 2" }
  ],
  "mode": "single"
}
```

CLI examples:

```bash
npm run predict -- --input request.json
npm run predict -- --pdf __test__/35-cron/doc.pdf --question "..." --mode single --answer A="..." --answer B="..."
```

## Output

The predictor returns machine-readable JSON:

- `selected`: selected answer ids;
- `mode`: `single` or `multi`;
- `confidence`: calibrated confidence for the selected answer/set;
- `scores`: calibrated score per answer id;
- `rawScores`: uncalibrated evidence score per answer id;
- `evidence`: PDF snippets with page, answer id, evidence kind, and score;
- `meta`: PDF page/chunk count and detected question intent.

## Runtime Pipeline

1. Extract PDF text page-by-page with `pdfjs-dist`, stripping generic running boilerplate (`страница N из M` footers, standalone page-number lines, and URL/source lines) so it does not pollute chunks or numeric matching. The running guideline header is intentionally kept because it carries the disease name. The "Список литературы" (bibliography) section is also removed — it is ~22% of the text, is pure citation noise that can never be an answer, and is cleanly bounded from its heading to the next "Приложение ..." section so all clinical appendices are kept; removing it sharpens term IDF and cuts false Latin/gene matches from author/journal names. More pure-metadata blocks are removed for the same reason: the table of contents (detected by its dotted/ellipsis leaders, since most TOCs have no "Содержание"/"Оглавление" heading), the front-matter appendix list, and appendix А1 "Состав рабочей группы" (working-group names). Methodology (А2), related-documents (А3), and the quality-criteria checklist were tested and NOT removed — they regressed held-out accuracy because their text is close to clinical vocabulary; clinical appendices Б/В/Г are always kept, and "рабочая группа" glossary definitions are kept as content.
2. Detect low-text PDFs and expose `meta.ocrNeeded`; no OCR is run.
3. Normalize text:
   - Unicode NFKC;
   - lowercase;
   - `ё/е`;
   - dash, punctuation, decimal, range, and whitespace cleanup;
   - safe Cyrillic/Latin lookalike folding for mixed medical/PDF text;
   - Greek-letter aliases: `α/β/γ` and Russian `альфа/бета/гамма` are folded to the same `alpha/beta/gamma` search forms;
   - bracketed numeric reference marks such as `[151].` are removed before search tokenization when they appear before sentence punctuation or end-of-text;
   - light Russian suffix stemming;
   - preservation of numbers, percentages, dosages, and common medical abbreviations.
   - one-character numeric tokens such as `1` and `2` are kept, because they distinguish dosage/frequency patterns like `500 мг x 1` vs `500 мг x 2`.
4. Build chunks:
   - page-level text;
   - paragraph/sentence sliding windows;
   - line and line-pair chunks;
   - heading/list context chunks.
5. Index chunks with an in-repo BM25 implementation.
6. Score each answer with non-LLM evidence signals:
   - `question_answer_phrase`;
   - `answer_after_question`;
   - `answer_window` / `answer_directional_window`;
   - `question_anchor_segment`;
   - `question_prefix_continuation`;
   - `preceding_question_label` for long description questions where the PDF writes the answer label before the quoted question text, for example `label: description...`;
   - `question_continuation_list` for multi questions continued in the PDF as `основано/основаны на данных...`, using a longer local line window so the whole list can be seen;
   - `focused_answer_window` for answer hits inside narrow windows that also contain distinctive question-condition tokens;
   - `section_list_segment` for `по <section>` list questions, binding answers to the matching section until the next `По ...` heading;
   - `row_label_segment` for explicit row/list labels in the question, including `МКБ-10 ... кодируется`, stage labels, localized/generalized/rare forms, and age-form labels;
   - `classification_code_segment` for code/MKB questions: an answer code is matched to its own PDF row/window, with OCR normalization for extracted `J` codes such as `.140` and `Л41`;
   - `mkb_class_exclusion_absent` for narrow MKB class exclusion questions: options found in member rows such as `C44.0`/`C44.1` are treated as included in the class, while absent options answer `not included` wording;
   - `polarity_match` / `polarity_mismatch` for increase/decrease and more/less direction near the answer term;
   - `latin_fuzzy_ocr` for multi-answer Latin tokens degraded by PDF OCR/extraction noise;
   - `label_number_proximity` for category/range questions such as severity labels followed by numeric ranges;
   - `short_label_visual_row` and `short_label_exact_row` for compact TNM/roman labels such as `T4`, `T0`, `N0`, and `III/IV`, using nearby coordinate-extracted PDF lines, adjacent pages, and exact label-row continuation when available;
   - `cloze_gap_local` for single-answer blank count questions where the right side of the blank contains `раз/сутки/прием` cues; this uses local line windows, small Russian number aliases, question-number proximity, and contrast penalties to avoid neighboring dose alternatives;
   - `visual_table_column` for multi-answer severity/classification tables: the scorer finds the question's column label in PDF `lineItems` by x-coordinate, then accepts an answer only when its metric token and fully covered numeric/range value appear in that same column;
   - `coordinate_table_row` for single-answer table/classification questions: the scorer groups PDF `lineItems` into x-separated cells, merges nearby row continuations, rejects recommendation/comment metadata rows, and scores the answer only when its cell has enough table context and distinctive question-focus support;
   - `gene_sentence_segment` for mutation/polymorphism gene questions: short Latin gene-symbol answers are matched inside the single sentence that contains the question focus, including OCR variants such as Cyrillic lookalike genes and spaced digit forms;
   - `clinical_feature_segment` for narrow `has following clinical signs` multi questions: positive feature sentences near the form/disease focus are boosted, while same-sentence `not typical/not characteristic/absent` cues become `clinical_feature_negated` penalties;
   - `bounded_list_segment` for local list evidence tied to syndrome names, age clauses, and `triad` cues;
   - `ordinal_list_segment` for numbered stages, therapy-line questions, and numeric `N-я ступень` step lists, including page-break continuation; heading-like `терапия N-й линии` windows are narrowed so previous-line drugs do not leak into the current line;
   - `answer_ordinal_row` for answer options that are themselves stage/degree/type labels (`1/2/3`, `I/II/III`, `N тип`) and must be bound back to the matching classification row or definition-list item; Roman labels require token boundaries so `I` does not match the start of `II`/`III`;
   - `label_definition_segment` for questions like `считается <label> при ...`;
   - `recommendation_polarity_match` for narrow negative-recommendation questions;
   - `exact_numeric_option_segment` for single-answer recommendation/dose/frequency prompts where a full numeric option phrase appears in a relevant local line;
   - `explicit_recommendation_target_segment` / `explicit_recommendation_target_mismatch` for multi questions about `назначение`, `проведение`, `проводить`, or `выполнение` a specific target; the answer must be supported by the recommendation block for that target, and confident hits in neighboring recommendation blocks get a mild penalty;
   - `frequency_recommendation_line` with stricter unit matching for `дни` vs `сутки`;
   - `conditioned_number_segment` and `numeric_condition_*` for tightly scoped condition/value rows such as `2-я неделя -> 0,05`, `20-30 кг -> 60 мг`, and phase abbreviations like `ХФ/ФА/БК -> 400/600 мг`;
   - `count_relation_segment` for single-answer count questions whose variants are short numeric answers, binding the number to local count/relation cues and question focus while ignoring long biomedical answers that only contain incidental numeric tokens;
   - `contrast_cue_mismatch` for multi-answer variants whose strongest evidence contains the opposite cue, such as upper vs lower/basal, increased vs decreased, or distal-proximal vs proximal-distal order;
   - `modifier_target_mismatch` for modifier/noun oppositions such as early vs late menopause, where the opposite modifier is bound to the same target noun in the evidence;
   - `coordinate_table_group` for multi-answer rows in explicit PDF tables: coordinate-extracted left labels are bound to right-side value cells, row continuations are merged, compound labels such as `X/Y` must match all question-focus parts, and numeric-only matches are rejected unless there is lexical or synonym support;
   - `coordinate_table_group_inverse` for the opposite table shape, when the question describes the right-side value cell and the answer option is the left-side label;
   - `coordinate_table_multicell_row` for explicit table rows where one row contains several answerable values across multiple cells/continuation lines; it checks row category cues such as severity, rejects generic header rows, and verifies numeric direction compatibility for expressions like `до 120` vs `более 120`;
   - `parenthetical_group_segment` for explicit category headings followed by one parenthetical answer group, with conservative gating so adjacent parenthetical groups are not merged into one answer set;
   - `roman_stage_segment` for table-style roman stage rows under a `Стадия` heading, including questions written as `II стадия`;
   - `temporal_cue_match` / `temporal_cue_mismatch` for single-answer day/night cues;
   - `bm25_question_answer`;
   - `question_chunk_answer`;
   - `answer_chunk_question`.
   Recent retained row-level signals also include `type_ordinal_segment`, `term_definition_segment`, `recommendation_item_segment`, `drug_dose_segment`, and `fibrosis_stage_row` for tightly scoped type/order, definition, recommendation-row, dose-frequency, and fibrosis-stage row binding. Ordinal line windows use soft focus-token coverage for Russian inflection differences, keep only a short pre-ordinal context, and reject windows where a specific focus token is locally negated by cues such as `без`, `отсутствие`, or `нет`. `term_definition_segment` now also handles `X называют...` definition-style multi questions and requires exact in-window abbreviation evidence when an answer option contains an uppercase abbreviation. The fibrosis scorer now also handles METAVIR `F0-F4` descriptor rows such as absent fibrosis, septa-based F2/F3 descriptions, and cirrhosis. Phrase generation also includes safe variants for answers split around hyphens in PDFs, for `ингибиторы <ABBR>` options that may appear as compact `и<ABBR>` text in guidelines, for a small high-confidence Russian therapy synonym dictionary such as `гормонотерапия` / `гормональная терапия` / `МГТ`, and for stable medical abbreviations such as `СПЯ` and `РЭ`.
   Normalization preserves comparator expressions and folds common PDF extraction artifacts: `≤`/`≦` become `<=`, `≥`/`≧` become `>=`, and `£` before a number is treated as a likely `<=`. Numeric PDF references are removed when they have reference-like punctuation; spaced reference artifacts such as `[ 8 10 ].` are removed only before a sentence-ending dot. Numeric coverage also adds a guarded OCR variant for short split digit groups such as `9 00 мг`, so a source line can still match an answer containing `900 мг`.
   `exact_answer_phrase` is deliberately narrow: it only boosts single-answer oral-dose prompts such as `назначение ... внутрь по`, requires a full multi-number answer phrase in the PDF, and still checks local question-focus tokens.
   A small route synonym dictionary maps high-confidence administration-route forms inside table evidence: `per os`/`внутрь` to peroral, `в/в` to intravenous, `в/м` to intramuscular, and `п/к` to subcutaneous.
   Frequency/duration recommendation evidence is guarded by the subject of the answer: matching only `3 суток` or `7 дней` is not enough when the answer names a different drug or medical agent. Frequency-polarity evidence handles general language cues such as `наиболее част...`, `редк...`, and `ведущ...`: the answer phrase must occur in the same sentence-like fragment as the cue and outside parenthetical examples, or in a bullet item immediately under a matching heading such as `Редкие формы:`. Dose evidence treats ranges such as `10-15 мг` as ranges; a range answer is not considered confirmed by a separate maximum-dose statement such as `до 25 мг`. Slash-dose pairs such as `90/400 мг` are bound by component order near compact combinations (`A+B`, `A/B`), and the right side of the slash is not re-read as a standalone dose for the first component. Hour duration aliases are handled narrowly: answer phrases such as `6 часов` can match a bounded source phrase `6 ч` / `6 ч.`, but this is isolated in `exact_hour_alias_segment` so dense month/dose numeric families are not broadly reweighted. Count-relation evidence binds `количество/число` questions to local count forms such as `различают N серотипов` and requires the target word near the counted number. Parenthetical-group evidence handles both category headings and tightly guarded inline lists such as `ряд ферментов (A, B, C), повреждающих...`, requiring question-focus support around the parentheses and at least two answer options inside the same group. Type-label ordinal evidence handles classification definition rows such as `2 тип: ...` with the same focus-token and next-row boundary checks used for stages/degrees. Simple dense comparator families are guarded: if an answer says `>N` but its evidence only supports `<N` for the same number, the answer is penalized. Compact treatment abbreviations such as `A/B` are treated as combinations only when the parts look like short non-unit abbreviations; units such as `мл/кг` and `МЕ/мл` are not treated as treatment combinations. For questions that explicitly exclude a clinical subgroup (`без X`), local evidence under `при X` / `наличие X` is penalized; procedural phrases such as `без проведения` are skipped.
   Definition-exact evidence handles `X это ...`, `Под X понимают ...`, and dash-definition rows. The answer phrase must be in the same definition fragment and the fragment label must match the question term, allowing a one-edit OCR typo in the label. For nested definition options, a conservative completion adjustment prefers a longer option only when it contains shorter alternatives and already has strong definition evidence.
7. Combine evidence into raw answer scores.
8. Apply a frozen non-LLM feature layer over the evidence kinds:
   - evidence-kind contracts, structural/broad groups, and selection/confidence evidence lists are centralized in `src/predictor/scorer-registry.ts`;
   - small structural evidence bonuses for reliable row/table/code/list scorers;
   - pairwise single-answer contrast when the top two raw scores are near-tied and one candidate has much stronger structural support;
   - conservative multi-answer cardinality adjustments;
   - an all-options guard for 3- and 4-option multi questions, because selecting every option is almost always an over-selection in this corpus;
   - a crowded-tail guard for 4-option multi questions where 3 answers were selected but the third and fourth raw scores are nearly tied; this trims the ambiguous tail to top-2 rather than treating a weak 3-of-4 set as reliable;
   - structural group completion for explicit multi-cell table rows: if two selected answers are supported by the same reconstructed row, a weaker candidate from that same row can be added when it has strong structural evidence;
   - generic structural-cluster pruning for recommendation-like multi questions, gated away from broad list/source/dose-regimen patterns;
   - generic-population adjustment for multi recommendations, applied only when a broad population answer has a more specific same-population alternative among the options.
9. Calibrate scores with relative spread and a softmax-like transform.
10. Select:
   - `single`: highest raw score, except for a conservative near-tie specificity tie-break when top-1/top-2 raw scores are almost equal;
   - `multi`: answers passing absolute, relative, or score-gap thresholds.
11. In `multi` mode, apply a filtered shared-segment boost: if strong selected candidates point to the same high-quality segment, another candidate can be lifted only when it also matches that segment and already has enough prior raw support. This reduces under-selection while avoiding the broad extra-answer regression seen in earlier experiments.
12. Compute output `confidence` separately from selection. This confidence layer does not change selected answers; it discounts predictions supported only by flat search evidence, close selected/unselected raw boundaries, or broad shared chunks without structural evidence.

## Code Layout

- `src/cli.ts`: predict CLI and JSON/flag input parsing.
- `src/predictor.ts`: scoring orchestration, score combination, and the remaining legacy scorers.
- `src/predictor/config.ts`: shared predictor thresholds.
- `src/predictor/constants.ts`: shared stopword/label constants.
- `src/predictor/runtime.ts`: PDF extraction cache and input answer normalization.
- `src/predictor/scorer-registry.ts`: scorer/evidence-kind registry plus shared structural, broad, noisy, confidence, diagnostics, and feature-export evidence contracts.
- `src/predictor/text-utils.ts`: shared phrase, token, evidence, proximity, and number helpers.
- `src/predictor/scorers/search.ts`: anchor, section, phrase, and row-label retrieval scorers.
- `src/predictor/scorers/focused.ts`: question focus extraction plus local focused-window and line/pair evidence scorers.
- `src/predictor/scorers/biomedical-symbols.ts`: Latin biomedical token, gene-symbol, and OCR-lookalike normalization scorers.
- `src/predictor/scorers/coordinate-table.ts`: coordinate-based table row, group, inverse-binding, and multi-cell reconstruction scorers.
- `src/predictor/scorers/drug-dose.ts`: drug/dose/frequency row scorer, including slash-dose order and component-assigned `N mg component` binding.
- `src/predictor/scorers/exact-answer.ts`: narrow exact full-answer scorer for oral dose prompts.
- `src/predictor/scorers/frequency.ts`: frequency/duration recommendation scorer.
- `frequency_polarity_segment` / `frequency_polarity_list_item` in `src/predictor.ts`: narrow sentence/list-heading scorers for common/rare/leading frequency wording.
- `definition_exact_answer_segment` in `src/predictor.ts`: narrow exact-answer scorer for definition fragments with term-label binding and one-edit OCR tolerance.
- `src/predictor/scorers/recommendation-item.ts`: narrow recommendation item scorer.
- `src/predictor/scorers/fibrosis-stage.ts`: fibrosis/METAVIR stage row scorer.
- `src/predictor/scorers/direction.ts`: polarity, temporal day/night, clinical course manifestation, contrast-cue, modifier-target, and excluded-condition mismatch scorers.
- `src/predictor/scorers/numeric.ts`: cloze-gap, condition-pair, exact-numeric/hour option, condition/numeric-condition, and count-relation scorers.
- `src/predictor/scorers/option-family.ts`: dense option-family guards for comparator direction and compact abbreviation combinations.
- `src/predictor/types.ts`: answer/evidence score contracts.
- `src/predictor/selection.ts`: score calibration and single/multi selection.
- `src/pdf.ts`, `src/chunk.ts`, `src/bm25.ts`, `src/normalize.ts`: extraction, chunking, retrieval, and normalization utilities.
- `scripts/export-features.ts`: offline feature exporter for future non-LLM calibration experiments. It calls predictor with diagnostics enabled, but writes only abstract numeric/categorical evidence features, never question text, answer text, or PDF text.
- `scripts/calibrator-experiment.ts`: offline logistic-calibrator experiment over exported features. It is not used by runtime predictor and currently does not produce frozen weights.

Current selection thresholds:

- single specificity tie-break: top-2 can replace top-1 only when raw gap is `<= 0.2`, top-2 is at least `0.94 * topRaw`, and its generic specificity score is higher by `>= 0.5`
- multi relative threshold: `0.84 * maxRaw`
- multi absolute threshold: `12`
- multi gap threshold: `0.72`
- minimum selected answers in `multi` mode: `2`
- third-answer near-tie inclusion: add the third answer when it is within `0.45` raw score of the second and at least `0.55 * maxRaw`
- all-options guard: when `multi` selects every option and there are exactly 3 or 4 options, reduce to the top-2 raw candidates; 5+ option all-selected cases are left unchanged
- crowded-tail guard: when a 4-option multi question selects 3 answers, reduce to top-2 only if the third selected answer is separated from the unselected fourth by less than `0.3` raw score and the top answer is not tied with the second
- shared segment boost: enabled, with a raw prior ratio floor before any candidate can be lifted.
- frozen feature ranker, multi-cardinality model, pairwise contrast, and structural-cluster adjustments are enabled; all use fixed local coefficients and evidence kinds only.

## Diagnostic Feature Export

`predict()` supports an optional `diagnostics: true` development flag. This flag does not change scoring or selection. It only returns per-answer evidence summaries:

- evidence count;
- unique evidence page count;
- best evidence score;
- evidence-kind counts;
- best score by evidence kind.

The public default output remains unchanged. The exporter uses these summaries to create offline rows for safe calibrator research. The generated `features` object intentionally excludes raw texts, PDF identifiers, case identifiers, and answer identifiers; those values are metadata only.

## Non-LLM Guarantee

Runtime files under `src/` use only Node.js, local TypeScript modules, and `pdfjs-dist`. They do not import eval files, answer keys, split files, network clients, LLM APIs, transformer inference, or external AI services.

`npm test` includes leakage checks for `src/predictor.ts`, `src/predictor/**/*.ts`, and `src/cli.ts`.

## Known Limitation

The main remaining limitation is layout semantics. Many NMO PDFs contain tables and compact recommendation lists; after `pdfjs-dist` extraction, mutually exclusive rows and answer values often become one flat paragraph. The current text-only algorithm can retrieve the right area and now handles several row-like patterns, but it still cannot always reconstruct which value belongs to which row, condition, heading, or list item.
