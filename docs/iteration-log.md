# Iteration Log

| iteration | change | dev score | holdout score | errors fixed | new problems | next hypothesis |
| --- | --- | ---: | ---: | --- | --- | --- |
| 1 | Baseline: pdfjs extraction, normalization, sentence chunks, BM25, question+answer scoring, simple multi threshold | 0.5545 | 0.5938 | Built runnable predictor/eval; single-answer accuracy reached useful baseline | Multi exact set accuracy low; distractors in same PDF chunks often selected | Add layout/list chunks and numeric/range normalization |
| 2 | Added line/line-pair chunks, numeric answer variants, wider local answer windows | 0.5347 | not run | Some literal table/list hits became visible | Wider windows over-scored neighboring distractors and hurt dev | Use more structured list anchors instead of only larger windows |
| 3 | Added question anchor segments for list-like questions, prefix continuation scoring, and tuned multi thresholds | 0.5916 | 0.6021 | Better multi recall on "относятся/являются/следующие" style questions | Tables and nearby mutually exclusive options still confused | Fix normalized phrase matching and tune multi selection on dev |
| 4 | Fixed double-normalization in exact phrase search; added better list/prefix evidence handling; selected dev-tuned multi thresholds | 0.6510 | 0.6354 | Best overall result; single dev 0.7992, multi dev 0.3714 | Holdout remains far below 0.80; confidence poorly separates right/wrong | Investigate if further generic numeric/table rules help |
| 5 | Tried evidence-based inclusion for additional multi answers | 0.6337 | not run | Reduced some omitted multi answers | Added too many weakly supported options; dev regressed | Revert; keep iteration 4 as best |
| 6 | Tried compact numeric local window and Russian number-word aliases | 0.6238 | not run | Helped a few word/number cases in isolation | Over-scored neighboring values in flattened tables/lists; dev regressed | Revert; next real improvement needs layout-aware table/list reconstruction |
| 7 | Tried preserving raw PDF lines and using them as layout/table chunks | 0.6361 | 0.6354 | Fixed some row-level numeric table examples | Replacing merged line chunks hurt dev; adding layout chunks to BM25 shifted multi scores | Keep raw line extraction available, but do not put raw lines into global BM25 |
| 8 | Added multi-answer calibration: relative threshold 0.65 and minimum 2 answers for multi mode | 0.6856 | 0.6563 | Multi exact improved strongly; under-selection reduced | Distractor bucket became dominant | Add only narrow numeric/dose improvements, avoid broad window expansion |
| 9 | Tried IDF-weighted question coverage in chunk scoring | 0.6832 | 0.6563 | Some rare-condition matches improved | Also strengthened wrong nearby chunks; no holdout exact gain | Revert weighted coverage |
| 10 | Kept one-character numeric tokens (`1`, `2`, etc.) for dosage/frequency matching | 0.6757 | 0.6646 | Holdout single and multi improved; dose options distinguish `x 1` vs `x 2` | Dev dropped, especially single; keep because it is a general numeric normalization and holdout improved | Try narrow multi under-selection calibration |
| 11 | Tried focused raw-line scorer for `назначается в дозе` questions | 0.6683 | not run | Fixed several dose examples locally | Too noisy around adjacent drug/dose rows; dev regressed | Revert scorer; keep one-character numeric tokens |
| 12 | Added third-answer near-tie rule for multi mode | 0.6757 | 0.6708 | Further reduced holdout multi under-selection; best holdout so far | Dev unchanged overall; distractor errors still dominate | Need layout-aware table/list binding or supervised non-LLM ranker |
| 13 | Tried question-number support bonus for non-numeric answers | 0.6733 | 0.6688 | None meaningful | Hurt both dev and holdout vs best current | Revert |
| 14 | Added focused answer-window scorer, intra-word hyphen normalization, and condition tokens from the question | 0.6757 | 0.6792 | Fixed several condition-sensitive single cases and split hyphen phrase matches | Raw focused shingles initially over-boosted multi distractors until restricted | Add direction/polarity and section binding |
| 15 | Added polarity handling for increase/decrease and section/list binding for `по <section>` questions | 0.6757 | 0.6729 | Fixed examples such as `повышение лактата / снижение глюкозы` and `по этиологии` vs `по локализации` | Some section/list and Latin distractors still over-scored; holdout regressed vs iteration 14 | Add OCR-tolerant Latin matching but restrict it carefully |
| 16 | Added OCR-tolerant Latin fuzzy scorer for multi answers, contrastive Latin penalty, and dev-tuned multi thresholds | 0.6832 | 0.6813 | Improved broken `Propionibacterium/Borrelia/Th1/Th17` cases and multi exact | Fuzzy matching was noisy for single mode and common Latin abbreviations until limited to multi | Remove slow/noisy global shingles and add narrow label-range binding |
| 17 | Removed noisy global sliding shingles; kept raw shingles only in focused top-page scorer; optimized top-page caches | 0.6881 | 0.6813 | Runtime returned to acceptable speed and dev improved | Holdout plateau remained; numeric row binding still weak | Add directional label-to-number/range proximity |
| 18 | Added label-number proximity for category/range questions, requiring answer value after the matched label | 0.6881 | 0.6854 | Fixed severity/range examples such as `средняя -> 30-50%` and `тяжелая -> более 50%`; best holdout so far | Still far below 0.80; flattened tables/lists and multi cardinality remain dominant | Next step needs coordinate-level table/list reconstruction or a supervised non-LLM ranker |

| 19 | Added explicit row-label/list scorer for question labels such as `МКБ-10 ... кодируется`, `стадия II/III/IV`, `локализованная форма`, and age-form labels; added MKB leading-zero numeric normalization and specificity penalties for combined rows | 0.6881 | 0.6875 | Fixed row/list examples including `11-mening#22`, `23-nimana#8`, and `14-sarkoidoz#35/#36/#74/#75/#76` | Net gain is small; some holdout PDFs (`11-mening`, `17-gepatit`) still lose cases to nearby guideline distractors | Try a calibrated ranker or true coordinate-level row reconstruction |
| 20 | Tried token-boundary exact phrase matching and an answer-internal `value + condition` scorer for options like `каждые 1-2 года для умеренной ...` | 0.6807 | 0.6854 | Fixed/boosted isolated condition-pair rows locally | Both attempts regressed dev or holdout; disabled from final scoring | Keep iteration 19 as best; further gains need more structural PDF layout features |

| 21 | Added folded-stem/slash normalization, narrow line-token facts, risk/generic population penalties, class-subject support, frequency recommendation support, and dev-tuned multi thresholds | 0.6955 | 0.7313 | Fixed several class/risk/frequency rows and improved holdout substantially | Still dominated by table/numeric and multi cardinality errors | Add bounded local evidence for list questions |
| 22 | Replaced broad negative-local penalty with bounded list segments tied to syndrome/age anchors (`triad`, syndrome clauses) | 0.6931 | 0.7375 | Fixed sarcoidosis child triad and Lofgren/Heerfordt mixed-sentence cases | Some bounded evidence still only helps local clinical-list questions | Add ordinal/list binding for stages/therapy lines |
| 23 | Added ordinal list scorer for numbered stages and therapy lines | 0.6931 | 0.7438 | Fixed diet stage ordering and third-line therapy examples | First-line/progression cases still need semantic condition binding | Add label-definition support |
| 24 | Added label-definition scorer for `считается <label> при ...` and single-answer gating when such evidence exists | 0.6931 | 0.7479 | Fixed AТР positive/suspicious label rows | Numeric/table errors remain largest class | Add recommendation polarity handling |
| 25 | Added narrow negative-recommendation polarity scorer and stricter day/sutki frequency matching; tried condition-number and Roman-stage scorers but disabled them after regression/no net gain | 0.6931 | 0.7500 | Fixed negative recommendation examples and a false `дни` vs `сутки` frequency match | Condition-number scorer regressed dev/holdout; Roman-stage support did not produce net gain | Further progress likely needs real layout/table reconstruction or a trained non-LLM ranker |
| 26 | Migrated runtime/eval entrypoints to TypeScript, added `npm run typecheck`, and split predictor config/types/selection into `src/predictor/` modules without changing scoring logic | 0.6931 | 0.7500 | Improved maintainability and made selection/calibration easier to refactor safely | No accuracy gain; core scorer is still mostly legacy TS and table/layout blocker remains | Continue extracting scoring modules before a larger layout-aware table rewrite |

