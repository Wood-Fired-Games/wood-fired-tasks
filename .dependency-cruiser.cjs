// Boundary policy: docs/CODE_QUALITY_ROADMAP.md Phase 4.
// Layer order (high -> low): api/cli/mcp/slack -> services -> events ->
// repositories -> db. schemas/types/utils/config are leaves any layer may use.
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'No import cycles within src/.',
      from: { path: '^src' },
      to: { circular: true },
    },
    {
      name: 'leaves-no-upstream',
      severity: 'error',
      comment: 'src/db, src/types, src/schemas must not import entry-point or business-logic layers.',
      from: { path: '^src/(db|types|schemas)/' },
      to: { path: '^src/(api|cli|mcp|slack|services|events|repositories)/' },
    },
    {
      name: 'repositories-layer',
      severity: 'error',
      comment: 'src/repositories may only import db, types, schemas, utils, config, and other repositories.',
      from: { path: '^src/repositories/' },
      to: {
        path: '^src/',
        pathNot: '^src/(repositories|db|types|schemas|utils|config)/',
      },
    },
    {
      name: 'events-layer',
      severity: 'error',
      comment: 'src/events may import schemas, types, utils, config — not entry points, services, or repositories.',
      from: { path: '^src/events/' },
      to: { path: '^src/(api|cli|mcp|slack|services|repositories)/' },
    },
    {
      name: 'services-layer',
      severity: 'error',
      comment: 'src/services must not import entry-point layers (api, cli, mcp, slack).',
      from: { path: '^src/services/' },
      to: { path: '^src/(api|cli|mcp|slack)/' },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(__tests__/|\\.test\\.ts$|\\.bench\\.ts$|dist/)' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node'],
    },
  },
};
