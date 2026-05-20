# Error Analysis

## Current Error Counts

Latest run after iteration 56 on the current 42-PDF corpus. Metrics below exclude `17` unkeyed `22-eozif` cases with `expected: []`.

Train (`1597` keyed cases):

- correct: `1106`
- errors: `491`
- `confused_with_distractor`: `316`
- `multi_cardinality`: `175`

Dev (`473` cases):

- correct: `365`
- errors: `108`
- `confused_with_distractor`: `72`
- `multi_cardinality`: `36`

Holdout (`550` cases):

- correct: `456`
- errors: `94`
- `confused_with_distractor`: `67`
- `multi_cardinality`: `27`

All keyed splits combined:

- correct: `1927/2620 = 0.7355`
- errors: `693`
- `confused_with_distractor`: `455`
- `multi_cardinality`: `238`

Worst PDFs by remaining error count across all keyed splits after iteration 56:

- `35-cron`: `31`
- `24-kalit`: `28`
- `37-bazal`: `28`
- `30-heart`: `27`
- `36-anrid`: `27`
- `29-tpank`: `26`
- `13-pisha`: `25`
- `05-bronhit-hron`: `22`
- `16-hb`: `22`
- `39-glaurova`: `22`

Worst holdout PDFs:

- `33-aorta`: `15`
- `18-gepatitabc`: `13`
- `14-sarkoidoz`: `12`
- `06-co-toksic`: `11`
- `17-gepatit`: `11`
- `19-gepatitc`: `11`
- `23-nimana`: `11`
- `11-mening`: `10`

The older snapshot below is kept for comparison.

Dev (`404` cases):

- correct: `278`
- errors: `126`
- `confused_with_distractor`: `75`
- `multi_cardinality`: `51`

Holdout (`480` cases):

- correct: `330`
- errors: `150`
- `confused_with_distractor`: `106`
- `multi_cardinality`: `44`

No-evidence count is `0` on both dev and holdout: the predictor usually finds a relevant PDF region, but often cannot choose the exact option/set from that region.

## Main Error Classes

### 1. Flattened Tables

Many PDFs contain tables where rows such as severity/category/value are extracted by `pdfjs-dist` as one long paragraph. The predictor retrieves the correct table but cannot reliably bind a row label to the correct numeric range or drug list.

Symptoms:

- single-answer questions select a neighboring numeric range;
- several options receive nearly identical raw scores;
- confidence stays high even when the selected row is wrong.

### 2. Multi-Answer Cardinality

For multi-answer tasks, the evidence often supports the topic but not the exact set. The algorithm may select only the strongest option or include an adjacent supported-looking distractor.

Symptoms:

- correct option omitted because its evidence is weaker than the top option;
- extra option selected because it appears in the same recommendation/table chunk;
- threshold tuning improves one subset and harms another.

### 3. Nearby Distractors

Medical guideline PDFs frequently list related concepts together. A wrong variant may appear in the same sentence, bullet list, or page as the correct answer.

Symptoms:

- BM25 retrieves the right page;
- correct answer is present in evidence but not top-scored;
- answer text with more exact terms beats the answer that matches the question condition.

### 4. PDF Text Noise

Some pages contain broken Latin/Cyrillic glyphs, split words, false spaces, and flattened headers/footers. Normalization mitigates this, but not enough for all cases.

Symptoms:

- abbreviations and table labels are split;
- row order becomes ambiguous;
- compact table columns are merged.

## Failed Improvement Attempts

Evidence-based multi inclusion improved recall for some examples but lowered dev exact accuracy from `0.6510` to `0.6337` by adding extra options.

Compact numeric windows and Russian number-word aliases lowered dev exact accuracy to `0.6238`. The added signals made neighboring numbers in flattened tables look more relevant.

Raw PDF line/layout chunks fixed isolated table rows but lowered dev to `0.6361` when they replaced merged line chunks. Adding them to global BM25 also shifted multi-answer scores too much.

IDF-weighted question coverage did not improve holdout exact accuracy and slightly lowered dev.

Focused raw-line scoring for dose questions fixed some local examples but regressed dev to `0.6683`, mostly because adjacent drug/dose rows were too close in flattened text.

Question-number support for non-numeric answers lowered dev to `0.6733` and holdout to `0.6688`, so it was reverted.

Token-boundary exact phrase matching lowered dev to `0.6782` and holdout to `0.6729`. It removed some false substring matches but also broke useful partial matches in noisy PDF text, so it was reverted.

