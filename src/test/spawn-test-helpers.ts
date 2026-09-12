import { spawn } from 'node:child_process'
import type { TestContext } from 'node:test'

let cachedSpawnSupport: Promise<boolean> | undefined

export async function ensureSpawnAvailable(
  context: TestContext,
  reason = 'child process execution is unavailable in this environment',
): Promise<void> {
  if (!(await canSpawnChildProcesses())) {
    context.skip(reason)
  }
}

async function canSpawnChildProcesses(): Promise<boolean> {
  cachedSpawnSupport ??= new Promise<boolean>((resolve) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
      windowsHide: true,
    })

    child.once('error', () => {
      resolve(false)
    })

    child.once('exit', () => {
      resolve(true)
    })
  })

  return cachedSpawnSupport
}
