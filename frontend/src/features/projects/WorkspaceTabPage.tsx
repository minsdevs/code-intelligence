import EmptyState from '../../components/EmptyState'
import type { WorkspaceTab } from './workspaceTabs'

export default function WorkspaceTabPage({ tab }: { tab: WorkspaceTab }) {
  return <EmptyState title={tab.label} description={tab.description} phase={tab.phase} />
}
