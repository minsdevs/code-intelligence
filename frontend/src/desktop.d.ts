export {}

export type RuntimeStatus = {
  ready: boolean
  error: string | null
  services: string[]
  aiOff?: boolean
  recoveryOnly?: boolean
  backupSupported?: boolean
  backupAvailable?: boolean
  restoreAvailable?: boolean
}

export type DesktopRestoreResult =
  | { restored: true; recoveryBackup: string }
  | { restored: false; code: 'BACKUP_INCOMPATIBLE' }

/** A native-dialog folder selection: the one-time grant previews and confirms exactly this root. */
export type FolderGrant = {
  path: string
  grant: string
  expiresAt: string
}

export type DesktopBridge = {
  platform: string
  appVersion: string
  apiBaseUrl: string
  apiToken: string
  pickFolder(): Promise<FolderGrant | null>
  authorizeDroppedFolder(file: File): Promise<FolderGrant | null>
  openExternal(url: string): Promise<void>
  backup(): Promise<string | null>
  restore(): Promise<DesktopRestoreResult | null>
  runtimeStatus(): Promise<RuntimeStatus>
  restartRuntime(): Promise<RuntimeStatus>
}

declare global {
  interface Window {
    codeIntelligenceDesktop?: DesktopBridge
  }
}