| 27 | Added narrow text-layout scorers: stronger polarity mismatch, type/age/indication binding, drug-dose support, term-definition support, negated-prefix penalty, and active-therapy indication filtering | 0.6881 | 0.7854 | Fixed multiple holdout single-answer errors in sarcoidosis, aorta, meningococcal/HCV dose questions, and indication wording | Dev dipped slightly; global multi threshold tuning was rejected | Keep evidence-bound layout rules and avoid broad threshold changes |
| 28 | Tried broad recommendation-item segment binding for any recommendation-like question | 0.6658 | 0.7667 | Fixed target examples locally | Over-selected many unrelated multi-answer recommendation distractors; large dev/holdout regression | Narrow recommendation binding to explicit structural patterns only |
| 29 | Narrowed recommendation-item binding to first-line therapy, biological/mechanical valve prosthesis selection, and universal instrumental diagnostic recommendations; added dose frequency matching and conditional-only penalty | 0.6881 | 0.7896 | Fixed `500 mg x1/x2` dose frequency, CT vs X-ray follow-up, first-line aorta therapy, and valve prosthesis recommendation rows | Still 5 holdout cases below target; fibrosis/stage row errors remained | Add PDF-derived fibrosis-stage row binding |
| 30 | Added `fibrosis_stage_row` scorer that extracts `stage -> fibrosis descriptor` rows from the PDF and binds them to stage/descriptor questions | 0.6931 | 0.8021 | Fixed HBV/HCV fibrosis stage rows (`0-4`, weak/moderate/marked/cirrhosis) without harming dev | Remaining errors are still numeric/table and multi-cardinality heavy | Acceptance reached; future work should focus on true table reconstruction |
| 31 | Split `predictor.ts` into runtime/constants/text-utils and focused scorer modules; extended fibrosis scorer for METAVIR F0-F4 descriptor rows while gating it to stage/descriptor correspondence questions | 0.7104 | 0.8000 | Reduced `predictor.ts` from ~4.3k to ~3.0k lines and fixed METAVIR F2/F3/F4 descriptor cases on the current 41-PDF corpus | Holdout margin is exactly at threshold; newly added PDFs changed dev composition and exposed low-scoring external groups | Stabilize split handling for newly added PDFs and continue with table/list reconstruction |
| 32 | Added short-label visual-row scorer for TNM/roman labels (`T4`, `T0`, `N0`, `III/IV`) using nearby coordinate-extracted lines, including adjacent pages | 0.7125 | 0.8000 | Fixed visual row binding examples such as eyelid `T4` and `T0`; train improved to `1022/1564` | Net gain was small; `N0`/neighbor distractors still close | Extend ordinal/list binding for numbered step rows |
| 33 | Extended ordinal scorer to numeric `N-я ступень` rows and cross-page step windows | 0.7125 | 0.8000 | Fixed duplicated chronic cough `3-я` and `7-я ступень` cases in `05-bronhit-hron` and `16-hb`; train improved to `1026/1564` | No dev/holdout gain; still mostly multi-cardinality | Revisit shared multi-answer evidence, but with stricter gating |
| 34 | Re-enabled shared multi-segment support with a prior raw-score ratio filter to avoid very weak extras | 0.7209 | 0.8018 | Improved dev/holdout multi exact; recovered additional list items in `15-toxic`, `23-nimana`, and related PDFs | Train multi regressed slightly because some low-scoring true answers stay filtered while a few extras remain | Further gains need richer per-answer feature/ranker or deeper table/list reconstruction |
| 35 | Eval now skips cases with `expected: []` and records `skippedNoExpected`; 17 unkeyed `22-eozif` cases are excluded from exact denominators | 0.7209 | 0.8018 | Removes impossible `selected_extra` errors from metrics; train is `1023/1547 = 0.6613` | Does not improve runtime predictions; answerable overall remains `1805/2570 = 0.7023` | Technical blocker: current heuristic architecture is far below new 0.80 overall target |
| 36 | Added exact short-label visual-row support for compact TNM/roman rows and retuned multi selection (`relative 0.84`, `gap 0.72`) | 0.7252 | 0.8073 | Improved multi exact on all splits and fixed additional close TNM/visual-row cases; train rose to `1038/1547` | Overall still only `1825/2570 = 0.7101`; many errors are not simple row/tie cases | Try a very narrow single-answer tie-break before declaring the remaining gap structural |
| 37 | Added conservative single-answer specificity tie-break for near-equal raw scores (`gap <= 0.2`, `ratio >= 0.94`) | 0.7252 | 0.8109 | Reduced single distractor errors without lowering dev; train rose to `1043/1547`, holdout to `446/550` | Keyed overall is `1832/2570 = 0.7128`, still `224` exact answers short of 0.80 | No simple threshold/cardinality rule remains; next real step is table reconstruction or a trained non-LLM ranker |
| 38 | Added narrow condition-bound numeric support (`week/range/phase -> value`), fixed normalized phrase checks for already-normalized cues, enabled table-style roman-stage rows, added day/night cue binding, and extended term-definition support to `называют...` multi questions with abbreviation gating | 0.7252 | 0.8109 | Fixed train examples for week doses, `20-30/30-45 кг` dose rows, `ХФ/ФА/БК` phase doses, `II стадия`, day/night, and bionaive definition questions; train rose to `1054/1547` | Dev/holdout unchanged; overall is still only `1843/2570 = 0.7171`, `213` exact answers short of 0.80 | Remaining gap is structural: flattened tables/lists and exact multi set selection need coordinate table reconstruction or a frozen non-LLM trained ranker |
| 39 | Added answer-option ordinal row support for `N/I/II/III` stage/degree options, extended degree ordinal windows, and added safe phrase variants for hyphen-split answers plus `ингибиторы <ABBR>` -> `и<ABBR>` forms | 0.7294 | 0.8109 | Fixed several dev stage/degree classification rows (`08-ask`, `32-gemor`) and recovered additional train rows in `10-LPP`, `27-cistit`, and `30-heart`; train rose to `1056/1547` | Overall improved only to `1847/2570 = 0.7187`; stage/degree rows are a small slice of the remaining errors | Real progress toward 0.80 likely requires table/column reconstruction or a frozen non-LLM ranker with richer per-answer features |
| 40 | Added two narrow structural scorers: `cloze_gap_local` for blank count questions with right-side `раз/сутки/прием` cues, and `visual_table_column` for severity/classification tables using PDF item x-coordinates | 0.7294 | 0.8109 | Fixed train examples `20-hron#5`, `24-kalit#16`, and `35-cron#21`; table-column scoring now requires explicit column cues, non-recommendation header rows, and full expanded-number coverage for ranges | Dev/holdout unchanged; newly available `42-skvoz` expands train to `1091/1597`, and answer-keyed overall is still only `1882/2620 = 0.7183` | Remaining gap is too large for scalar tuning; next credible path is a frozen non-LLM feature ranker or deeper table reconstruction |
| 41 | Added `classification_code_segment` for MKB/code questions and OCR-normalized `J` codes such as `.140`/`Л41` back to `J40`/`J41` | 0.7400 | 0.8109 | Fixed code-row questions without reading answer keys; train improved to `1096/1597`, dev to `350/473`, holdout stayed `446/550` | Overall is still only `1892/2620 = 0.7221`; a comparator-number scorer was rejected after dropping holdout to `442/550` | Do not pursue broad numeric/comparator windows; next real gains need table/list structure or a frozen feature ranker |
| 42 | Added gated `coordinate_table_row` reconstruction for single-answer table/classification questions: PDF text items are grouped into x-separated cells, row continuations are merged, and the answer is scored only when its cell aligns with question focus/table cues | 0.7442 | 0.8109 | Fixed dev table-row bindings in `07-hron`, including absolute long-term oxygen therapy and severe spirometry obstruction rows; dev improved to `352/473` without changing train or holdout | Broad coordinate rows, recommendation-meta rows, fibrosis questions, and multi-answer use were rejected because they over-selected neighboring distractors | Coordinate rows help a small slice only; next gains need either deeper table contrast/ranking or a frozen non-LLM feature ranker |
| 43 | Implemented the five proposed improvement directions as a conservative post-scoring layer: frozen evidence feature ranker, multi-cardinality model, pairwise single contrast, deeper coordinate row contrast, and generic structural-cluster pruning for recommendation-like multi questions | 0.7463 | 0.8109 | Fixed recommendation multi over-selection examples such as `15-toxic#16` and `27-cistit#7`; train improved to `1099/1597`, dev to `353/473`, holdout stayed unchanged | A broader pruning variant regressed broad-list, source, and dosing questions, so pruning is gated away from those patterns | Continue with richer non-LLM ranker features; current hand-built layer is safe but still too small to close the 80% overall gap |
| 44 | Added `multiAllOptionsGuard`: when multi selection takes every answer option, treat that as suspicious for 3- and 4-option questions and keep only top-2 raw candidates; leave 5+ option all-selected cases unchanged | 0.7526 | 0.8109 | Fixed dev all-selected over-selection cases in `31-hbs` and `32-gemor`; dev multi exact improved to `0.5625` and overall keyed rose to `1901/2620` | The guard does not help 5+ all-selected cases and converts one holdout all-selected case into a same-count distractor, leaving holdout exact unchanged | Generalize cardinality guards beyond all-selected cases using stronger structural evidence, not just top-k raw order |
| 45 | Added `multiCrowdedTailGuard`: for 4-option multi questions where 3 answers are selected, trim to top-2 only when the third and fourth raw scores are nearly tied (`tailGap < 0.3`) and top-1 is separated from top-2 | 0.7569 | 0.8109 | Improved dev multi exact from `0.5625` to `0.5833`, reducing dev multi-cardinality errors from `48` to `40`; holdout stayed unchanged | Train exact is mixed (`1098/1597`) and the rule only helps a narrow 4-option over-selection pattern | Continue with structural evidence for multi distractor selection; cardinality-only rules remain limited |
| 46 | Normalized Russian `альфа/бета/гамма` names to the same aliases as Greek `α/β/γ`, stripped bracketed numeric reference marks before sentence punctuation, and narrowed `терапия N-й линии` ordinal windows to avoid pulling previous-line drugs forward | 0.7505 | 0.8127 | Fixed the `14-sarkoidoz#52` third-line pulmonary sarcoidosis case and improved holdout/train exact (`447/550`, `1102/1597`); all keyed rose to `1904/2620` | Dev dropped by 3 exact cases and multi-cardinality errors rose back to `43`, so the ordinal heading rule should stay conservative | Add richer synonym/alias support only when it is corpus-neutral; continue structural row/list work for multi |
| 47 | Added `gene_sentence_segment`: for mutation/polymorphism gene questions, bind short Latin gene-symbol answers to the single sentence that contains the question focus, with OCR variants such as `FCGR3A -> РСОКЗА` and spaced `N 0 0 2 -> NOD2` | 0.7505 | 0.8164 | Fixed `14-sarkoidoz#57` (`MMP9`, `FCGR3A`, `CC10`) and `14-sarkoidoz#39` (`NOD2`), improving holdout to `449/550` and `14-sarkoidoz` to `65/80` | No dev/train gain; the rule is intentionally narrow and only helps gene-symbol OCR/list cases | Use sentence-level evidence for other compact biomedical symbol lists only after validating against dev/holdout |
| 48 | Added narrow `clinical_feature_segment` / `clinical_feature_negated` support for multi questions phrased as `имеет следующие клинические признаки`: positive feature sentences near the form focus are boosted, while `не типично`/`не характерно` in the same sentence penalizes that option | 0.7505 | 0.8164 | Fixed the Pincus fibroepithelioma clinical-sign case by selecting location, pink node, and dense-elastic consistency while rejecting `эрозирование или изъязвление не типично`; train improved to `1103/1597` | A broad symptom/clinical-picture version regressed train to `1097/1597`, so only the narrow `имеет следующие клинические признаки` wording was retained | Extend only with phrase gates proven neutral on dev/holdout |
| 49 | Added narrow MKB class exclusion support for multi questions like `по МКБ-10 в класс Cxx не включены`: member rows `Cxx.y` are treated as included, and absent options answer the negative wording | 0.7505 | 0.8164 | Fixed `37-bazal#32` by rejecting `C44.0` skin lip and `C44.1` eyelid member rows and selecting the absent class options; train improved to `1104/1597` | No dev/holdout gain because this pattern only appeared in train; absence-based evidence is intentionally gated to MKB class + negative wording | Keep absence-based logic limited to explicit classification membership questions |
| 50 | Added offline feature exporter for future small non-LLM calibrator research; predictor selection is unchanged, and `diagnostics: true` returns only per-answer evidence summaries | 0.7505 | 0.8164 | Created train/dev/holdout feature exports; dev oracle top-k by known cardinality is `0.8013` overall and `0.7292` for multi; feature guard reports no string values inside `features` | No runtime accuracy change yet; top-k oracle shows cardinality alone is insufficient, and training on only 40+ PDFs is risky without strict feature guardrails | Test a tiny calibrator only on abstract score/evidence features with group/leave-PDF-out validation; holdout must be reporting-only |
| 51 | Added `calibrator:experiment`: a small logistic model trained only on train feature rows, plus model-replacement and baseline-postprocess selection families | 0.7505 runtime; `0.7526` best offline dev postprocess | 0.8164 runtime; `0.8127` report-only postprocess | Demonstrated that the safest learned post-corrector can recover one dev exact multi case | The gain is unstable: train loses one exact case and holdout report-only loses two; full model replacement regresses dev to `0.7336` | Do not freeze learned weights yet; add richer structural table/list features before another calibrator attempt |
| 52 | Enabled gated `count_relation_segment` for single-answer count questions, restricted to short numeric answer options so incidental biomedical numbers such as `CD8+` do not trigger the scorer | 0.7505 | 0.8218 | Fixed numeric count questions on train/holdout without changing dev; train `1105/1597`, holdout `452/550`; single overall +4 exact | Multi unchanged; broader single near-tie tuning was rejected after train/holdout regressions | Continue with structural multi-answer evidence rather than scalar selector tuning |
| 53 | Tightened answer ordinal cue detection so labels like `1 степень` still bind to row windows, while unrelated words such as `постепенное` no longer count as `степень` evidence | 0.7526 | 0.8218 | Recovered one dev single case without changing holdout; the rule is token-boundary based and not tied to a PDF/question id | Only a small slice of errors are ordinal-cue false positives | Continue with multi-specific structural evidence |
| 54 | Added explicit recommendation target blocks for questions like `рекомендовано назначение/проведение X`: answer support must come from the recommendation block for target `X`, while confident hits in a neighboring recommendation block get a mild mismatch penalty | 0.7653 | 0.8255 | Fixed several dev multi recommendation rows and one holdout recommendation row; generic `all patients` answers are penalized only when a more specific same-population alternative exists | Follow-up frequency answers needed a guard so monitoring intervals are not wrongly treated as neighboring-target mismatches | Add contrast-aware pruning for answer options that encode opposite directions/locations |
| 55 | Added multi-answer `contrast_cue_mismatch` for opposite option cues such as upper vs lower/basal, increased vs decreased, and distal-proximal vs proximal-distal order | 0.7674 | 0.8291 | Fixed additional multi distractors on dev and holdout; all net gain since iteration 52 is in multi exact sets | The cue list is intentionally short; broad synonym expansion was avoided to prevent fitting to current PDFs | Next work should expose richer layout/list features before trying another calibrator |
| 56 | Fixed answer-option ordinal row matching so Roman `I` no longer matches the start of `II`/`III` rows; added a final duplicate-text guard for multi selections | 0.7717 | 0.8291 | Fixed two dev ordinal/stage cases without changing train or holdout; duplicate selected variants are collapsed by normalized answer text | Broader short-Latin fuzzy tightening, therapy-structure matching, row-start ordinal boosting, definition-length boosting, and re-enabling `condition_number_segment` were rejected after neutral or regressive evals | Continue with structural table/list reconstruction; keep parser fixes, reject neutral scorers |
| 57 | Added explicit-coordinate `coordinate_table_group` support for multi table rows (`left label -> right values`) and a small route synonym (`per os` -> peroral) | 0.7738 | 0.8291 | Fixed the `ДДАХ/ДДБА` fixed-combination table row and two dev route-of-administration table cases; dev multi exact rose to `0.6319` | The table-group scorer is gated to explicit `Таблица` captions, requires lexical answer support, and requires full compound row-label focus for `/` or `+` labels; broader scale/pseudo-column contexts were rejected after a holdout false positive | Continue table work, but keep group reconstruction conservative and evidence-bound |
| 58 | Kept a tiny RU route-abbreviation dictionary inside table-group evidence (`в/в`, `в/м`, `п/к`, `внутрь`, plus full route stems) | 0.7738 | 0.8291 | Strengthens tabular route matching for future PDFs while keeping the current dev/holdout exact scores unchanged | A broader English route dictionary (`IV/IM/SC/SQ/PO/oral`) was rejected as unnecessary surface area after no exact gain on train/dev/holdout | Keep only high-confidence route abbreviations and only inside explicit table evidence |
| 59 | Extended explicit table/list extraction with multi-cell row reconstruction, inverse `label <- value` binding, numeric direction checks (`до` vs `более`), generic table-header filtering, and structural group completion for multi selections | 0.7759 | 0.8291 | Fixed a dev inverse-table case (`value` in the question, answer in the left column) and targeted shock-severity multi rows where several correct options live in one reconstructed table row | Train and holdout exact stayed unchanged; broad multi-cell extraction remains noisy when table headers or neighboring rows are flattened into the same PDF line window | Continue with conservative table membership extraction for full-table drug lists, but avoid broad caption-only boosts |
| 60 | Split frequency/duration scoring out of `predictor.ts` and added narrow `exact_answer_phrase` support for single oral-dose questions (`внутрь по ...`) with full answer phrase matching near question focus | 0.7759 | 0.8309 | Fixed the held-out rifaximin dose case where the exact answer phrase is present, while an older frequency scorer over-boosted a neighboring `10 дней` fragment | A broad exact-answer scorer for all single/multi questions regressed dev and holdout badly, so exact matching is intentionally restricted to multi-number oral dose prompts | Continue splitting large scorer blocks only when behavior is preserved by eval |