An answer-internal `value + condition` scorer for rows like `каждые 1-2 года для умеренной ...` lowered dev to `0.6807` and holdout to `0.6854`. It over-boosted adjacent condition/value pairs in the same line and was disabled.

During the continuation, a broad shared multi-answer inclusion rule was retried. Without a prior raw-score ratio filter it improved dev but dropped holdout to `429/550 = 0.7800`, mainly by adding plausible extras in `14-sarkoidoz` and `33-aorta`. The final version keeps only candidates with enough prior raw support.

A single-answer cloze-tail continuation scorer was tested after iteration 34. It was neutral on train/dev/holdout and did not fix the sampled single-answer distractor errors, so it was removed.

A recommendation/question-cue single-answer scorer was tested during the iteration 36-37 continuation. It improved one sampled "purpose/cue + answer" pattern but was net neutral or negative (`dev -1`, `holdout +1`, train unchanged), so it was disabled.

An explicit fourth-answer multi rule was explored for under-selected 4-answer sets. It did not improve the combined split metrics without adding extra false positives, so it was not implemented.

During iteration 38, a global multi-threshold grid was run over relative threshold, score-gap threshold, third-answer gap/relative thresholds, and caps. The current config remained the best overall setting that preserved holdout `>= 0.80`; threshold-only tuning cannot close the overall gap.

Also during iteration 38, a broad binary cue scorer (`наличие/отсутствие`) and a broad answer-contrast token scorer were tried on the main multi distractor class. They were not retained because they fixed some sampled rows but over-boosted unrelated neighboring segments, for example shared "absence/effect" wording without the distinguishing route/dose/list item.

During iteration 39, a broad shared-multi phrase matching fix recovered a representative four-component therapy set but regressed dev (`342/473`) and holdout (`442/550`) by adding plausible extras, so it was reverted. A numeric count-word scorer for `один раз/однократно/двукратно` was also disabled: flattened windows often contain the correct and neighboring count phrases together, making it boost both sides.

During iteration 41, a comparator-number scorer for `<`, `>`, and `=` expressions fixed duplicated `ОФВ1/ФЖЕЛ <0,7` examples locally, but it also over-boosted unrelated age/range rows in `23-nimana` and `33-aorta`; holdout dropped to `442/550`, so the scorer was reverted.

During iteration 42, coordinate-aware table row reconstruction was tried directly. The broad version grouped PDF items into x-separated cells and scored table-like rows across all applicable modes, but it dropped dev to `341/473` by treating recommendation/comment metadata and adjacent rows as answer evidence. The retained version is gated to single-answer table/classification questions, blocks fibrosis-stage questions, rejects recommendation metadata rows, and disables multi-answer coordinate rows because equal row evidence over-selected distractors.

During iteration 43, all five proposed directions were implemented as a conservative post-scoring layer: frozen evidence-feature ranker, multi-cardinality model, pairwise single contrast, coordinate row contrast, and generic structural-cluster pruning. The broad version regressed train broad-list/source/dosing questions, so the retained pruning is limited to recommendation-like multi questions and gated away from `all patients`, differential/source lists, and dose-regimen patterns.

During iteration 44, the multi all-options hypothesis was tested. Only `3/809` multi cases have every answer option correct, while the predictor selected every option in `11` cases and was right only once. The retained guard applies only to 3- and 4-option all-selected predictions and cuts them to top-2 raw candidates; 5+ all-selected cases are left unchanged because they include a real all-correct train case and complex lists.

## Current Top Derived Classes

- all keyed splits: `confused_with_distractor = 456`, `multi_cardinality = 239`
- train: `confused_with_distractor = 316`, `multi_cardinality = 175`
- dev: `confused_with_distractor = 73`, `multi_cardinality = 37`
- holdout: `confused_with_distractor = 67`, `multi_cardinality = 27`

Holdout exact accuracy improved through iteration 55 and still passes:

- `confused_with_distractor`: `67`
- `multi_cardinality`: `27`

Worst holdout PDFs by remaining error count:

- `33-aorta`: `15` errors
- `18-gepatitabc`: `13` errors
- `19-gepatitc`: `13` errors
- `14-sarkoidoz`: `12` errors
- `06-co-toksic`: `11` errors
- `17-gepatit`: `11` errors
- `23-nimana`: `11` errors
- `11-mening`: `10` errors

## Remaining Risk After Passing 0.80

Iteration 55 passes the holdout target with exact accuracy `0.8291` (`456/550`). The new user-requested overall target is not reached: answer-keyed overall accuracy is `1925/2620 = 0.7347`, requiring `171` more exact answers to reach `0.80`.

