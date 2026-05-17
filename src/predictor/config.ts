/**
 * Зафиксированная конфигурация predictor, выбранная по результатам
 * измеримых валидационных прогонов.
 */
export const DEFAULT_CONFIG = {
  multiRelativeThreshold: 0.84,
  multiAbsoluteThreshold: 12,
  multiGapThreshold: 0.72,
  multiMinAnswers: 2,
  multiThirdGapThreshold: 0.45,
  multiThirdRelativeThreshold: 0.55,
  frozenFeatureRanker: true,
  multiCardinalityModel: true,
  multiAllOptionsGuard: true,
  multiCrowdedTailGuard: true,
  pairwiseContrastRanker: true,
  structuralClusterAdjustments: true,
  singleSpecificityTieBreak: true,
  singleTieMaxRawGap: 0.2,
  singleTieMinRawRatio: 0.94,
  singleTieSpecificityGap: 0.5,
  sharedMultiSegmentBoost: true,
  countRelationBoost: true,
  topQuestionChunks: 28,
  evidenceLimit: 8,
};

/** Runtime-форма объекта конфигурации predictor. */
export type PredictorConfig = typeof DEFAULT_CONFIG;
