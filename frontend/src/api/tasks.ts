import { apiGet, apiSend } from './client'
import type { GeneratedTask, LearningRecordView, TaskGoalView, TaskType, TaskView } from './types'

export function listTasks(projectId: number, includeDrafts = false): Promise<TaskView[]> {
  const query = includeDrafts ? '?includeDrafts=true' : ''
  return apiGet<TaskView[]>(`/api/projects/${projectId}/tasks${query}`)
}

export function getTask(projectId: number, taskId: number): Promise<TaskView> {
  return apiGet<TaskView>(`/api/projects/${projectId}/tasks/${taskId}`)
}

export function createTask(
  projectId: number,
  body: { type: TaskType; title: string; description?: string; goals?: string[] },
): Promise<TaskView> {
  return apiSend<TaskView>(`/api/projects/${projectId}/tasks`, { method: 'POST', body })
}

export function updateTask(
  projectId: number,
  taskId: number,
  body: {
    type?: TaskType
    title?: string
    description?: string
    status?: string
    goals?: string[]
  },
): Promise<TaskView> {
  return apiSend<TaskView>(`/api/projects/${projectId}/tasks/${taskId}`, { method: 'PUT', body })
}

export function approveTask(projectId: number, taskId: number): Promise<TaskView> {
  return apiSend<TaskView>(`/api/projects/${projectId}/tasks/${taskId}/approve`, { method: 'POST' })
}

export function patchTaskGoal(
  projectId: number,
  taskId: number,
  goalId: number,
  body: { done?: boolean; content?: string },
): Promise<TaskGoalView> {
  return apiSend<TaskGoalView>(`/api/projects/${projectId}/tasks/${taskId}/goals/${goalId}`, {
    method: 'PATCH',
    body,
  })
}

export function addLearningRecord(
  projectId: number,
  taskId: number,
  note: string,
): Promise<LearningRecordView> {
  return apiSend<LearningRecordView>(`/api/projects/${projectId}/tasks/${taskId}/records`, {
    method: 'POST',
    body: { note },
  })
}

export function createTaskDraft(projectId: number, findingId: number): Promise<GeneratedTask> {
  return apiSend<GeneratedTask>(`/api/projects/${projectId}/findings/${findingId}/task-draft`, {
    method: 'POST',
  })
}
