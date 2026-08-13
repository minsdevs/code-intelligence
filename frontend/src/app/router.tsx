import { Navigate, type RouteObject } from 'react-router-dom'
import AppLayout from './AppLayout'
import HomePage from '../features/home/HomePage'
import ProjectsPage from '../features/projects/ProjectsPage'
import ProjectWorkspacePage from '../features/projects/ProjectWorkspacePage'
import WorkspaceTabPage from '../features/projects/WorkspaceTabPage'
import { workspaceTabs } from '../features/projects/workspaceTabs'
import SearchPage from '../features/search/SearchPage'
import SettingsPage from '../features/settings/SettingsPage'

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'projects', element: <ProjectsPage /> },
      {
        path: 'projects/:projectId',
        element: <ProjectWorkspacePage />,
        children: [
          { index: true, element: <Navigate to="features" replace /> },
          ...workspaceTabs.map((tab) => ({
            path: tab.path,
            element: <WorkspaceTabPage tab={tab} />,
          })),
        ],
      },
      { path: 'search', element: <SearchPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]
