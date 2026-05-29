import type { AnswerMode } from "./types.js";

/** Описание scorer-модуля и evidence-kind, которые он может порождать. */
export type ScorerRegistryEntry = {
  id: string;
  module: string;
  modes: readonly AnswerMode[];
  evidenceKinds: readonly string[];
  purpose: string;
  risk: "structural" | "broad" | "adjustment" | "mixed";
};

/** Веса надежных структурных evidence-kind, используемые слоем выбора ответов. */
const SELECTION_STRUCTURAL_EVIDENCE_WEIGHTS_RECORD = {
  coordinate_table_row: 1.25,
  coordinate_table_group: 1.25,
  coordinate_table_group_inverse: 1.25,
  coordinate_table_multicell_row: 1.25,
  coordinate_table_membership: 1.15,
  parenthetical_group_segment: 1.05,
  preceding_question_label: 1.05,
  question_continuation_list: 1.05,
  exact_numeric_option_segment: 1.05,
  exact_hour_alias_segment: 1.05,
  short_medical_alias_segment: 0.9,
  visual_table_column: 1.2,
  exact_short_label_visual_row: 1.15,
  short_label_visual_row: 1.05,
  answer_ordinal_row: 1.05,
  fibrosis_stage_row: 1.2,
  gene_sentence_segment: 1.1,
  clinical_feature_segment: 1.0,
  mkb_class_exclusion_absent: 1.0,
  classification_code_segment: 1.15,
  label_number_proximity: 1.0,
  label_definition_segment: 1.0,
  definition_exact_answer_segment: 1.0,
  definition_completion_specificity: 0.95,
  row_label_segment: 0.95,
  bounded_list_segment: 0.95,
  ordinal_list_segment: 0.9,
  drug_dose_segment: 0.9,
  frequency_polarity_segment: 0.9,
  frequency_polarity_list_item: 0.95,
    clinical_course_cue_segment: 0.9,
    recommendation_block_segment: 0.85,
    recommendation_item_segment: 0.85,
  explicit_recommendation_target_segment: 0.85,
  numeric_condition_less_than: 0.85,
  numeric_condition_more_than: 0.85,
  numeric_condition_equal: 0.85,
  conditioned_number_segment: 0.8,
  cloze_gap_local: 0.8,
} as const;

/** Карта весов структурного evidence для selection.ts. */
export const SELECTION_STRUCTURAL_EVIDENCE_WEIGHTS = new Map(Object.entries(SELECTION_STRUCTURAL_EVIDENCE_WEIGHTS_RECORD));

/** Evidence-kind, которые считаются структурными при расчете confidence. */
export const CONFIDENCE_STRUCTURAL_EVIDENCE_KINDS = new Set([
  "coordinate_table_row",
  "coordinate_table_group",
  "coordinate_table_group_inverse",
  "coordinate_table_multicell_row",
  "coordinate_table_membership",
  "parenthetical_group_segment",
  "preceding_question_label",
  "question_continuation_list",
  "exact_numeric_option_segment",
  "exact_hour_alias_segment",
  "visual_table_column",
  "exact_short_label_visual_row",
  "short_label_visual_row",
  "answer_ordinal_row",
  "fibrosis_stage_row",
  "gene_sentence_segment",
  "clinical_feature_segment",
  "mkb_class_exclusion_absent",
  "classification_code_segment",
  "label_number_proximity",
  "label_definition_segment",
  "definition_exact_answer_segment",
  "definition_completion_specificity",
  "row_label_segment",
  "bounded_list_segment",
  "ordinal_list_segment",
  "drug_dose_segment",
  "frequency_polarity_segment",
  "frequency_polarity_list_item",
  "clinical_course_cue_segment",
  "recommendation_block_segment",
  "recommendation_item_segment",
  "explicit_recommendation_target_segment",
  "numeric_condition_less_than",
  "numeric_condition_more_than",
  "numeric_condition_equal",
  "conditioned_number_segment",
  "cloze_gap_local",
]);

/** Широкие evidence-kind: полезны для поиска области, но сами по себе менее надежны. */
export const BROAD_EVIDENCE_KINDS = new Set([
  "bm25_question_answer",
  "question_chunk_answer",
  "answer_chunk_question",
  "answer_window",
  "focused_answer_window",
  "shared_multi_segment",
]);

/** Расширенный список широких evidence-kind для диагностики ошибок. */
export const DIAGNOSTIC_BROAD_EVIDENCE_KINDS = new Set([...BROAD_EVIDENCE_KINDS, "answer_directional_window"]);

/** Шумные shared-evidence сигналы, которые требуют осторожности в multi-selection. */
export const NOISY_SHARED_EVIDENCE_KINDS = new Set(["question_chunk_answer", "bm25_question_answer", "shared_multi_segment"]);

/** Структурные evidence-kind, экспортируемые в обезличенные feature-файлы. */
export const FEATURE_STRUCTURAL_EVIDENCE_KINDS = new Set([
  "coordinate_table_row",
  "visual_table_column",
  "exact_short_label_visual_row",
  "short_label_visual_row",
  "answer_ordinal_row",
  "fibrosis_stage_row",
  "gene_sentence_segment",
  "clinical_feature_segment",
  "mkb_class_exclusion_absent",
  "classification_code_segment",
  "label_number_proximity",
  "label_definition_segment",
  "row_label_segment",
  "bounded_list_segment",
  "ordinal_list_segment",
  "drug_dose_segment",
  "recommendation_block_segment",
  "recommendation_item_segment",
  "explicit_recommendation_target_segment",
  "numeric_condition_less_than",
  "numeric_condition_more_than",
  "numeric_condition_equal",
  "conditioned_number_segment",
  "cloze_gap_local",
]);