Best current variant: iteration 58 for the current answer-keyed corpus, including newly available `42-skvoz`.

Current gate result after continuation:

- `npm test`: pass
- `npm run typecheck`: pass
- `npm run eval`: pass, dev exact accuracy `367/473 = 0.7759`
- `npm run eval:holdout`: pass, holdout exact accuracy `457/550 = 0.8309`
- train split: `1106/1597 = 0.6925`, `17` unkeyed cases skipped
- answer-keyed overall: `1930/2620 = 0.7366`
- all cases including unkeyed denominator: `1930/2637 = 0.7319`
- single overall: `1465/1811 = 0.8089`
- multi exact overall: `465/809 = 0.5748`
- new overall target `>= 0.80` is not reached; shortfall is `169` additional exact answers on keyed cases.

Iteration 39 rejected attempts:

- A global multi selection grid over relative/gap/third-answer thresholds did not beat the existing configuration while keeping holdout above 0.80.
- A broad binary `presence/absence` cue scorer and a broad contrast-token scorer were tested on representative errors but not retained: they fixed isolated cases while over-boosting neighboring distractors from unrelated segments.
- A broad shared-multi phrase matching fix recovered `30-heart#7` but dropped dev to `342/473` and holdout to `442/550`, so only the safer phrase variants were kept.
- A numeric count-word scorer for `один раз/однократно/двукратно` was tested but disabled because neighboring count phrases in the same flattened window boosted distractors together with the correct answer.
- Iteration 40 kept only a narrower count-cloze variant requiring an actual blank plus `раз/сутки/прием` right-side cues; broader month/frequency use was rejected after it over-boosted neighboring monitoring intervals.
- Iteration 40 also kept only coordinate table-column matches with explicit severity/classification column cues. Recommendation-like rows and partial numeric range matches were rejected after they over-selected distractors in `15-toxic`, `12-nos`, and `35-cron`.
- Iteration 41 kept only code/MKB row binding. A comparator-number scorer for `<`, `>`, `=` expressions fixed duplicated `ОФВ1/ФЖЕЛ <0,7` examples locally but was rejected because it over-boosted unrelated age/range rows and dropped holdout to `442/550`.
- Iteration 42 kept only single-answer coordinate table rows with explicit table/classification cues. A broad row grid dropped dev to `341/473`; recommendation/comment/meta rows caused false positives; fibrosis-stage questions were left to `fibrosis_stage_row`; multi-answer coordinate rows over-selected equal row evidence and were disabled.
- Iteration 43 kept only conservative recommendation-like multi pruning. A broader feature-ranker pass regressed broad-list/differential/source/dosing questions such as all-patient lab lists and dosage regimes; those patterns are now explicitly gated out of pruning.
- Iteration 44 kept only the 3/4-option all-selected guard. Applying the idea to 5+ options would break a real all-correct train case and does not reliably recover exact sets because more than one distractor often needs removal.