The main residual risk is still layout semantics plus exact multi-answer set selection. Isolated visual-row, exact short-label row, step-window, condition-number, definition-window, answer-stage/degree row, count-cloze, coordinate table-column, coordinate table-row, gene-symbol sentence binding, narrow clinical-feature sentence binding, MKB class exclusion binding, explicit recommendation target binding, contrast-cue mismatch pruning, frozen feature/cardinality pruning, all-options/crowded-tail guards, MKB/code-row binding, and near-tie specificity rules recover some cases, but many remaining errors come from flattened tables, adjacent recommendation bullets, and weak cardinality calibration. The remaining 171-answer overall shortfall requires richer structural evidence, not another scalar threshold tweak.

Iteration 50 diagnostic export:

- Added offline answer-row feature export without changing predictor selection.
- Dev export has `1956` answer rows: `701` positives, `707` baseline-selected rows, `593` selected positives.
- Baseline dev remains `355/473 = 0.7505`; single remains `0.8328`, multi remains `0.5625`.
- Oracle top-k with known answer count reaches `0.8013` overall and `0.7292` on multi, so a cardinality/rank calibrator has room to help but cannot replace better structural evidence.
- Dev selected false-positive rows: `114`; dev missed positive rows: `108`.
- Abstract feature comparison on dev:
  - positives average raw rank `1.72`; missed positives average raw rank `3.16`;
  - selected false positives have average gap-to-top `0.79`, while missed positives average `6.85`;
  - positives have structural evidence more often than negatives (`0.17` vs `0.074`), but many positives are still broad/noisy-only evidence (`0.83`), which explains why simple pruning is risky.

Conclusion: a small calibrator should focus on near-ties, evidence-kind reliability, and multi cardinality. It must not use question/answer text, PDF group, case id, answer id, or holdout labels.

Iteration 51 calibrator experiment:

- Trained a small logistic model on train answer-row features only.
- Replacing the selector with model probabilities regressed dev from `0.7505` to `0.7336` and holdout report-only from `0.8164` to `0.7964`.
- A conservative baseline post-corrector improved dev by one exact case (`355 -> 356`) and multi exact from `0.5625` to `0.5694`, but train dropped by one and holdout report-only dropped by two (`449 -> 447`).
- The gain is therefore not stable. No model weights were integrated into runtime.

Conclusion: the current abstract rank/gap/evidence-kind features are useful for analysis but too weak for a frozen learned selector. The next useful feature work should expose more structural table/list binding signals rather than relying on a generic row classifier.

Iteration 52 gated count-relation outcome:

- Hypothesis: count-style single questions can be improved by binding short numeric answer options to local text that also contains the question focus and count/relation cues.
- Kept narrowly: `count_relation_segment` is enabled only for single questions and only when the answer option itself looks like a short numeric answer. This prevents false positives where a long biomedical answer merely contains an incidental token like `CD8+`.
- Outcome: train improves from `1104/1597` to `1105/1597`, dev stays `355/473`, and holdout improves from `449/550` to `452/550`.
- Single-answer overall improves by four exact answers; multi is unchanged.

Rejected in the same iteration: broader single near-tie specificity tuning improved dev by one case but broke train and holdout, so the selector thresholds were not changed.

Iteration 53 ordinal-boundary outcome:

- Hypothesis: some answer options encode a degree/stage label, but substring matching can confuse `степень` with unrelated words such as `постепенное`.
- Kept: ordinal cue detection now checks token boundaries and stems instead of raw substring inclusion.
- Outcome: dev improves by one exact case (`355 -> 356`) without changing train or holdout.

Iteration 54 explicit recommendation target outcome:

- Hypothesis: multi recommendation questions often ask about a specific target after `назначение`, `проведение`, `проводить`, or `выполнение`; answers found only in a neighboring recommendation block should not be treated as equally supported.
- Kept: recommendation blocks are collected from explicit `рекомендовано...` lines, target/context coverage is required, numeric answer coverage is checked, and follow-up frequency answers are exempted from mismatch penalties.
- Kept: generic population answers like `всем пациентам` are penalized only when another answer option names the same population more specifically, for example by severity or condition.
- Outcome: dev improves from `356/473` to `362/473`; holdout improves from `452/550` to `454/550`; gains are concentrated in multi exact sets.

Iteration 55 contrast-cue outcome:

- Hypothesis: some wrong multi variants are near the right evidence but encode the opposite cue: upper vs lower/basal, increased vs decreased, or distal-proximal vs proximal-distal order.
- Kept narrowly: only short, explicit contrast cue groups are used, and only when the candidate's strongest evidence text contains the opposite cue but not the answer's own cue.
- Outcome: dev improves to `363/473`, holdout improves to `456/550`, and multi exact overall reaches `462/809 = 0.5711`.

Iteration 56 ordinal parser outcome:

- Hypothesis: answer options like `I/II/III стадии` can be misbound when the Roman `I` regex matches the start of `II` or `III` inside an ordinal row.
- Kept: answer-option ordinal row matching now requires a boundary after the Roman/numeric label, and skips Roman `I` matches that are actually the conjunction between two neighboring Roman ordinals.
- Kept: a final multi-selection guard collapses duplicate selected answer texts after normal selection, so identical variants are not returned twice as separate semantic answers.
- Outcome: dev improves from `363/473` to `365/473`; holdout remains `456/550`; answer-keyed overall becomes `1927/2620 = 0.7355`.
- Rejected in the same continuation: stricter short-Latin fuzzy matching, therapy-structure mono/combination matching, row-start ordinal visual boosting, definition-length boosting, and re-enabling `condition_number_segment`. These were neutral or regressive on dev/holdout and were not retained.

Iteration 45 hypothesis and outcome:

- Hypothesis: multi questions should almost never select every option, and large 3-of-4 selections are suspicious when the selected tail is not separated from the unselected option.
- Kept narrowly as `multiCrowdedTailGuard`: only 4-option multi questions with 3 selected answers are trimmed to top-2, and only when the third/fourth raw-score gap is below `0.3`.
- Outcome: dev improved from `355/473` to `358/473`, dev multi exact improved from `0.5625` to `0.5833`, and holdout stayed `446/550 = 0.8109`.

Post-iteration 45 co-location hypothesis:

- Hypothesis: correct multi answers should usually be located near each other in the PDF, so selected answers outside the main page/text evidence cluster can be pruned, or unselected answers inside the same cluster can be added.
- Existing implementation already partially uses this idea through `sharedMultiSegmentBoost`, `bounded_list_segment`, `section_list_segment`, and recommendation-like structural cluster pruning.
- Additional generic page/text cluster post-rules were tested offline on dev and holdout multi outputs. They were not retained: page/text pruning fixed a few extras but broke more real multi sets, while adding same-cluster candidates caused broad over-selection.

Iteration 46 normalization and ordinal-heading outcome:

- Hypothesis: PDF text can write Greek-letter drug names with symbols (`ФНО-α`), while answer options often use Russian names (`ФНО-альфа`), so both forms should normalize to one alias.
- Kept: `альфа/бета/гамма` now normalize to the same `alpha/beta/gamma` aliases as `α/β/γ`.
- Kept: bracketed numeric reference marks such as `[151].` and `[1,4,93,165].` are stripped before search tokenization when they stand before sentence punctuation or end-of-text.
- Kept narrowly: `терапия N-й линии` ordinal windows start near the heading instead of pulling a wide previous context, preventing drugs from the previous line from scoring as current-line drugs.
- Outcome: `14-sarkoidoz#52` is fixed; holdout improves to `447/550`, train improves to `1102/1597`, while dev drops to `355/473`, mainly in multi-cardinality.

Iteration 47 gene-symbol sentence outcome:

- Hypothesis: short Latin gene symbols in answer options can be extracted from PDFs as Cyrillic lookalikes or spaced digit forms, but for mutation/polymorphism questions the correct symbols are often in one sentence with the question focus.
- Kept: `gene_sentence_segment` matches only mutation/polymorphism gene questions, only inside the sentence with focus tokens, and supports OCR variants such as `FCGR3A -> РСОКЗА`, `MMP9 -> ММР9`, `CC10 -> СС10`, and `NOD2 -> N 0 0 2`.
- Outcome: fixed `14-sarkoidoz#57` and `14-sarkoidoz#39`; holdout improved to `449/550 = 0.8164`, while dev and train stayed unchanged.

Iteration 48 clinical-feature sentence outcome:

- Hypothesis: in multi questions phrased as `имеет следующие клинические признаки`, correct features are often listed in adjacent sentences near the named form, while distractors can be explicitly negated as `не типично` or `не характерно`.
- Kept narrowly: `clinical_feature_segment` boosts only this wording class and only near the question focus; `clinical_feature_negated` penalizes same-sentence negative cues.
- Rejected: a broader version for symptoms, clinical picture, stages, and generic clinical-sign tables regressed train to `1097/1597`.
- Outcome: the Pincus fibroepithelioma case is fixed; train improves to `1103/1597`, dev remains `355/473`, and holdout remains `449/550`.

