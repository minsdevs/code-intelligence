import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import {
  addLearningRecord,
  approveTask,
  createTask,
  listTasks,
  patchTaskGoal,
} from '../../api/tasks'
import type { TaskStatus, TaskType, TaskView } from '../../api/types'
import EmptyState from '../../components/EmptyState'
import { parseProjectId } from '../../lib/projectId'
import { useUiStore } from '../../stores/uiStore'
import { queryError } from '../code/codeLocation'

const TYPES: TaskType[] = ['DEVELOPMENT', 'LEARNING', 'REVIEW', 'RESEARCH', 'REFACTORING']

export default function TasksPage() {
  const { projectId: rawId } = useParams()
  const projectId = parseProjectId(rawId)
  const queryClient = useQueryClient()
  const setFocusedTaskId = useUiStore((state) => state.setFocusedTaskId)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [newType, setNewType] = useState<TaskType>('DEVELOPMENT')
  const [recordNote, setRecordNote] = useState('')

  const listQuery = useQuery({
    queryKey: ['tasks', projectId],
    queryFn: () => listTasks(projectId!, true),
    enabled: projectId != null,
  })
  const tasks = listQuery.data ?? []
  const resolvedId =
    selectedId != null && tasks.some((task) => task.id === selectedId)
      ? selectedId
      : (tasks[0]?.id ?? null)
  const active = tasks.find((task) => task.id === resolvedId) ?? null

  useEffect(() => {
    setFocusedTaskId(resolvedId)
    return () => setFocusedTaskId(null)
  }, [resolvedId, setFocusedTaskId])

  const createMutation = useMutation({
    mutationFn: () => createTask(projectId!, { type: newType, title: newTitle }),
    onSuccess: async (task) => {
      setNewTitle('')
      setSelectedId(task.id)
      await queryClient.invalidateQueries({ queryKey: ['tasks', projectId] })
    },
  })

  const approveMutation = useMutation({
    mutationFn: () => approveTask(projectId!, active!.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['tasks', projectId] })
    },
  })

  const goalMutation = useMutation({
    mutationFn: (goal: { id: number; done: boolean }) =>
      patchTaskGoal(projectId!, active!.id, goal.id, { done: goal.done }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['tasks', projectId] })
    },
  })

  const recordMutation = useMutation({
    mutationFn: () => addLearningRecord(projectId!, active!.id, recordNote),
    onSuccess: async () => {
      setRecordNote('')
      await queryClient.invalidateQueries({ queryKey: ['tasks', projectId] })
    },
  })

  const listError = queryError(listQuery.error)
  const grouped = groupTasks(tasks)

  if (projectId == null) {
    return <EmptyState title="Tasks" description="import한 프로젝트에서 Task를 관리합니다." />
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <section className="flex w-80 shrink-0 flex-col border-r border-line">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-[13px] font-semibold text-ink">Tasks</h2>
          <form
            className="mt-2 flex gap-1"
            onSubmit={(event) => {
              event.preventDefault()
              if (newTitle.trim()) createMutation.mutate()
            }}
          >
            <select
              aria-label="Task 유형"
              value={newType}
              onChange={(event) => setNewType(event.target.value as TaskType)}
              className="rounded-md border border-line bg-surface-2 px-1 py-1 font-mono text-[11px] text-ink"
            >
              {TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <input
              aria-label="새 Task 제목"
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
              placeholder="새 Task"
              className="min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-2 py-1 text-[12px] text-ink"
            />
            <button
              type="submit"
              disabled={!newTitle.trim() || createMutation.isPending}
              className="rounded-md border border-line-strong bg-surface-2 px-2 py-1 text-[12px] text-ink disabled:opacity-60"
            >
              추가
            </button>
          </form>
        </div>
        {listError && (
          <p role="alert" className="px-4 py-2 text-[12px] text-danger">
            {listError}
          </p>
        )}
        {listQuery.isLoading && (
          <p className="px-4 py-3 text-[13px] text-ink-muted">Task를 불러오는 중…</p>
        )}
        {!listQuery.isLoading && tasks.length === 0 && (
          <p className="px-4 py-3 text-[13px] text-ink-muted">등록된 Task가 없습니다.</p>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          {(['DRAFT', 'OPEN', 'DONE', 'CANCELLED'] as TaskStatus[]).map((status) => {
            const items = grouped[status]
            if (items.length === 0) return null
            return (
              <div key={status}>
                <p className="px-4 pt-3 font-mono text-[10px] uppercase tracking-wide text-ink-faint">
                  {status}
                </p>
                <ul>
                  {items.map((task) => {
                    const activeItem = task.id === resolvedId
                    return (
                      <li key={task.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedId(task.id)}
                          className={`w-full px-4 py-2 text-left ${activeItem ? 'bg-surface-3' : 'hover:bg-surface-2'}`}
                        >
                          <span className="block text-[13px] text-ink">{task.title}</span>
                          <span className="font-mono text-[11px] text-ink-faint">
                            {task.type} · {task.origin}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )
          })}
        </div>
      </section>
      <section className="min-w-0 flex-1 overflow-auto px-5 py-4">
        {!active ? (
          <p className="text-[13px] text-ink-muted">Task를 선택하세요.</p>
        ) : (
          <>
            <p className="font-mono text-[11px] text-ink-faint">
              {active.status} · {active.type} · {active.origin}
            </p>
            <h3 className="mt-1 text-[15px] font-semibold text-ink">{active.title}</h3>
            <p className="mt-2 whitespace-pre-wrap text-[13px] text-ink-muted">
              {active.description || '설명이 없습니다.'}
            </p>
            {active.status === 'DRAFT' && active.origin === 'AI' && (
              <button
                type="button"
                onClick={() => approveMutation.mutate()}
                className="mt-3 rounded-md border border-line-strong bg-surface-2 px-3 py-1.5 text-[12px] text-ink"
              >
                초안 승인
              </button>
            )}
            <h4 className="mt-5 text-[12px] font-semibold text-ink">체크리스트</h4>
            {active.goals.length === 0 ? (
              <p className="mt-1 text-[13px] text-ink-muted">목표가 없습니다.</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {active.goals.map((goal) => (
                  <li key={goal.id}>
                    <label className="flex items-start gap-2 text-[13px] text-ink">
                      <input
                        type="checkbox"
                        checked={goal.done}
                        onChange={(event) =>
                          goalMutation.mutate({ id: goal.id, done: event.target.checked })
                        }
                      />
                      <span className={goal.done ? 'text-ink-muted line-through' : undefined}>
                        {goal.content}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <h4 className="mt-5 text-[12px] font-semibold text-ink">학습 기록</h4>
            <ul className="mt-2 space-y-1">
              {active.records.map((record) => (
                <li key={record.id} className="text-[13px] text-ink-muted">
                  {record.note}
                </li>
              ))}
            </ul>
            <form
              className="mt-2 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (recordNote.trim()) recordMutation.mutate()
              }}
            >
              <input
                aria-label="학습 기록"
                value={recordNote}
                onChange={(event) => setRecordNote(event.target.value)}
                placeholder="배운 점"
                className="min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-2 py-1 text-[13px] text-ink"
              />
              <button
                type="submit"
                disabled={!recordNote.trim() || recordMutation.isPending}
                className="rounded-md border border-line-strong bg-surface-2 px-3 py-1.5 text-[12px] text-ink disabled:opacity-60"
              >
                기록
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  )
}

function groupTasks(tasks: TaskView[]): Record<TaskStatus, TaskView[]> {
  const grouped: Record<TaskStatus, TaskView[]> = {
    DRAFT: [],
    OPEN: [],
    DONE: [],
    CANCELLED: [],
  }
  for (const task of tasks) grouped[task.status].push(task)
  return grouped
}