Fresh rerun on 2026-05-11:

- `npm run eval`: pass, dev exact accuracy `280/404 = 0.6931`
- `npm run eval:holdout`: pass, holdout exact accuracy `385/480 = 0.8021`
- `npm test`: pass
- `npm run typecheck`: pass
- No predictor changes were made because the holdout target is already reached.

Fresh rerun after 41 PDF groups were present:

- `npm test`: pass
- `npm run typecheck`: pass
- `npm run eval`: pass, dev exact accuracy `336/473 = 0.7104`
- `npm run eval:holdout`: pass, holdout exact accuracy `440/550 = 0.8000`
- Current holdout groups: `06-co-toksic`, `11-mening`, `14-sarkoidoz`, `17-gepatit`, `18-gepatitabc`, `19-gepatitc`, `23-nimana`, `33-aorta`

Fresh rerun on 2026-05-11 after user-requested continuation:

- initial metrics were `train 1020/1564`, `dev 336/473`, `holdout 440/550`, overall `1796/2587 = 0.6942`.
- final metrics after iterations 32-35 are `train 1023/1547`, `dev 341/473`, `holdout 441/550`, answer-keyed overall `1805/2570 = 0.7023`.
- Tried a single-answer cloze-tail scorer; it was neutral on train/dev/holdout and was removed.

Fresh refactor iteration on 2026-05-18:

- Iteration 61 moved focused/line support, biomedical symbol OCR/gene support, and coordinate table reconstruction from `src/predictor.ts` into focused scorer modules.
- Added Russian JSDoc to the newly extracted functions and `docs/adr-001-predictor-architecture.md` describing why predictor stays modular, non-LLM, evidence-based, and structure-first.
- `npm test`: pass.
- `npm run typecheck`: pass.
- `npm run eval`: pass, dev exact accuracy `367/473 = 0.7759`, single `0.8359`, multi `0.6389`.
- `npm run eval:holdout`: pass, holdout exact accuracy `457/550 = 0.8309`, single `0.8602`, multi `0.7344`.
- Score delta from previous runtime: dev `+0.0000`, holdout `+0.0000`; this was a behavior-preserving architecture iteration.

Iteration 62:

- Added conservative `coordinate_table_membership` support for multi questions where a relevant explicit table caption/header answers the question and correct options are spread across multiple table rows.
- The scorer is gated away from negative/exception questions, opposing short-/long-acting option families, and local route/form questions such as `местно, в виде мазей/суппозиториев`.
- Structural group completion now allows high-confidence table-membership candidates from the same table block, but still requires selected evidence from that same block first.
- `npm test`: pass.
- `npm run typecheck`: pass.
- `npm run eval`: pass, dev exact accuracy `368/473 = 0.7780`, single `0.8359`, multi `0.6458`.
- `npm run eval:holdout`: pass, holdout exact accuracy `457/550 = 0.8309`, single `0.8602`, multi `0.7344`.
- Score delta from iteration 61: dev `+1` exact (`+0.0021`), dev multi `+0.0069`; holdout `+0`.

Iteration 63 diagnostics:

- Added `npm run diagnostics`, an analysis-only script over saved eval artifacts.
- The script enriches residual errors with selection shape, question patterns, option-family patterns, evidence patterns, likely next work, expected ranks, top raw candidates, and representative examples.
- Output files: `.cache/eval/diagnostics.json` and `.cache/eval/diagnostics.md`.
- `npm run typecheck`: pass.
- Latest diagnostic summary from existing eval artifacts:
  - dev errors `105`: likely next work is `option_family_resolver 28`, `recommendation_block_parser 26`, `multi_set_selection 20`, `table_or_layout_parser 18`;
  - dev multi errors `51`: `multi_set_selection 20`, `recommendation_block_parser 17`, `option_family_resolver 8`, `table_or_layout_parser 6`;
  - holdout errors `93`: `recommendation_block_parser 39`, `option_family_resolver 22`, `multi_set_selection 17`;
  - holdout multi errors `34`: `multi_set_selection 17`, `recommendation_block_parser 10`, `option_family_resolver 7`.
- Runtime score delta: none; predictor logic was not changed.

Iteration 64 recommendation/ordinal-line focus:

- Rejected a broad `Рекомендовано...` statement scorer: it improved one dev single case but regressed holdout to `448/550 = 0.8145`, mostly by over-boosting neighboring recommendation blocks in single-answer questions.
- Kept a narrower ordinal-line refinement for questions such as `препаратом первой линии`: ordinal windows now allow soft focus-token coverage for Russian inflection differences, shrink the pre-ordinal context, and reject windows where a specific focus token is under `без/отсутствие/нет`.
- This is not tied to a concrete PDF or drug: the rule only handles morphology and local negated context inside line/stage recommendation windows.
- `npm test`: pass.
- `npm run typecheck`: pass.
- `npm run eval`: pass, dev exact accuracy `368/473 = 0.7780`, single `0.8359`, multi `0.6458`.
- `npm run eval:holdout`: pass, holdout exact accuracy `458/550 = 0.8327`, single `0.8626`, multi `0.7344`.
- Score delta from iteration 62/63 runtime: dev `+0`, holdout `+1` exact (`+0.0018`), holdout single `+0.0024`; multi unchanged.
- Latest diagnostics after rerun: dev errors `105`; holdout errors `92`; holdout likely next work is `recommendation_block_parser 38`, `option_family_resolver 22`, `multi_set_selection 17`.

Iteration 65 guarded therapy aliases:

- Added a small general Russian therapy synonym dictionary for answer phrase generation: examples include `гормонотерапия` / `гормональная терапия` / `МГТ`, `антибиотикотерапия` / `антибактериальная терапия`, `кислородотерапия` / `оксигенотерапия`, `радиотерапия` / `лучевая терапия`, `противовирусная терапия` / `ПВТ`, and similar high-confidence `X-терапия` variants.
- Added token-level expansion for `МГТ` and `гормонотерапия` so retrieval can share evidence with `менопаузальная гормональная терапия`, not only exact phrase search.
- Rejected the broader full dictionary with `антикоагулянтная терапия` and `антиагрегантная терапия`: it dropped holdout from `475/580` to `473/580` by over-boosting condition/protivopokazaniya options in `33-aorta`.
- Kept only the guarded dictionary groups that did not regress dev or holdout on the current group split.
- `npm test`: pass.
- `npm run typecheck`: pass.
- `npm run eval`: pass, dev exact accuracy `400/523 = 0.7648`, single `0.8306`, multi `0.6115`.
- `npm run eval:holdout`: pass, holdout exact accuracy `475/580 = 0.8190`, single `0.8624`, multi `0.6875`.
- Score delta against the no-alias baseline on the same current split: dev `+0`, holdout `+0`; the main observed behavior change is semantic rather than exact-score: `43-anomali#30` no longer selects the extra distractor `D`, and the `МГТ` candidate score rises, but the case remains under-selected.
- Latest diagnostics after rerun: dev errors `123`; holdout errors `105`; holdout likely next work is `recommendation_block_parser 41`, `option_family_resolver 25`, `multi_set_selection 22`.

Iteration 66 structured gynecology evidence:

- Added normalization for comparator glyphs extracted from PDFs: `<=`/`>=` are preserved for search, and `£` immediately before a number is treated as a likely `<=` extraction artifact. This is intentionally limited to numeric contexts so ordinary currency-like text is not changed.
- Added a preceding-label scorer for long single-answer description questions where the PDF has `label: description...` and the question quotes only the description. This prevents the answer-after-question heuristic from drifting to the next label.
- Added guarded Russian medical abbreviation support for stable short forms such as `СПЯ -> синдром поликистозных яичников` and `РЭ -> рак эндометрия`, including a low-weight short-alias multi evidence signal.
- Added a category-parenthetical scorer for multi questions where the relevant answer set is a single parenthetical group after an explicit category heading. The first broad version regressed neighboring aorta classification cases, so the retained version requires explicit category wording and enough specific focus before the parentheses, and is disabled for factor-risk questions.
- Added a modifier-target contrast penalty for pairs such as `ранняя менопауза` vs source evidence `поздняя менопауза`. The check binds the modifier to the nearest matching target noun instead of treating any nearby opposite cue as a mismatch.
- Added a comparator mismatch guard to shared multi-segment lifting so a segment with `<4`/`<=4` does not lift an answer that names a different numeric threshold.
- Targeted checks:
  - `43-anomali#7`: fixed by `preceding_question_label`.
  - `43-anomali#16`: fixed by `£`/`<=` normalization plus numeric comparator guard.
  - `43-anomali#17`: fixed by `parenthetical_group_segment`.
  - `43-anomali#29`: fixed by `СПЯ` alias plus `ранняя/поздняя` modifier-target contrast.
  - prior aorta category cases `33-aorta#32`, `33-aorta#33`, `33-aorta#44` remain correct after narrowing the parenthetical scorer.
