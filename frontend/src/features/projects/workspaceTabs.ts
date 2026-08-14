export type WorkspaceTab = {
  path: string
  label: string
  /** The phase in which this tab's real functionality lands (spec §21). */
  phase: number
  description: string
}

export const workspaceTabs: WorkspaceTab[] = [
  {
    path: 'features',
    label: 'Features',
    phase: 1,
    description: 'Explore the feature tree and linked UI, API, code, DB, and infrastructure.',
  },
  {
    path: 'architecture',
    label: 'Architecture',
    phase: 1,
    description: 'Visualize the architecture graph of the selected area and jump from nodes to code.',
  },
  {
    path: 'flows',
    label: 'Flows',
    phase: 1,
    description: 'Trace call flows step by step and inspect each step’s source location.',
  },
  {
    path: 'code',
    label: 'Code',
    phase: 1,
    description: 'File tree, code viewer, and symbol relationships (callers/callees).',
  },
  {
    path: 'history',
    label: 'History',
    phase: 1,
    description: 'Commit and PR timeline plus structural eras.',
  },
  {
    path: 'analysis',
    label: 'Analysis',
    phase: 1,
    description: 'Findings per area and the impact (reverse dependencies) of a selected node.',
  },
  {
    path: 'notes',
    label: 'Notes',
    phase: 4,
    description: 'Markdown notes that can reference code and commits.',
  },
  {
    path: 'tasks',
    label: 'Tasks',
    phase: 4,
    description: 'Manage tasks linked to analysis results.',
  },
  {
    path: 'review',
    label: 'Review',
    phase: 5,
    description: 'Static findings and AI review comments for pull requests.',
  },
  {
    path: 'playground',
    label: 'Playground',
    phase: 5,
    description: 'Pick files and ask about a hypothesis. Cloned code is never executed.',
  },
  {
    path: 'growth',
    label: 'Growth',
    phase: 5,
    description: 'Report on learning records and task progress.',
  },
]