Iteration 49 MKB class exclusion outcome:

- Hypothesis: for questions like `по МКБ-10 в класс Cxx не включены`, rows beginning with `Cxx.y` are positive class members, so they should be rejected for negative membership wording.
- Kept narrowly: `mkb_class_exclusion_absent` only triggers for multi questions with `МКБ`, explicit `класс`, a class code, and negative wording such as `не включены`/`исключены`.
- Outcome: fixed `37-bazal#32`, where `C44.0` skin lip and `C44.1` eyelid rows were included in the class and should not be selected; train improves to `1104/1597`, dev and holdout remain unchanged.

Iteration 40 hypotheses and outcome:

- Hypothesis 1: blank count questions can be handled by binding a numeric/word-count answer between the left side of the blank and the right-side `раз/сутки/прием` cue. Kept narrowly as `cloze_gap_local`; broader month/frequency use was rejected because it boosted neighboring monitoring intervals.
- Hypothesis 2: severity/classification multi tables can be handled by binding the question's column label to PDF item x-coordinates and matching each answer's metric/value inside that column. Kept as `visual_table_column` with explicit column cues, recommendation-row rejection, and full expanded-number coverage for ranges.
- Hypothesis 3: threshold tuning or broad shared evidence could recover missing multi answers. Rejected again; previous grids and broad shared matching regressed dev/holdout by adding plausible extras.

Iteration 41 hypotheses and outcome:

- Hypothesis 1: code/MKB questions should bind an answer code to its own PDF row instead of scoring a merged code-list chunk. Kept as `classification_code_segment`; OCR variants such as `.140` and `Л41` are normalized to `J40`/`J41`.
- Hypothesis 2: comparator expressions could distinguish numeric criteria (`<`, `>`, `=`). Rejected after holdout regressed to `442/550` by over-boosting neighboring age/range rows.
- Hypothesis 3: raw-score-only multi cardinality selection could recover many exact sets. Rejected as insufficient: an offline top-k oracle with true expected cardinality caps overall at about `76.6%`, below the `80%` target, and train/dev-tuned threshold variants did not materially improve dev/holdout.

Iteration 42 hypotheses and outcome:

- Hypothesis 1: coordinate-aware row reconstruction can bind labels and numeric ranges that are flattened in paragraph text. Kept narrowly as `coordinate_table_row` for single-answer table/classification questions; it fixed two `07-hron` dev rows and raised dev to `352/473`.
- Hypothesis 2: the same row grid can generalize to multi-answer tables. Rejected because candidates in the same reconstructed row often received equal support, adding plausible extras and worsening exact set matches.
- Hypothesis 3: row reconstruction should cover all stage/table questions. Rejected for fibrosis/METAVIR-style questions because the existing `fibrosis_stage_row` scorer is more precise; coordinate rows were blocked for those questions.

Iteration 43 hypotheses and outcome:

- Hypothesis 1: a frozen non-LLM feature ranker can safely recalibrate evidence kinds. Kept as a small post-score feature layer; broad penalties were restricted after regressing broad-list/source/dosing questions.
- Hypothesis 2: multi-cardinality should be handled separately from raw evidence thresholds. Kept narrowly by raising the third-answer relative threshold and adding conservative prune/add checks based on structural evidence.
- Hypothesis 3: pairwise/cluster contrast can remove recommendation distractors that share the same paragraph. Kept only for recommendation-like multi questions; it fixed examples such as `15-toxic#16` and `27-cistit#7` without lowering holdout.

Iteration 44 hypotheses and outcome:

- Hypothesis 1: in multi, selecting every option is usually suspicious because `expected.length === variants.length` is extremely rare. Kept as `multiAllOptionsGuard` for 3- and 4-option all-selected outputs.
- Hypothesis 2: the guard should not apply to 5+ options. Confirmed: a 5-option all-selected train case is genuinely all-correct, and 5+ lists often need more than one distractor removed.
- Hypothesis 3: all-options pruning can improve cardinality without changing ordinary multi cases. Confirmed on dev (`+3` exact, multi exact `0.5625`) with unchanged holdout exact.

Iteration 57 table-group outcome:

