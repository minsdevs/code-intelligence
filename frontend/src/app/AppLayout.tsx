import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import AiPanel from './AiPanel'
import { AppQueryProvider } from './queryClient'

export default function AppLayout() {
  return (
    <AppQueryProvider>
      <div className="flex h-full overflow-hidden text-[13px] leading-relaxed">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-surface-0">
          <Outlet />
        </main>
        <AiPanel />
      </div>
    </AppQueryProvider>
  )
}