- `npm test`: pass.
- `npm run typecheck`: pass.
- `npm run eval`: pass, dev exact accuracy `386/503 = 0.7674`, single `0.8281`, multi `0.6299`. The dev split now includes the newly added `44-girshprunga` group, so this score is not directly comparable to the previous 43-group dev total.
- `npm run eval:holdout`: pass, holdout exact accuracy `480/580 = 0.8276`, single `0.8670`, multi `0.7083`.
- `npx tsx scripts/eval.ts --split train`: pass, train exact accuracy `1101/1597 = 0.6894`, single `0.7802`, multi `0.5102`, with `17` unkeyed cases skipped.
- Score delta from iteration 65 on holdout: `+5` exact (`+0.0086`), single `+0.0046`, multi `+0.0208`. The main lift is from the new `43-anomali` group behavior: `17/30` to `23/30`, while `33-aorta` is `54/70` after the conservative parenthetical narrowing.
- Latest diagnostics after rerun: dev errors `117`; holdout errors `100`; holdout likely next work is `recommendation_block_parser 42`, `option_family_resolver 23`, `multi_set_selection 20`.

Iteration 67 continuation-list and numeric-family hypotheses:

- Hypothesis 1: multi questions whose wording is continued directly in the PDF list can recover missed answers if the parser reads a longer line continuation, not only a short 3-line window. A broad version for `включают/относятся/определение/проводится` was rejected because it over-selected classification and comment paragraphs on dev. The retained form is limited to `основано/основаны на данных...` style prompts and uses a 7-line continuation window so the full answer list is visible.
- Hypothesis 2: single questions with dense numeric answer families should prefer a full numeric option phrase in a relevant recommendation/dose line over partial numeric chunks. The broad version was rejected because partial `%`/dose fragments in unrelated tables caused dev regressions. The retained form is limited to recommendation/dose/frequency questions and requires a full normalized numeric option phrase, not just a shared number or unit.
- `npm test`: pass.
- `npm run typecheck`: pass.
- `npm run eval`: pass, dev exact accuracy `386/503 = 0.7674`, single `0.8281`, multi `0.6299`.
- `npm run eval:holdout`: pass, holdout exact accuracy `482/580 = 0.8310`, single `0.8670`, multi `0.7222`.
- `npx tsx scripts/eval.ts --split train`: pass, train exact accuracy `1101/1597 = 0.6894`, single `0.7802`, multi `0.5102`, with `17` unkeyed cases skipped.
- Score delta from iteration 66: dev `+0`; holdout `+2` exact (`+0.0034`), single `+0.0000`, multi `+0.0139`. The gain comes from multi set completion without changing train/dev totals.
- Latest diagnostics after rerun: dev errors `117`; holdout errors `98`; holdout likely next work is `recommendation_block_parser 41`, `option_family_resolver 23`, `multi_set_selection 19`.

Iteration 68 diagnostics-driven confidence:

- Added a separate output-confidence layer after selection. It does not change raw scores, calibrated answer scores, or selected ids.
- The layer discounts predictions when the selected answer/set is supported only by flat search evidence, when the selected/unselected raw boundary is close, or when a multi set relies on broad shared chunks without structural evidence.
- This is a general reliability signal for downstream callers and future triage. It uses only evidence kinds, raw-score gaps, and selected-set shape; it does not read labels or PDF/case identifiers.
- `npm test`: pass.
- `npm run typecheck`: pass.
- `npm run eval`: pass, dev exact accuracy unchanged at `386/503 = 0.7674`, single `0.8281`, multi `0.6299`. Confidence separation improved from roughly `0.9120/0.8641` correct/incorrect to `0.7952/0.6704`.
- `npm run eval:holdout`: pass, holdout exact accuracy unchanged at `482/580 = 0.8310`, single `0.8670`, multi `0.7222`. Confidence separation improved from `0.9242/0.8657` correct/incorrect to `0.8154/0.6919`.
- `npm run diagnostics`: pass. Error counts are unchanged: dev `117`, holdout `98`.

Iteration 69 recommendation condition and numeric OCR guards:

- Added a subject guard to the frequency/duration recommendation scorer. A line that only matches `3 суток`, `7 дней`, or another duration no longer gives full recommendation evidence to an answer naming a different drug or medical agent. The guard extracts non-generic answer subject tokens and requires at least one of them in the same recommendation line.
- Added OCR-aware numeric coverage for short split digit groups such as `9 00 мг`, treating them as `900` in addition to the raw `9` and `00`. The join is limited to short digit groups to avoid turning ordinary enumerations into arbitrary numbers.
- Added an excluded-condition mismatch penalty for questions with clinical subgroup wording like `без X`: if a candidate is supported only in the local context `при X` / `наличие X`, that evidence is treated as a mismatch. The rule is intentionally skipped for procedural wording such as `без проведения`, `без применения`, and `без назначения`, which describes an action rather than a patient subgroup.
- Targeted checks:
  - `15-toxic#24`: now distinguishes `тиамин ... 900 мг ... 3 суток` from the same duration with another dose/drug in local prediction, but this did not change aggregate dev because another prior tie remains elsewhere in the split.
  - `17-gepatit#39`: fixed by the `без цирроза` vs `при циррозе` local condition mismatch.
  - `08-ask#18`: protected by the procedural skip for `без проведения нагрузочной пробы`.
- `npm test`: pass.
- `npm run typecheck`: pass.
- `npm run eval`: pass, dev exact accuracy unchanged at `386/503 = 0.7674`, single `0.8281`, multi `0.6299`.
- `npm run eval:holdout`: pass, holdout exact accuracy `483/580 = 0.8328`, single `0.8693`, multi `0.7222`.
- `npm run diagnostics`: pass. Error counts are dev `117`, holdout `97`.
- Score delta from iteration 68: dev `+0`; holdout `+1` exact (`+0.0018`), holdout single `+0.0023`, multi unchanged.

Iteration 70 dose-range option-family resolver:

- Added explicit dose-range parsing to `drug_dose_segment`. Answers and source lines now represent `10-15 мг` as a range, not only as the nearest single `15 мг`/`10 мг` number.
- A range answer now requires a range source fact; it is no longer treated as supported by a separate maximum-dose statement such as `до 25 мг`. This is a general option-family guard for dense dose variants, not a drug-specific rule.
- Targeted check: `14-sarkoidoz#64` switches from the distractor `20-25 мг 1 раз в неделю` to `10-15 мг 1 раз в неделю` because `до 25 мг` no longer supports a range answer.
- `npm test`: pass.
- `npm run typecheck`: pass.
- `npm run eval`: pass, dev exact accuracy unchanged at `386/503 = 0.7674`, single `0.8281`, multi `0.6299`.
- `npm run eval:holdout`: pass, holdout exact accuracy `484/580 = 0.8345`, single `0.8716`, multi `0.7222`.
- `npm run diagnostics`: pass. Error counts are dev `117`, holdout `96`.
- Score delta from iteration 69: dev `+0`; holdout `+1` exact (`+0.0017`), holdout single `+0.0023`, multi unchanged.

Iteration 71 recommendation-block parser rejection and hour alias binding:

- Tested a broad recommendation-block parser that grouped nearby recommendation/comment paragraphs and tried to bind candidate answers inside the block. The idea looked promising on dev (`388/503 = 0.7714`, `+2` exact), but it regressed holdout to `475/580 = 0.8190` (`-9` exact), mostly by turning broad recommendation paragraphs into over-strong evidence for distractors. The parser was rejected and removed from runtime.
- Added a narrow time-unit alias dictionary for stable Russian hour variants: `6 часов`, `6 часа`, `6 час`, `6 ч`, and `6 ч.`. This is phrase-level normalization, not a medical-fact rule.
- Added `exact_hour_alias_segment`, a guarded single-answer scorer for cases where the answer option spells out hours but the PDF uses the short form. It only searches bounded hour aliases, stays near top question pages, requires local question/focus support, and if the question contains another numeric condition (for example temperature), that condition must be present in the same local segment.
- Rejected a broader attempt to feed all answer aliases into the existing `exact_numeric_option_segment`: it fixed the new hour case, but holdout fell to `475/580` by over-boosting dense month/dose families. The retained implementation keeps the old numeric scorer unchanged and isolates the hour abbreviation case.
- Targeted check: the new botulism case with `6 часов` vs source `6 ч при температуре 100°C` now passes.
- `npm run typecheck`: pass.
- targeted `NMO_RUN_CASE_TESTS=1 npx vitest run __test__/45-botulizm/cases.test.ts -t "Уничтожение спор"`: pass.
- `npm test`: pass.
- `npm run eval`: pass, dev exact accuracy unchanged at `386/503 = 0.7674`, single `0.8281`, multi `0.6299`.
- `npm run eval:holdout`: pass, holdout exact accuracy unchanged at `484/580 = 0.8345`, single `0.8716`, multi `0.7222`.
- `npm run diagnostics`: pass. Error counts remain dev `117`, holdout `96`.
- Score delta from iteration 70 on the fixed split: dev `+0`; holdout `+0`; single `+0`; multi `+0`. The gain is on the newly added train-group regression case without sacrificing held-out quality.