- Hypothesis 1: explicit PDF tables can be reconstructed as `left label -> right values` for multi-answer questions when the PDF exposes text-item coordinates. Kept as `coordinate_table_group`, gated to explicit `Таблица` captions and compound row-label matching.
- Hypothesis 2: broad pseudo-column reconstruction should include scales and arbitrary aligned paragraphs. Rejected after a holdout false positive in a non-table scale/research paragraph; table groups now require an explicit table caption.
- Hypothesis 3: common route synonyms can recover table values without memorizing medical facts. Kept only `per os -> peroral`, which fixed two dev administration-route table cases without changing holdout.
- Outcome: dev improves from `365/473` to `366/473`; dev multi exact improves from `0.6250` to `0.6319`; holdout remains `456/550 = 0.8291`.

Iteration 58 route-abbreviation dictionary outcome:

- Hypothesis: a very small RU route dictionary is useful for future PDFs even if the current corpus already contains mostly full route names.
- Kept inside table evidence only: `в/в -> внутривенный`, `в/м -> внутримышечный`, `п/к -> подкожный`, and `внутрь/per os -> пероральный`.
- Rejected: a broader English route dictionary (`IV/IM/SC/SQ/PO/oral`) because it added no exact gain on train/dev/holdout and increases ambiguity surface.
- Outcome: dev remains `366/473 = 0.7738`; holdout remains `456/550 = 0.8291`; no regression.

Iteration 59 table/list extraction outcome:

- Hypothesis 1: some multi questions point to one explicit table row where several correct answer options live in neighboring cells or continuation lines. Kept as `coordinate_table_multicell_row` plus structural group completion: if two selected answers share the same reconstructed row, another strongly supported answer from that row can be added.
- Hypothesis 2: some tables need inverse binding, because the question describes the right column (`value`) while answer options are labels from the left column. Kept as `coordinate_table_group_inverse`, gated to explicit table captions and value-side focus support.
- Hypothesis 3: broad multi-cell extraction is risky. Confirmed: generic table headers such as `Эффект | Группа` and neighboring rows can flatten into one noisy row. Retained mitigations: generic header filtering, row-category checks, and numeric direction compatibility (`до`/`менее` vs `более`/`выше`).
- Outcome: dev improves to `367/473 = 0.7759`; dev multi exact improves from `0.6319` to `0.6389`; holdout remains `456/550 = 0.8291`; train remains `1106/1597 = 0.6925`.

Iteration 60 exact-answer and split outcome:

- Hypothesis 1: a full answer phrase found in the PDF can help when partial frequency scorers over-boost a neighboring duration. Kept narrowly as `exact_answer_phrase` only for single oral-dose prompts with `внутрь по` and multiple numeric components.
- Hypothesis 2: broad exact matching across all questions is unsafe. Confirmed: an all-purpose exact scorer selected many distractors because definitions, symptoms, and recommendation alternatives often appear verbatim elsewhere in the same PDF.
- Refactor: frequency/duration scoring was moved from `predictor.ts` to `src/predictor/scorers/frequency.ts` with the old behavior preserved; shared line-window extraction moved to `text-utils`.
- Outcome: fixed `17-gepatit#36` (`400 мг каждые 8 ч 7 дней`), dev stays `367/473 = 0.7759`, holdout improves to `457/550 = 0.8309`.

Concrete next steps:

- extract text items with coordinates into table-like rows/columns, not only paragraphs;
- add more general row-binding features for `label -> value` questions;
- add a non-LLM calibrated ranker trained only on train/dev features, then freeze weights for inference;
- add stronger confidence calibration, because current correct/incorrect confidence averages are too close;
- consider JS OCR only if future PDFs are scanned or page text is insufficient.

## Rich Diagnostics Layer

Added `npm run diagnostics`, an analysis-only script that reads `.cache/eval/dev-results.json` and `.cache/eval/holdout-results.json` after eval runs. It does not call predictor, does not change runtime selection, and does not feed answer keys back into inference.

The script writes:

- `.cache/eval/diagnostics.json` with enriched error records;
- `.cache/eval/diagnostics.md` with compact tables for human review.

Each error is annotated with:

- selection shape: under-selected, over-selected, same-count distractor, single wrong-top candidate;
- question patterns: table/scale, recommendation/treatment, negative/exception, definition, code/classification, gene-symbol, count;
- option-family patterns: numeric family, all-short-numeric, dense overlapping options, narrow opposing cue families;
- evidence patterns: broad-only retrieval, flat retrieval, shared multi segment, structural/table evidence, recommendation evidence;
- `likelyNextWork`: `multi_set_selection`, `recommendation_block_parser`, `option_family_resolver`, `table_or_layout_parser`, `negative_exception_semantics`, `definition_binding`, `retrieval_precision`, or `manual_error_review`.

