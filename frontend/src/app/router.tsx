import { Navigate, type RouteObject } from 'react-router-dom'
import AppLayout from './AppLayout'
import HomePage from '../features/home/HomePage'
import HistoryPage from '../features/history/HistoryPage'
import CodeTab from '../features/code/CodeTab'
import ArchitectureTab from '../features/architecture/ArchitectureTab'
import FeaturesTab from '../features/features/FeaturesTab'
import FlowsTab from '../features/flows/FlowsTab'
import AnalysisTab from '../features/analysis/AnalysisTab'
import NotesTab from '../features/notes/NotesTab'
import TasksTab from '../features/tasks/TasksTab'
import ReviewTab from '../features/review/ReviewTab'
import PlaygroundTab from '../features/playground/PlaygroundTab'
import RepositoryOverviewPage from '../features/projects/RepositoryOverviewPage'
import ProjectsPage from '../features/projects/ProjectsPage'
import ProjectWorkspacePage from '../features/projects/ProjectWorkspacePage'
import WorkspaceTabPage from '../features/projects/WorkspaceTabPage'
import { workspaceTabs } from '../features/projects/workspaceTabs'
import SearchPage from '../features/search/SearchPage'
import SettingsPage from '../features/settings/SettingsPage'
import ImportWizardPage from '../features/import/ImportWizardPage'

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'import', element: <ImportWizardPage /> },
      { path: 'projects', element: <ProjectsPage /> },
      {
        path: 'projects/:projectId',
        element: <ProjectWorkspacePage />,
        children: [
          { index: true, element: <Navigate to="overview" replace /> },
          { path: 'growth', element: <Navigate to="../overview" replace /> },
          ...workspaceTabs.map((tab) => ({
            path: tab.path,
            element:
              tab.path === 'overview' ? (
                <RepositoryOverviewPage />
              ) : tab.path === 'history' ? (
                <HistoryPage />
              ) : tab.path === 'code' ? (
                <CodeTab />
              ) : tab.path === 'architecture' ? (
                <ArchitectureTab />
              ) : tab.path === 'features' ? (
                <FeaturesTab />
              ) : tab.path === 'flows' ? (
                <FlowsTab />
              ) : tab.path === 'analysis' ? (
                <AnalysisTab />
              ) : tab.path === 'notes' ? (
                <NotesTab />
              ) : tab.path === 'tasks' ? (
                <TasksTab />
              ) : tab.path === 'review' ? (
                <ReviewTab />
              ) : tab.path === 'playground' ? (
                <PlaygroundTab />
              ) : (
                <WorkspaceTabPage tab={tab} />
              ),
          })),
        ],
      },
      { path: 'search', element: <SearchPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]
