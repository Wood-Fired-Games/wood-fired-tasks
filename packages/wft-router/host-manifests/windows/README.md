# Running wft-router as a Windows service

`wft-router` is a long-running Node.js console application, not a native Windows
service binary. The pragmatic way to supervise it as a Windows service is a
service wrapper — **[nssm](https://nssm.cc/) (the Non-Sucking Service Manager)**
is recommended; [winsw](https://github.com/winsw/winsw) is an equivalent
alternative. Plain `sc.exe` is documented at the end, but it expects a real
service binary that implements the Service Control Manager protocol, which a
console app does not — so `sc.exe` alone will not cleanly supervise wft-router.

These are **examples**. Adjust every path to your install.

## Resolved config / state / data paths (Windows)

The path resolver (`packages/wft-router/src/paths/index.ts`, design doc §6)
resolves on Windows to:

| Purpose | Default location |
|---------|------------------|
| config  | `%APPDATA%\wft-router`          (e.g. `C:\Users\<you>\AppData\Roaming\wft-router`) |
| state   | `%LOCALAPPDATA%\wft-router\state` (e.g. `C:\Users\<you>\AppData\Local\wft-router\state`) |
| data    | `%LOCALAPPDATA%\wft-router\data`  (e.g. `C:\Users\<you>\AppData\Local\wft-router\data`) |

`%APPDATA%` / `%LOCALAPPDATA%` are evaluated for the account the service runs
as. A service running under `LocalSystem` resolves these under
`C:\Windows\System32\config\systemprofile\AppData\...`, which is usually not what
you want — either run the service under a dedicated user account, or pin the
locations explicitly with the absolute-path overrides:

- `WFT_ROUTER_CONFIG`
- `WFT_ROUTER_STATE_DIR`
- `WFT_ROUTER_DATA_DIR`

## Option A — nssm (recommended)

1. Download nssm from <https://nssm.cc/download> and place `nssm.exe` somewhere
   on `PATH` (or call it by full path).

2. Install the service. Point it at your `node.exe` and the wft-router
   entrypoint. For a global npm install (`npm i -g @wood-fired-games/wft-router`)
   the entrypoint lives under the global `node_modules`; for a checkout it is
   `dist\bin\wft-router.js`.

   ```bat
   nssm install wft-router "C:\Program Files\nodejs\node.exe" ^
     "C:\path\to\wft-router\dist\bin\wft-router.js" --metrics-port 9464
   ```

3. Set the working directory and environment. `AppDirectory` should exist; the
   `AppEnvironmentExtra` lines inject the runtime config (one `KEY=value` per
   invocation; repeat the command for each, or pass them space-separated).

   ```bat
   nssm set wft-router AppDirectory "C:\path\to\wft-router"

   nssm set wft-router AppEnvironmentExtra ^
     WFT_ROUTER_ENDPOINT=https://tasks.example.com ^
     WFT_ROUTER_TOKEN=replace-me ^
     LOG_LEVEL=info

   :: Optional: pin config/state/data instead of relying on %APPDATA%.
   nssm set wft-router AppEnvironmentExtra ^
     WFT_ROUTER_CONFIG=C:\ProgramData\wft-router ^
     WFT_ROUTER_STATE_DIR=C:\ProgramData\wft-router\state ^
     WFT_ROUTER_DATA_DIR=C:\ProgramData\wft-router\data
   ```

   > `WFT_ROUTER_TOKEN` is a secret. Prefer setting it interactively
   > (`nssm edit wft-router`) or via a provisioning tool rather than committing
   > it to a script.

4. Redirect stdout/stderr to log files (nssm creates the files but not parent
   directories — create the folder first).

   ```bat
   mkdir C:\ProgramData\wft-router\logs
   nssm set wft-router AppStdout C:\ProgramData\wft-router\logs\wft-router.out.log
   nssm set wft-router AppStderr C:\ProgramData\wft-router\logs\wft-router.err.log
   ```

5. Restart-on-failure. nssm restarts the app automatically when it exits; tune
   the throttle so a crash loop backs off instead of hammering.

   ```bat
   :: Action on app exit: Restart (default). Make it explicit:
   nssm set wft-router AppExit Default Restart
   :: Wait 10s (10000 ms) before declaring an exit a "throttle" event:
   nssm set wft-router AppThrottle 10000
   :: Optional: run under a dedicated account so %APPDATA% resolves sanely.
   :: nssm set wft-router ObjectName ".\wft-router-svc" "<password>"
   ```

6. Start it.

   ```bat
   nssm start wft-router
   nssm status wft-router
   ```

   Manage later with `nssm restart wft-router`, `nssm stop wft-router`,
   `nssm edit wft-router` (GUI), and remove with `nssm remove wft-router confirm`.

## Option B — sc.exe (not recommended for this app)

`sc.exe` is built into Windows and can register a service, but it expects the
target executable to be a true Windows service that talks to the Service Control
Manager. `node.exe wft-router.js` is a plain console process, so a bare
`sc create` service will start and then immediately be reported as failed
("did not respond to the start request in a timely fashion"). Use nssm or winsw
to wrap it. The command below is shown only for completeness / for wrapping a
helper that *does* implement the SCM protocol:

```bat
sc.exe create wft-router ^
  binPath= "\"C:\Program Files\nodejs\node.exe\" \"C:\path\to\wft-router\dist\bin\wft-router.js\" --metrics-port 9464" ^
  start= auto ^
  DisplayName= "Wood Fired Tasks event router"

:: Environment variables for an sc.exe service must be set machine-wide
:: (setx /M) or via the service account profile, since sc.exe has no
:: per-service env injection like nssm's AppEnvironmentExtra:
setx /M WFT_ROUTER_ENDPOINT https://tasks.example.com
setx /M LOG_LEVEL info
:: (Set WFT_ROUTER_TOKEN out-of-band; avoid putting secrets in setx history.)

:: Restart-on-failure via the recovery actions:
sc.exe failure wft-router reset= 86400 actions= restart/10000/restart/10000/restart/10000

sc.exe start wft-router
sc.exe query wft-router
```

Remove with `sc.exe delete wft-router`.

## Verifying

Once running, if you passed `--metrics-port 9464`, the Prometheus metrics
endpoint is reachable at `http://127.0.0.1:9464/metrics`. Check the configured
log files (or Event Viewer for sc.exe service start failures) for startup
diagnostics.