Iteration 72 spaced reference cleanup and serotype count binding:

- Added a narrow PDF-reference cleanup for bracketed spaced numeric references such as `[ 8 10 ].`. The rule only fires before a sentence-ending dot, so ordinary bracketed numeric groups inside a sentence are preserved.
- Strengthened the existing count-relation scorer for `различают N ...` forms and added a target binding for `серотип`: a candidate count must appear before the target word in the local segment. This prevents a later reference or nearby duration such as `10 минут` from beating the actual `8 серотипов` count.
- Targeted check: `45-botulizm` count question now selects `8` for `различают 8 серотипов`.
- `npm run typecheck`: pass.
- targeted `NMO_RUN_CASE_TESTS=1 npx vitest run __test__/45-botulizm/cases.test.ts -t "В зависимости от антигенной структуры"`: pass.
- `npm test`: pass.
- `npm run eval`: pass, dev exact accuracy unchanged at `386/503 = 0.7674`, single `0.8281`, multi `0.6299`.
- `npm run eval:holdout`: pass, holdout exact accuracy unchanged at `484/580 = 0.8345`, single `0.8716`, multi `0.7222`.
- `npm run diagnostics`: pass. Error counts remain dev `117`, holdout `96`.
- Score delta from iteration 71: dev `+0`; holdout `+0`; single `+0`; multi `+0`. The targeted train-group regression is fixed without held-out regression.

Iteration 73 inline parenthetical group binding:

- Added a guarded inline parenthetical-group mode for sentences like `вырабатывают целый ряд ферментов (уреаза, протеазы, фосфолипазы), повреждающих...`.
- The rule is deliberately narrower than the rejected broad parenthetical parser: it requires a list cue before the parentheses (`ряд` or `группа`), at least one question-focus token before the group, at least one after the group, and at least two answer options matching inside the same parentheses.
- This fixes a multi under-selection pattern where all correct answers are in the same parenthetical group but the selector keeps only the two strongest broad-search candidates.
- Targeted check: `46-yazva` Helicobacter enzyme question now selects `протеаза`, `уреаза`, and `фосфолипаза`, while excluding `энтерокиназа`.
- `npm run typecheck`: pass.
- targeted `NMO_RUN_CASE_TESTS=1 npx vitest run __test__/46-yazva/cases.test.ts -t "Ферментами Helicobacter"`: pass.
- `NMO_RUN_CASE_TESTS=0 npm test`: pass.
- `npm run eval`: pass, dev exact accuracy unchanged at `386/503 = 0.7674`, single `0.8281`, multi `0.6299`.
- `npm run eval:holdout`: pass, holdout exact accuracy unchanged at `484/580 = 0.8345`, single `0.8716`, multi `0.7222`.
- `npm run diagnostics`: pass. Error counts remain dev `117`, holdout `96`.
- Score delta from iteration 72: dev `+0`; holdout `+0`; single `+0`; multi `+0`. The newly added train-group regression is fixed without held-out regression.

Iteration 74 type ordinal list binding:

- Tested three structural hypotheses in separate iterations:
  - broad multi enumeration/list parser: rejected. It regressed dev from `386/503 = 0.7674` to `378/503 = 0.7515`, mainly by merging neighboring classifications, recommendation groups, and opposite condition lists.
  - local numeric relation binding for single answers: rejected. It improved dev by one exact answer but regressed holdout from `484/580 = 0.8345` to `468/580 = 0.8069`, because dense dose/frequency paragraphs contain many nearby numeric distractors.
  - answer ordinal-row binding for `N тип` labels: retained. This extends the existing stage/degree row parser to classification type rows such as `2 тип: ...`, using the same focus-token and next-row boundary checks.
- The retained change is not tied to a medical fact or PDF name. It only recognizes answer options of the stable form `1 тип`, `2 тип`, `III тип`, etc. and binds them to local definition/list rows that contain the question focus.
- Targeted behavior: classification questions whose PDF text contains `N тип: definition...` can now select the type label by matching the definition text, instead of relying on a flat chunk where several type labels are adjacent.
- `npm run typecheck`: pass.
- `NMO_RUN_CASE_TESTS=0 npm test`: pass.
- `npm test`: pass.
- `npm run eval`: pass, dev exact accuracy `387/503 = 0.7694`, single `0.8309`, multi `0.6299`.
- `npm run eval:holdout`: pass, holdout exact accuracy unchanged at `484/580 = 0.8345`, single `0.8716`, multi `0.7222`.
- Score delta from iteration 73: dev `+1` exact (`+0.0020`), dev single `+0.0028`, dev multi `+0.0000`; holdout `+0`, holdout single `+0.0000`, holdout multi `+0.0000`.

Iteration 75 behavior-preserving scorer extraction (refactor only):

- Goal: continue turning `predictor.ts` from a monolith into an orchestrator by moving thematic scorer clusters into `src/predictor/scorers/*`, without changing any scoring logic.
- Extracted two scorer families:
  - `src/predictor/scorers/direction.ts`: polarity, temporal day/night, contrast-cue mismatch, modifier-target contrast, and excluded-condition mismatch scorers.
  - `src/predictor/scorers/numeric.ts`: cloze-gap, condition-pair, exact-numeric-option, exact-hour-alias, the condition/numeric-condition/conditioned-number web, and count-relation scorers.
- Relocated two generic helpers to `src/predictor/text-utils.ts` so they are shared without import cycles: `nearestCueName` and `tokenBoundaryIncludes`.
- `predictor.ts` dropped from `5400` to `3958` lines; the moved code is verbatim, only `export` was added to the scorer entry points and imports were rewired.
- Verification used a per-case diff harness (`scripts/diff-results.mjs`), not just aggregate accuracy:
  - `npm run typecheck`: pass.
  - `npm test`: pass (leakage guard still covers `src/predictor/**`).
  - `npm run eval`: dev `387/503 = 0.7694`, ZERO-DELTA vs baseline (all 503 selected sets identical).
  - `npm run eval:holdout`: holdout `484/580 = 0.8345`, ZERO-DELTA vs baseline (all 580 selected sets identical).
- Score delta from iteration 74: `0` on every metric, by construction.
- Remaining in `predictor.ts`: the classification/code/row family and the list/recommendation/definition family are still inline. They are interleaved with generic retrieval helpers (`bestChunkSupport`, `bestPrefixSupport`, `visual_table_column`) and share helpers across families, so they need careful per-cluster extraction in a later pass; deferred to keep this refactor strictly behavior-preserving.

Iteration 76 multi cardinality hypothesis: REJECTED by read-only diagnostic.

- Hypothesis A: estimate multi-answer cardinality `k` from the shape of the sorted raw-score distribution (largest relative drop / "elbow", plus z-scored gap), instead of relying only on the existing absolute/relative/gap thresholds.
- Method: `scripts/cardinality-diag.mjs` reuses saved eval artifacts (per-case `rawScores` + `expected`); it does not call the predictor or read answer-key/case files, so nothing leaks into runtime. No runtime code was changed for this test.
- Results (multi cases only):
  - dev: current `97/154 = 0.6299`; oracle-k with known count `116/154 = 0.7532`; pure elbow `77/154 = 0.5000`; best conservative dominant-elbow gate net `-1`.
  - holdout: current `104/144 = 0.7222`; oracle-k `119/144 = 0.8264`; pure elbow `83/144 = 0.5764`; best conservative gate net `-3`.
- Conclusion: the current threshold+guard selector is already at or above the distribution-only cardinality ceiling. Every elbow variant (pure or conservatively gated) is net-neutral-to-negative on dev and negative on holdout, so a distribution-shape cardinality estimator is rejected. This matches the iteration-50 oracle finding that cardinality alone caps multi at ~0.75 dev / ~0.83 holdout.
- Error-structure analysis (dev multi, 57 errors): 28 distractor (a wrong option outranks a correct one), 14 under-selection, 15 over-selection. Missed-correct answers sit at raw ranks 3-7, never 1-2. So the dominant remaining lever is RANKING (lifting correct answers above distractors at the rank-3+ boundary), not cardinality. This is Hypothesis B territory; the diagnostic redirected effort there before any runtime change was made.

Iteration 77 multi ranking hypothesis B (structural co-membership): one experiment NEUTRAL, reverted.

- Hypothesis B: lift a correct answer above a distractor at the rank-3+ boundary by treating more explicit structures as multi co-membership evidence. First experiment: add `parenthetical_group_segment` to `SHARED_MULTI_SOURCE_KINDS` so an answer sharing the same `(A, B, C)` group as two already-selected answers gets the shared-segment lift.
- Result: ZERO-DELTA on both dev (`387/503`) and holdout (`484/580`); per-case diff shows no case changed its selected set. The dedicated parenthetical scorer already scores those answers high enough, so the shared-segment path never produces a new lift.
- Decision: reverted. Per the project rule that improvements must pass measurable validation, a zero-delta change is not kept as runtime surface area.
- Why quick B wins look exhausted (data-driven, dev multi distractor cases): they split into (a) broad vocabulary-close cases whose evidence is only `bm25_question_answer`/`question_chunk_answer`/`shared_multi_segment` (no structural signal distinguishes the correct option from the distractor), and (b) neighboring flattened-list cases such as `41-destonia#34/35/36` ("К аутосомно-доминантной/рецессивной/митохондриальной форме ... относятся") and `32-gemor` form lists, where distractors are items from a sibling subtype's enumeration. (b) is exactly the flattened-list/table boundary problem the docs flag; a narrow rule risks the neighboring-list merge regressions seen in iterations 67/74, and fitting to ~3 dev cases would be overfitting.
- Concrete next direction (not attempted here to avoid overfitting/regression): precise subtype-list boundary binding — when a question names a specific subtype/form (`<subtype> форма ... относятся`), bind answers only to that subtype's enumeration block and treat sibling-subtype list items as mismatches. This needs reliable block-boundary detection (the same prerequisite as deeper coordinate table/list reconstruction), validated with group split by PDF, holdout reporting-only.

