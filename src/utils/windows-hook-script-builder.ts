export function buildWindowsHookScript(
  version: string,
  port: number,
  route: string,
  secret: string
): string {
  return [
    `@REM ccpoke-version: ${version}`,
    `@echo off`,
    `setlocal`,
    `if not defined CCPOKE_HOST set CCPOKE_HOST=localhost`,
    `set TMPFILE=%TEMP%\\ccpoke-%RANDOM%%RANDOM%.json`,
    `findstr "^" > %TMPFILE%`,
    `curl -s -X POST http://%CCPOKE_HOST%:${port}${route} -H "Content-Type: application/json" -H "X-CCPoke-Secret: ${secret}" -d @%TMPFILE% > nul 2>&1`,
    `del %TMPFILE% > nul 2>&1`,
    `endlocal`,
    ``,
  ].join("\r\n");
}
