export function isCancelledExitCode(exitCode: number | null | undefined): boolean {
  return exitCode === -2 || exitCode === -3
}
