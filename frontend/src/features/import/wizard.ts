export const WIZARD_STEPS = [
  { id: 'connect', label: 'Connect' },
  { id: 'repo', label: 'Repository' },
  { id: 'progress', label: 'Progress' },
] as const

export type WizardStepId = (typeof WIZARD_STEPS)[number]['id']

export const PIPELINE_STEPS = [
  { key: 'IMPORT', label: 'Import' },
  { key: 'FILE_INVENTORY', label: 'File inventory' },
  { key: 'LANGUAGE_FRAMEWORK', label: 'Language / framework' },
  { key: 'AREA_DETECTION', label: 'Area detection' },
  { key: 'FINALIZE', label: 'Finalize' },
] as const

export { AREA_LABELS } from '../areas/labels'

export function pipelineLabel(stepKey: string): string {
  const known = PIPELINE_STEPS.find((step) => step.key === stepKey)
  return known?.label ?? stepKey
}