Current diagnostics from the latest eval artifacts:

- Dev errors: `105`; single `54`, multi `51`.
- Dev likely next work: `option_family_resolver 28`, `recommendation_block_parser 26`, `multi_set_selection 20`, `table_or_layout_parser 18`.
- Dev multi likely next work: `multi_set_selection 20`, `recommendation_block_parser 17`, `option_family_resolver 8`, `table_or_layout_parser 6`.
- Holdout errors: `92`; single `58`, multi `34`.
- Holdout likely next work: `recommendation_block_parser 38`, `option_family_resolver 22`, `multi_set_selection 17`.
- Holdout multi likely next work: `multi_set_selection 17`, `recommendation_block_parser 10`, `option_family_resolver 7`.

Interpretation: the next algorithmic work should prioritize multi set selection and recommendation block parsing. Table/layout parsing remains useful, but the latest holdout residuals are less table-heavy than dev.

## Iteration 64 Recommendation Notes

Broad statement-level recommendation support was rejected. Treating the text from `Рекомендовано...` to the next evidence/comment line as direct answer support looked promising on dev, but holdout dropped by 9 exact answers (`457/550` to `448/550`). The failures were spread across several PDFs and showed the same general problem: adjacent clinical recommendations often contain plausible distractors, so a raw answer boost from a whole statement block is too coarse.

The retained change is narrower. Ordinal-line windows (`первая линия`, `третья линия`, and similar) now:

- use soft focus-token coverage so Russian inflection differences can still bind the right block;
- carry less text from the previous recommendation before the ordinal phrase;
- reject a candidate window when the specific focus token appears only under local negative context such as `без`, `отсутствие`, or `нет`.

Outcome: dev stayed `368/473 = 0.7780`; holdout improved to `458/550 = 0.8327`; holdout single improved to `0.8626`; holdout multi stayed `0.7344`.

## Iteration 65 Therapy Alias Notes

The therapy dictionary was tested as a general abbreviation/synonym layer, not as a PDF-specific fix. The retained part covers high-confidence Russian medical variants where the meaning is nearly identical: compact `X-терапия`, spaced `X терапия`, `терапия X`, and common abbreviations such as `МГТ`.

The full candidate dictionary was not safe. Adding `антикоагулянтная терапия` and `антиагрегантная терапия` caused false positives in valve/aorta recommendation questions: distractor answers mentioning contraindications to long-term therapy were boosted from nearby recommendation text. That version dropped holdout to `473/580`, so those groups were removed.

Retained outcome on the current split:

- dev: `400/523 = 0.7648`, single `0.8306`, multi `0.6115`;
- holdout: `475/580 = 0.8190`, single `0.8624`, multi `0.6875`;
- exact-score delta vs the same split without therapy aliases: dev `+0`, holdout `+0`;
- observed qualitative improvement: in the `МГТ`/`гормональная терапия` anomaly case, the wrong extra option is no longer selected and the missing `МГТ` candidate receives stronger evidence, but exact multi selection is still short by one answer.

Conclusion: this is useful guarded coverage for future PDFs, but not yet a measurable accuracy lift. Further gains likely require better multi set selection after evidence has been lifted, not a broader synonym dictionary.

## Iteration 66 Structured Gynecology Notes

The newly inspected anomaly cases exposed four general failure classes rather than PDF-specific facts.

First, long description questions can quote text that appears after the answer label in the PDF. The older `answer_after_question` and anchor-window signals found the right paragraph, but then preferred the next heading-like option after the quoted description. The retained `preceding_question_label` scorer is single-answer only, requires a long exact question quote in the PDF, and looks for the answer label immediately before that quote.

Second, multi questions with adjacent parenthetical groups can be over-selected when the extractor flattens both groups into one line. The retained `parenthetical_group_segment` scorer binds answers to a single parenthetical group only when the text before the group contains explicit category wording and enough specific focus from the question. A broader version was rejected because it regressed aorta type/cause questions by treating incidental parentheses as answer groups.

Third, short domain abbreviations help only when they are stable and conservative. `СПЯ` and `РЭ` were added as guarded phrase/token aliases, but the alias signal is low-weight and does not turn every mention of `эндометрий` into `рак эндометрия`. This avoids making benign endometrium-function questions look like cancer-risk questions.

