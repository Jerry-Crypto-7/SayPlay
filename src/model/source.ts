/** Odkud pochází dokument, který právě běží na plátně. */
export type EmissionSource = 'frozen' | 'recognizer' | 'model' | 'substitute';

export const SOURCE_LABEL: Readonly<Record<EmissionSource, string>> = {
  frozen: 'frozen corpus',
  recognizer: 'recognizer',
  model: 'browser model',
  substitute: 'substitute room',
};
