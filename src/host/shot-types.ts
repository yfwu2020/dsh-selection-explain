import type { Config } from './config.js'

export type ShotScope = 'screen' | 'window' | 'margin' | 'selection'
export type ShotMode = 'card' | 'panel'
export interface ShotRect { x: number; y: number; width: number; height: number }
export interface ShotPending {
  id: string
  at: number
  scope: ShotScope
  mode: ShotMode
  frame: boolean
  imagePath: string
  /** Selection relative to the final image, in pixels. */
  rect: ShotRect
  windowRect: ShotRect
  selectionRect: ShotRect
  scale: number
  pad: { x: number; y: number }
  owner: string
  ready: boolean
}
export interface ShotError { code: string; message: string; at: number }
export interface ShotStatus { available: boolean; reason: string; capturing: boolean; total: number; lastError: string }
export type ShotConfig = Pick<Config, 'shotCardScope' | 'shotPanelScope' | 'shotMargin'>
export interface ShotOptions { seq: number; mode: ShotMode; scope: ShotScope; margin: number }
export interface WinInfo { id: number; x: number; y: number; w: number; h: number; layer: number; owner: string }
export interface DisplayInfo { id: number; x: number; y: number; w: number; h: number; index: number; main: boolean }
export interface ImageSize { w: number; h: number }
export interface CropBox { left: number; top: number; width: number; height: number }
export interface CommandResult {
  stdout: string
  stderr: string
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  failed: boolean
}
export type CommandRunner = (command: string, args: string[], signal: AbortSignal, timeout?: number, env?: NodeJS.ProcessEnv) => Promise<CommandResult>
/** Only this port touches the machine; tests supply inert files and capture commands. */
export interface ShotPlatform {
  supported(): boolean
  probeAvailable(signal: AbortSignal): Promise<boolean>
  listWindows(signal: AbortSignal): Promise<WinInfo[]>
  listDisplays(signal: AbortSignal): Promise<DisplayInfo[]>
  createTempDir(): Promise<string>
  remove(path: string, recursive?: boolean): Promise<void>
  prune(dir: string, seq: number): Promise<void>
  readFile(path: string): Promise<Buffer>
  fileExists(path: string): Promise<boolean>
  pngSize(path: string): Promise<ImageSize | null>
  rectFromXattr(path: string, signal: AbortSignal): Promise<ShotRect | null>
  /** Await already-aborted machine commands before deleting their output directory. */
  settle?(): Promise<void>
  run: CommandRunner
}
export const CAPTURE = '/usr/sbin/screencapture'
export const SELECT_TIMEOUT_MS = 90_000
export const MAX_MARGIN_PT = 400
export const DEFAULT_SHOT_CONFIG: ShotConfig = { shotCardScope: 'window', shotPanelScope: 'selection', shotMargin: 48 }
