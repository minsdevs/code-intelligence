export {}

export type RuntimeStatus = {
  ready: boolean
  error: string | null
  services: string[]
  backupAvailable?: boolean
  restoreAvailable?: boolean
}

export type DesktopBridge = {
  platform: string
  appVersion: string
  apiBaseUrl: string
  apiToken: string
  pickFolder(): Promise<string | null>
  authorizeDroppedFolder(file: File): Promise<string | null>
  openExternal(url: string): Promise<void>
  backup(): Promise<string | null>
  restore(): Promise<{ restored: boolean; recoveryBackup: string } | null>
  runtimeStatus(): Promise<RuntimeStatus>
  restartRuntime(): Promise<RuntimeStatus>
}

declare global {
  interface Window {
    codeIntelligenceDesktop?: DesktopBridge
  }
}