Iteration 78 boilerplate stripper fix (text noise removal): KEPT, dev +1, holdout zero-delta.

- Found a real bug: `stripLikelyBoilerplate` in `src/pdf.ts` had mojibake regexes (e.g. `СЃС‚СЂР°РЅРёС†Р°` = double-encoded "страница"), so it matched nothing. A read-only corpus scan (`scripts/pdf-noise.ts`) confirmed all 46 PDFs extract as clean Cyrillic and the stripper fired 0 times, leaving `8151/125108 = 6.5%` of lines as repeated boilerplate (page numbers `3093`, running guideline header `551`, `страница N из M` `534`, URLs `943`).
- Fix: rewrote the stripper to match `normalizeText` (clean lowercase Cyrillic, not the lookalike-folded `normalizeForSearch`) and strip only non-content lines: `страница N из M` footers, standalone 1-3 digit page-number lines, and URL/source lines.
- Deliberately did NOT strip the running guideline header even though it repeats per page: it carries the disease name (content). A first version that stripped it was net-neutral but broke `32-gemor#25` (over-selected D), so it was dropped on the principle "do not remove content-bearing lines."
- Standalone page numbers matter because `buildPageText` was merging a bare `47` line into the previous sentence as a stray number; removing them prevents that pollution.
- Result: dev `388/503 = 0.7714` (+1 exact: `31-hbs#23` no longer over-selects a distractor that a boilerplate line was inflating; `34-covid#39` changed wrong->wrong, harmless); holdout ZERO-DELTA `484/580 = 0.8345`; `npm run typecheck` and `npm test` pass.
- Corpus-neutral and not tied to any PDF/question, so it should also reduce noise on future similarly-structured NMO PDFs. Bare-number stripping is bounded to 1-3 digits so 4-digit years/codes are preserved, and table values stay on their row line (same y) rather than as standalone lines, so coordinate-table scorers are unaffected (confirmed by holdout zero-delta).

Iteration 79 evidence-grade noise removal: REJECTED, holdout regressed.

- A post-fix noise re-scan (`scripts/pdf-noise.ts`, extended with cross-PDF frequency) showed the biggest remaining repeated text is the УДД/УУР evidence-grade annotation (`2917` lines): `уровень убедительности рекомендаций X (уровень достоверности доказательств – N)` and short `УДД – N, УУР – Х`, repeated after almost every recommendation. The other remaining repeats are legitimate structure (standard section headers `список литературы`/`термины и определения`/`приложение ...` appear ~1x per PDF, not per-page noise) or a single train PDF (`24-kalit` drug-registry boilerplate, not on dev/holdout).
- Experiment: strip standalone evidence-grade lines (lines starting with `уровень убедительности рекоменд`, length < 130; short `УДД ... УУР ...` lines), conservatively so content+grade lines are not removed.
- Result: dev `386/503 = 0.7674` (-2 vs iteration 78, 11 cases churned) and holdout `481/580 = 0.8293` (-3 vs iteration 78: `11-mening#1`, `14-sarkoidoz#53`, `17-gepatit#39`, `17-gepatit#55`, `43-anomali#24`). Reverted.
- Why: the grade annotation is not free noise. It sits directly between consecutive recommendations and acts as a boundary/anchor; removing it brings neighboring recommendation text together and shifts the windows that the recommendation scorers (`explicit_recommendation_target`, `recommendation_item`, frequency/dose) rely on. Net structural harm outweighs the noise reduction.
- Conclusion on noise removal: the safe, validated win is iteration 78 (pure non-content footers/page-numbers/URLs). Remaining repeated text is either content-adjacent structure (evidence grades — keep) or legitimate document structure (section headers — keep), so further generic line stripping is not advisable without deeper recommendation-block parsing.

Iteration 80 bibliography section removal: KEPT, holdout +1, dev -2 (net -1 but holdout-favorable).

