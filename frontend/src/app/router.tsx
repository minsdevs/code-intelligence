import { Navigate, type RouteObject } from 'react-router-dom'
import AppLayout from './AppLayout'
import HomePage from '../features/home/HomePage'
import HistoryPage from '../features/history/HistoryPage'
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
          { index: true, element: <Navigate to="features" replace /> },
          ...workspaceTabs.map((tab) => ({
            path: tab.path,
            element: tab.path === 'history' ? <HistoryPage /> : <WorkspaceTabPage tab={tab} />,
          })),
        ],
      },
      { path: 'search', element: <SearchPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]