/** Префиксы структурных evidence-kind для верхнеуровневой диагностики. */
export const DIAGNOSTIC_STRUCTURAL_EVIDENCE_PREFIXES = [
  "coordinate_",
  "visual_table_",
  "row_label_",
  "bounded_list_",
  "ordinal_",
  "answer_ordinal_",
  "classification_code_",
  "mkb_",
  "gene_sentence_",
  "clinical_feature_",
  "label_definition_",
  "term_definition_",
  "recommendation_item_",
  "explicit_recommendation_",
  "drug_dose_",
  "fibrosis_",
  "count_relation_",
  "cloze_",
];

/** Единый runtime-каталог scorer-ов и их evidence-контрактов. */
export const SCORER_REGISTRY: readonly ScorerRegistryEntry[] = [
  {
    id: "search",
    module: "src/predictor/scorers/search.ts",
    modes: ["single", "multi"],
    evidenceKinds: [
      "question_answer_phrase",
      "answer_after_question",
      "answer_directional_window",
      "answer_window",
      "preceding_question_label",
      "question_anchor_segment",
      "section_list_segment",
      "row_label_segment",
    ],
    purpose: "General phrase, anchor, section, and row-label lookup.",
    risk: "mixed",
  },
  {
    id: "focused",
    module: "src/predictor/scorers/focused.ts",
    modes: ["single", "multi"],
    evidenceKinds: ["focused_answer_window", "line_token_line", "line_token_line_pair"],
    purpose: "Question-focus windows and compact line-token evidence.",
    risk: "broad",
  },
  {
    id: "coordinate-table",
    module: "src/predictor/scorers/coordinate-table.ts",
    modes: ["single", "multi"],
    evidenceKinds: [
      "coordinate_table_membership",
      "coordinate_table_row",
      "coordinate_table_group",
      "coordinate_table_group_inverse",
      "coordinate_table_multicell_row",
      "visual_table_column",
    ],
    purpose: "Coordinate-based table, group, and multi-cell row reconstruction.",
    risk: "structural",
  },
  {
    id: "numeric",
    module: "src/predictor/scorers/numeric.ts",
    modes: ["single", "multi"],
    evidenceKinds: [
      "cloze_gap_local",
      "condition_pair_match",
      "condition_pair_mismatch",
      "exact_numeric_option_segment",
      "exact_hour_alias_segment",
      "condition_number_segment",
      "numeric_condition_less_than",
      "numeric_condition_more_than",
      "numeric_condition_equal",
      "conditioned_number_segment",
      "count_relation_segment",
    ],
    purpose: "Numeric options, local conditions, ranges, counts, and cloze gaps.",
    risk: "mixed",
  },
  {
    id: "direction",
    module: "src/predictor/scorers/direction.ts",
    modes: ["single", "multi"],
    evidenceKinds: [
      "polarity_match",
      "polarity_mismatch",
      "temporal_cue_match",
      "temporal_cue_mismatch",
      "clinical_course_cue_segment",
      "clinical_course_cue_mismatch",
      "modifier_target_mismatch",
      "contrast_cue_mismatch",
      "excluded_condition_mismatch",
    ],
    purpose: "Polarity, temporal, clinical-course, contrast, and excluded-condition adjustments.",
    risk: "adjustment",
  },
  {
    id: "drug-dose",
    module: "src/predictor/scorers/drug-dose.ts",
    modes: ["single"],
    evidenceKinds: ["drug_dose_segment"],
    purpose: "Drug dose/frequency facts, slash-dose order, and component-assigned dose binding.",
    risk: "structural",
  },
  {
    id: "recommendation-item",
    module: "src/predictor/scorers/recommendation-item.ts",
    modes: ["single", "multi"],
    evidenceKinds: [
      "explicit_recommendation_target_segment",
      "explicit_recommendation_target_mismatch",
      "recommendation_block_segment",
      "recommendation_item_segment",
    ],
    purpose: "Narrow recommendation item and explicit target binding.",
    risk: "structural",
  },
  {
    id: "biomedical-symbols",
    module: "src/predictor/scorers/biomedical-symbols.ts",
    modes: ["single", "multi"],
    evidenceKinds: ["latin_fuzzy_ocr", "gene_sentence_segment"],
    purpose: "Latin biomedical tokens, gene symbols, and OCR-lookalike support.",
    risk: "mixed",
  },
  {
    id: "inline-legacy",
    module: "src/predictor.ts",
    modes: ["single", "multi"],
    evidenceKinds: [
      "clinical_feature_segment",
      "label_number_proximity",
      "classification_code_segment",
      "mkb_class_exclusion_absent",
      "bounded_list_segment",
      "ordinal_list_segment",
      "type_ordinal_segment",
      "indication_label_segment",
      "term_definition_segment",
      "definition_exact_answer_segment",
      "definition_completion_specificity",
      "frequency_polarity_list_item",
      "frequency_polarity_segment",
      "label_definition_segment",
      "short_medical_alias_segment",
      "parenthetical_group_segment",
      "question_continuation_list",
      "shared_multi_segment",
      "age_form_segment",
      "roman_stage_segment",
      "answer_ordinal_row",
    ],
    purpose: "Remaining legacy scorers that still live in the orchestration file.",
    risk: "mixed",
  },
];

/** Находит scorer, который объявил поддержку переданного evidence-kind. */
export function scorerForEvidenceKind(kind: string) {
  return SCORER_REGISTRY.find((scorer) => (scorer.evidenceKinds as readonly string[]).includes(kind)) ?? null;
}
