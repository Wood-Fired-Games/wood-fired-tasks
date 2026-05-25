# Rename Identity Brief (#287)

Canonical names + the (small) first-public-release steps. Because the project is
private and never published, there is **no old-name handling policy to design** —
the old name simply goes away. The only forward action is claiming the new
identity when the repo first goes public.

## Canonical identity (decided)

| Facet | Old | New |
|-------|-----|-----|
| Product name | Wood Fired Bugs | **Wood Fired Tasks** |
| Repo slug | `Wood-Fired-Games/wood-fired-bugs` (private) | `Wood-Fired-Games/wood-fired-tasks` |
| npm package | `wood-fired-bugs` (never published) | `wood-fired-tasks` |
| CLI binary | `tasks` | `tasks` (**unchanged** — already neutral) |
| MCP server name | `wood-fired-bugs` | `wood-fired-tasks` |
| Install path | `/opt/wood-fired-bugs` | `/opt/wood-fired-tasks` |
| Config dir | `~/.config/wood-fired-bugs/` | `~/.config/wood-fired-tasks/` |
| Runtime env prefix | `WFB_*` | `WFT_*` |
| Installer env prefix | `WOOD_FIRED_BUGS_*` | `WOOD_FIRED_TASKS_*` |

## Availability (verified 2026-05-25)

- npm `wood-fired-tasks` — **free** (404).
- GitHub `Wood-Fired-Games/wood-fired-tasks` — rename-in-place of the existing
  private repo (no slug collision expected; confirm at execution).

## First-public-release steps (whenever the repo goes public)

- [ ] Rename the private GitHub repo in place (don't create a new one).
- [ ] Publish `wood-fired-tasks` to npm at first public release (if publishing).
- [ ] No deprecation of `wood-fired-bugs` needed — it was never published.

That's the whole of #287 under the clean-break decision. No trademark/typosquat
reservation work is warranted for a single-user pre-public project; revisit only
if it later gains real public traction.
