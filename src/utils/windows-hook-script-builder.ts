export type HookInputMode = "stdin" | "argument";

const DEBUG_LOG = `%TEMP%\\ccpoke-hook-debug.log`;

function buildDebugLine(message: string): string {
  return `if defined CCPOKE_DEBUG echo [%DATE% %TIME%] ${message} >> ${DEBUG_LOG}`;
}

export function buildWindowsHookScript(
  version: string,
  port: number,
  route: string,
  secret: string,
  inputMode: HookInputMode = "stdin"
): string {
  const lines = [
    `@REM ccpoke-version: ${version}`,
    `@echo off`,
    `setlocal`,
    `if not defined CCPOKE_HOST set CCPOKE_HOST=localhost`,
    `set TMPFILE=%TEMP%\\ccpoke-%RANDOM%%RANDOM%.json`,
    buildDebugLine(`route=${route} inputMode=${inputMode}`),
  ];

  if (inputMode === "stdin") {
    lines.push(`findstr "^" > %TMPFILE%`);
  } else {
    lines.push(
      `node -e "require('fs').writeFileSync(process.env.TMPFILE,process.argv[1]||'{}')" %*`
    );
    lines.push(buildDebugLine(`arg=written-via-node`));
  }

  lines.push(
    buildDebugLine(`tmpfile=%TMPFILE%`),
    `set TMUX_TARGET=`,
    `if defined TMUX_PANE (`,
    `  for /f "tokens=*" %%a in ('psmux display-message -t "%TMUX_PANE%" -p "#{session_name}:#{window_index}.#{pane_index}" 2^>nul') do set TMUX_TARGET=%%a`,
    `)`,
    `if defined TMUX_TARGET (`,
    `  powershell -NoProfile -Command "$j=Get-Content '%TMPFILE%' -Raw|ConvertFrom-Json; $j|Add-Member -NotePropertyName tmux_target -NotePropertyValue '%TMUX_TARGET%' -Force; $j|ConvertTo-Json -Compress|Set-Content '%TMPFILE%'"`,
    `)`,
    `curl.exe -s -X POST http://%CCPOKE_HOST%:${port}${route} -H "Content-Type: application/json" -H "X-CCPoke-Secret: ${secret}" -d @%TMPFILE% > nul 2>&1`,
    buildDebugLine(`curl_exit=%ERRORLEVEL%`),
    `del %TMPFILE% > nul 2>&1`,
    `endlocal`,
    ``
  );

  return lines.join("\r\n");
}