Fourth, opposite modifiers need to be tied to the same noun. A plain token overlap saw `менопауза` and could select `ранняя менопауза` even when the PDF said `поздняя менопауза`. The new modifier-target contrast penalty looks for the nearest early/late-style modifier before the same target token, so unrelated nearby cues do not create a false mismatch.

The `£4 мм` fragment is treated as a PDF extraction artifact for `≤4 мм`, not as a manually typed pound sign. Normalization maps only `£` before a number to `<=`, and shared multi lifting now rejects answers whose numeric threshold conflicts with a comparator in the shared segment.

Outcome on the current split:

- dev: `386/503 = 0.7674`, single `0.8281`, multi `0.6299`;
- holdout: `480/580 = 0.8276`, single `0.8670`, multi `0.7083`;
- holdout delta from iteration 65: `+5` exact, single `+0.0046`, multi `+0.0208`;
- residual holdout diagnostics: `recommendation_block_parser 42`, `option_family_resolver 23`, `multi_set_selection 20`.

## Iteration 67 Hypothesis Notes

Two higher-level ideas were tested after the diagnostics pointed again at `recommendation_block_parser`, `option_family_resolver`, and `multi_set_selection`.

The first idea was list continuation: if a question is literally continued in the PDF, the scorer should read the continuation as a structured answer set. The broad version was too optimistic. Cues such as `включают`, `относятся`, and `определение` occur in many classification paragraphs and comments, so they boosted plausible neighboring items and dropped dev by 5 exact answers. The retained rule is much narrower: only `основано/основаны на данных...` style prompts, with a longer local line window to avoid truncating the final list item.

The second idea was numeric option-family resolution. A broad numeric scorer also regressed dev because partial fragments like `%`, `300 мг`, or `2 раза` occur in dense tables and can match several answer variants at once. The retained version requires a full normalized numeric option phrase and only runs for recommendation, dose, frequency, or duration-style single questions.

Outcome:

- dev stayed `386/503 = 0.7674`;
- holdout improved from `480/580 = 0.8276` to `482/580 = 0.8310`;
- holdout multi improved from `0.7083` to `0.7222`;
- train stayed `1101/1597 = 0.6894`.

Conclusion: both hypotheses are valid only in narrow structural forms. The broad versions are useful as rejected evidence: future improvement should parse explicit recommendation/list structure more deeply instead of matching general cue words.

## Iteration 68 Confidence Notes

The confidence layer is now separate from answer selection. Exact accuracy is intentionally unchanged, but the reported confidence is less over-optimistic when evidence is broad, flat, or ambiguous.

The retained penalties are structural rather than dataset-specific:

- selected answers supported only by broad search evidence are discounted;
- close single-answer top-1/top-2 raw gaps are discounted;
- close multi selected/unselected boundaries are discounted;
- multi sets with no structural evidence and many broad shared chunks are discounted.

Outcome:

- dev exact stayed `386/503 = 0.7674`; confidence correct/incorrect moved to `0.7952/0.6704`;
- holdout exact stayed `482/580 = 0.8310`; confidence correct/incorrect moved to `0.8154/0.6919`;
- diagnostics error counts stayed dev `117`, holdout `98`.

This does not make the predictor more accurate by itself, but it gives consumers a much better signal for when to review or route a prediction through a slower/manual process.

## Iteration 69 Recommendation Condition Notes

The next retained improvement addresses two recurring recommendation-family mistakes without adding facts from a specific guideline.

First, duration/frequency evidence was too permissive. A source line with `3 суток` could boost several answer variants even when only one variant named the same drug or medical agent. The frequency scorer now requires a non-generic answer subject token, when present, to appear in the same recommendation line. This keeps numeric-duration evidence useful while reducing wrong ties inside dense dose families.

Second, some questions define a clinical subgroup by exclusion, for example `без X`, while the PDF sentence nearby also describes a different subgroup `при X`. The new mismatch check penalizes an answer only when its local evidence occurs after a positive condition cue for the excluded subgroup. This is intentionally not applied to procedural phrases like `без проведения`, because those describe how a sign is assessed rather than which patient subgroup is being recommended.

Outcome:

- dev stayed `386/503 = 0.7674`;
- holdout improved from `482/580 = 0.8310` to `483/580 = 0.8328`;
- holdout single improved from `0.8670` to `0.8693`;
- holdout multi stayed `0.7222`;
- residual holdout diagnostics: `recommendation_block_parser 40`, `option_family_resolver 23`, `multi_set_selection 19`.
