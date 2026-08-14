export type WorkspaceTab = {
  path: string
  label: string
  /** 이 탭이 실제 기능을 갖게 되는 Phase (기획서 §21) */
  phase: number
  description: string
}

export const workspaceTabs: WorkspaceTab[] = [
  {
    path: 'features',
    label: 'Features',
    phase: 1,
    description: 'Feature 트리와 연결된 UI·API·코드·DB·Infra를 탐색합니다.',
  },
  {
    path: 'architecture',
    label: 'Architecture',
    phase: 1,
    description: '선택한 영역의 아키텍처 그래프를 시각화하고 노드에서 코드로 이동합니다.',
  },
  {
    path: 'flows',
    label: 'Flows',
    phase: 1,
    description: '호출 흐름을 단계별로 추적하고 각 step의 source location을 확인합니다.',
  },
  {
    path: 'code',
    label: 'Code',
    phase: 1,
    description: '파일 트리·코드 뷰어·심볼 관계(callers/callees)를 제공합니다.',
  },
  {
    path: 'history',
    label: 'History',
    phase: 1,
    description: 'Commit·PR 타임라인과 구조 변천(era)을 봅니다.',
  },
  {
    path: 'analysis',
    label: 'Analysis',
    phase: 1,
    description: '영역별 findings와 선택한 노드의 Impact(역방향 의존)를 확인합니다.',
  },
  {
    path: 'notes',
    label: 'Notes',
    phase: 4,
    description: '코드·커밋 참조가 가능한 마크다운 노트를 작성합니다.',
  },
  {
    path: 'tasks',
    label: 'Tasks',
    phase: 4,
    description: '분석 결과와 연결된 Task를 관리합니다.',
  },
]
