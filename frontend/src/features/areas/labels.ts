export const AREA_LABELS: Record<string, string> = {
  BACKEND: 'Backend',
  FRONTEND: 'Frontend',
  MOBILE: 'Mobile',
  DATABASE: 'Database',
  INFRASTRUCTURE: 'Infrastructure',
  DEVOPS: 'DevOps',
  SECURITY: 'Security',
  TESTING: 'Testing',
  AI_ML: 'AI / ML',
  DOCUMENTATION: 'Documentation',
  BUILD_TOOLING: 'Build tooling',
  OTHER: 'Other',
}

export function areaLabel(areaType: string): string {
  return AREA_LABELS[areaType] ?? areaType
}