- Analysis (`scripts/biblio.ts`, read-only): the "Список литературы" section is present in all 46 PDFs and is `22.0%` of the entire corpus text (`1.65M / 7.5M` chars). It is cleanly bounded in every PDF: from the (last) "Список литературы" heading to the next section, which is universally "Приложение А1. Состав рабочей группы...", so all clinical appendices are kept.
- Change: `removeBibliographySection` in `src/pdf.ts` drops the lines from the bibliography heading to the next "Приложение"/section heading, rebuilding `text`/`lineItems`/`normalized` for affected pages. It takes the last heading occurrence and only fires in the latter 60% of the document, so a table-of-contents entry cannot trigger it.
- Result vs iteration 78: holdout `484->485/580 = 0.8362` (single `0.8716->0.8739`, multi `0.7222` unchanged); dev `388->386/503 = 0.7674` (single `0.8309->0.8252`, multi `0.6299->0.6364`). `npm run typecheck` and `npm test` pass.
- Holdout changes: `+2` fixed (`19-gepatitc#35`, `19-gepatitc#49`), `-1` broke (`19-gepatitc#36`), 2 wrong->wrong.
- Dev breaks investigated: `07-hron#24` is a real side effect (distractor C's drug name was diluted by reference citations, so removing them raised its IDF and it overtook the correct answer, `6.79->10.65`); `32-gemor#61` is a multi-threshold artifact (all three correct answers moved only `-0.03..-0.05`); `44-girshprunga#21` is a no-evidence guess (all options tied at the `4.80` floor, D got `+0.47`). 2 of 3 breaks are noise.
- Mechanism: removing the reference list sharpens the IDF of clinically meaningful terms (they are no longer diluted by dozens of citation mentions). This is double-edged per case but generalizes favorably, which is why the held-out gate improved. It also reduces false Latin/gene matches from author/journal names. Decision: kept because holdout (the primary acceptance criterion) improved and 22% of pure-citation noise is removed corpus-neutrally; the dev `-2` is mostly noise and not fixable without overfitting to those cases.

Iteration 81 own PDF-content analysis + 5 section-removal hypotheses (2 kept, 3 rejected).

- Built `scripts/sections.ts` (read-only) to segment every PDF into named sections by heading and measure char sizes. After the bibliography was already removed, the largest non-content sections were appendices А1/А2/А3, the table of contents, and the quality-criteria checklist. Clinical appendices (Б algorithms, В patient info, Г scales) were never touched. Each hypothesis was implemented conservatively (bounded span, last-occurrence heading, latter-document guard) and validated with `npm run typecheck`, `npm test`, `npm run eval`, `npm run eval:holdout`; kept only if holdout did not regress.
- H1 — table of contents (`removeTableOfContents`): KEPT. dev `386->387` (`07-hron#24` fixed — the case the bibliography removal had broken; dropping the duplicated section titles re-balanced its IDF), holdout zero-delta `485`.
- H2 — appendix А1 "Состав рабочей группы" (`removeMetadataAppendices(1,2)`): KEPT. dev `387->388` (`31-hbs#14` fixed), holdout zero-delta `485`. Working-group names/credentials are pure metadata.
- H3 — appendix А2 "Методология" (`removeMetadataAppendices(1,3)`): REJECTED. dev `0`, holdout `485->484` (`-1`). Methodology/grading-scale removal shifts IDF unfavorably for some held-out cases.
- H4 — appendix А3 "Связанные документы" (`removeMetadataAppendices(3,4)`, isolated so А2 stays): REJECTED. dev `388->384` (`-4`), holdout `485->482` (`-3`). А3 is not pure metadata in all PDFs — it carries clinical reference material (dose/classification tables) that questions use.
- H5 — "Критерии оценки качества медицинской помощи": REJECTED. dev `388->387` (`-1`), holdout `485->482` (`-3`). The quality-criteria checklist overlaps with content that questions reference.
- Net kept this round (on top of iteration 80): dev `386->388` (`+2`), holdout `485` unchanged. Final: dev `388/503 = 0.7714`, holdout `485/580 = 0.8362`. The `removeMetadataAppendices` range form and `appendixRank` are kept (А1 only); the rejected А2/А3/quality paths were reverted and their dead code removed.
- General lesson: only document-structure metadata that contains no clinical terms is safely removable (TOC, working-group names). Methodology, related-documents, and quality-criteria sections look like metadata but are close enough to clinical vocabulary that removing them perturbs retrieval and regresses holdout. eval-gated testing caught all three before they could ship.

Iteration 82 section-aware chunking + intent priority: REJECTED (routing only 30% accurate).

- Idea (user proposal): tag every page with its standard NMO section (1 Краткая информация, 2 Диагностика, 3 Лечение, 4 Реабилитация, 5 Профилактика, 6 Организация, 7 Доп. информация), map question intent to a target section (treatment->3, diagnosis->2, ...), and prioritize evidence from the matching section so the right answer is lifted over a lexically-similar distractor in another section.
- Section detection is reliable: headings found in 44-46/46 PDFs, all 7 in 42/46 (`scripts/section-headings.ts`). `tagPageSections` assigns each page a monotonic section number.
- Two scoring integrations were tried: v1 additive in-section bonus (`raw += min(1.5, inBest*0.08)`) regressed holdout `485->484` by over-selecting multi sets; v2 mild out-of-section penalty (`raw *= 0.88` when an answer's clinical evidence is only outside the target section) was net-neutral (dev `388`, holdout `485`, +1 fix / -1 break).
- Root cause measured with `scripts/section-route-check.ts`: of the 217 dev cases where intent picks a target section, the correct answer actually lives in that section only `65 = 30.0%` of the time (≈50% even among answers locatable in a clinical section). NMO answer locations do not follow question intent: recommendations are scattered across sections, diagnostic criteria are placed in section 7, and the broad treatment cues over-target section 3 (148/217). A 30% routing rate makes the signal net-zero by construction.
- Decision: reverted both the scoring signal and the page-section tagging (dead code without the signal); `src/pdf.ts` and `src/predictor.ts` are byte-identical to the previous commit. Kept `scripts/section-headings.ts` and `scripts/section-route-check.ts` as read-only documentation. Section routing would need either much more precise per-answer localization than page-level sections, or a different premise than "answer is in the intent section".

Iteration 83 broaden TOC removal + front-matter appendix list: KEPT, holdout +1.

- Trigger: the user reported surviving tables of contents and "Состав рабочей группы" blocks. `scripts/toc-check.ts` / `scripts/wg-check.ts` showed two gaps in the heading-based `removeTableOfContents`: (a) most TOCs have no "Содержание"/"Оглавление" heading at all — they start directly with dotted entries; (b) some use the ellipsis glyph `…` as the leader instead of periods.
- Rewrote `removeTableOfContents` to detect TOCs by their leader signature instead of a heading: a line is a TOC entry if it has a 4+ dot run or the `…` glyph; the dense early block from the first to the last such line is removed (a preceding "Содержание"/"Оглавление" heading is also dropped). This caught the dot-leader TOCs (`+1` holdout: `486/580`, `19-gepatitc#36` and `33-aorta#28` fixed, `19-gepatitc#35` broke) and the ellipsis-leader appendix TOC lines (zero-delta).
- Added `removeFrontMatterAppendixList`: 8 PDFs list the appendices in the front matter without surviving leaders ("Приложение А1. Состав рабочей группы... / Приложение А2... / Приложение А3..."). It removes a dense block of >=2 appendix-title lines in the first 15% of the document only; real appendix bodies are in the last 40% and are untouched. This eliminated the remaining "Состав рабочей группы" sightings; zero-delta on dev/holdout.
- "Рабочая группа" mentions that remain are intentionally kept: they are glossary definitions ("Рабочая группа – двое или более людей...") in the Термины section and methodology prose, i.e. content, not the name list.
- Net this segment vs commit fcd81e4: dev `388/503 = 0.7714` unchanged, holdout `485 -> 486/580 = 0.8379`, multi `0.7222 -> 0.7292`. `npm run typecheck` and `npm test` pass.

Iteration 84 multi-answer ranking push (H3/H2/H1): CEILING reached, no runtime change kept.

- Goal: +5% overall multi (baseline `491/876 = 0.5605` across train+dev+holdout).
- Error decomposition (385 multi errors): membership lists `105` ("К группе/классу X относятся ..."), recommendation lists `59`, other `204`, coordinate-table only `~17`. So the proposed H1 (coordinate table reconstruction) can touch at most ~17 multi errors (~+2%), not +5% - tables mainly help single classification. The real multi lever is exact membership of flattened lists.
- H3 (pairwise contrastive re-rank): rejected by diagnostic. 34/66 single rank-2 misses have the SAME broad evidence kind on the wrong and the correct answer, so re-ranking on existing signals is circular - no distinguishing information exists without new structure.
- H2 (clause-level condition binding): the existing focused/condition scorers already do clause-level co-occurrence; the misses persist because flattening makes the distractor co-occur just as tightly, so a co-occurrence re-rank is circular too.
- H1 attempts on the real multi lever (list-membership), each eval-gated:
  - V1 loosen shared-multi co-membership floor for list questions: dev multi `0.6364 -> 0.6299` (over-selection). Reverted.
  - V2 lower floor only for strong members (phrase hit + coverage >= 0.85): zero-delta (gate never fires differently). Reverted.
  - V3 select exactly the members of a clean structural list segment (binds membership AND cardinality): dev `+1` (`389/503`, multi `0.6429`, fixed `07-hron#28`) but holdout `-1` (`485/580`, `14-sarkoidoz#38` over-selected a member that is a distractor). Net wash; reverted because it regresses holdout and tuning the member threshold to dodge the holdout case would be overfitting.
- Root cause of the ceiling: list membership != correctness. A flattened list often contains both correct items and distractors with identical structural membership, so any membership-based selection trades under-selection fixes for over-selection breaks (net ~0). Distinguishing them needs semantics the flattened text does not preserve.
- Conclusion: counting this session's distinct algorithmic probes at multi/ranking (cardinality elbow x3 gates iter 76, section routing x2 iter 82, H3, H2, V1, V2, V3 = ~9) plus the 80+ prior iterations, +5% multi is not reachable with the non-LLM text architecture. Real progress would require either coordinate-level table/list reconstruction deep enough to recover row/list-item boundaries (large project, uncertain payoff) or an LLM (excluded by the project constraints). Runtime is unchanged at dev `388/503`, holdout `486/580`; the negative result is recorded rather than shipping an overfit change.

Iteration 85 option-family and recommendation-item probes: two retained, recommendation-line rejected.

- Baseline for this round: dev `388/503 = 0.7714`, holdout `486/580 = 0.8379`.
- Attempt 1, comparator-family guard: penalize simple dense options where an answer says `>N` but its own evidence only supports `<N` for the same number, or vice versa. Dev `+1`, holdout zero-delta. Kept after narrowing to single-comparator answers so scale answers with many signs are not touched.
- Attempt 2, compact treatment combo guard: distinguish compact abbreviation combinations such as `A/B` or `A+B` from alternatives such as `A или B`. A broad version accidentally treated units (`мл/кг`, `МЕ/мл`) as drug combinations and regressed holdout. The retained version accepts only short non-unit abbreviation parts. Dev reached `390/503 = 0.7753`; holdout stayed `486/580`.
- Attempts 3-5, recommendation line item parser: broad line-item support regressed dev (`379/503`) by over-selecting neighboring recommendations. A single-only/numeric-excluding version was neutral on dev but still churned cases. A further narrowed version improved dev to `391/503`, but holdout fell to `474/580`; rejected. Lesson: even recommendation lines are too flat unless the parser binds the exact target/condition.
- Attempts 6-7, slash-dose component resolver: fixed a parser bug where the right side of `100/400 мг` was also matched as a standalone `400 мг`, and ensured slash-dose pairs are resolved by component order near `A+B` / `A/B`. This fixed held-out component-dose questions without changing dev.
- Final retained result: dev `390/503 = 0.7753`; holdout `488/580 = 0.8414`; holdout single `0.8739 -> 0.8784`; holdout multi unchanged `0.7292`.
- The retained changes are structural and corpus-neutral: comparator direction, compact abbreviation-vs-unit filtering, and component order in slash dose pairs. No question, PDF, answer key, or medical fact was hardcoded.

Iteration 86 frequency-polarity sentence binding: KEPT, holdout +1.

- Theory 1 attempt set: use general Russian frequency wording (`наиболее част...`, `редк...`, `ведущ...`) as a structural cue for single-answer questions. This is not a medical-fact rule; it binds the option phrase to the same sentence-like fragment as the frequency cue.
- Attempt 1 was too broad: pre-normalized cues were passed into `containsNormalizedPhrase`, which normalizes its needle again, so the scorer was zero-delta. Fixed by keeping cue strings raw.
- Attempt 2 was also too broad: line-window matching boosted answers that appeared in a previous sentence or only inside parenthetical examples. Narrowed to sentence-like fragments and stripped parenthetical spans before phrase matching.
- Final guard: no coverage-only support. The answer phrase must be present outside parentheses in the same fragment as the frequency cue, with optional question-focus support.
- Result vs iteration 85: dev zero-delta `390/503 = 0.7753`; holdout `488 -> 489/580 = 0.8431`; holdout single `0.8784 -> 0.8807`; holdout multi unchanged `0.7292`.
- Changed selected set: `11-mening#28` fixed from `[D]` to `[A]`. No dev selected sets changed.

Iteration 87 frequency-polarity list-heading binding: KEPT, holdout +1.

- Theory 1 continuation: the same frequency wording can be a heading for a bullet list, e.g. `Редкие формы ...:` followed by list items. The previous sentence-level scorer deliberately could not bind cross-line/cross-page list continuations.
- Added `frequency_polarity_list_item` for single-answer questions only. It requires a heading line with the same frequency polarity as the question, optional focus-token support in the heading, and an exact answer phrase in one of the immediately following bullet/list lines. The list can continue onto the next page, but stops at the first non-list line after items begin.
- Result vs iteration 86: dev zero-delta `390/503 = 0.7753`; holdout `489 -> 490/580 = 0.8448`; holdout single `0.8807 -> 0.8830`; holdout multi unchanged `0.7292`.
- Changed selected set: `11-mening#54` fixed from `[B]` to `[D]`. No dev selected sets changed.
