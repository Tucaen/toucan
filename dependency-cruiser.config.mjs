const source = '(^|/)src/'
const shared = `${source}shared/`
const main = `${source}main/`
const preload = `${source}preload/`
const renderer = `${source}renderer/src/`
// The mobile companion is served by the host over HTTP, not loaded into a privileged process, so
// it may read shared contracts and nothing else of Toucan's.
const mobile = '(^|/)mobile/'

// These are the pure decision modules named by docs/architecture.md. The list is explicit because
// other renderer .ts files intentionally own React contexts, browser APIs, or orchestration.
const pureRendererFeatureNames = [
  'brain-dump-links',
  'brain-dump-panel-layout',
  'brain-dump-topics',
  'chat-scroll-follow',
  'composer-autosize',
  'composer-keys',
  'completion-token',
  'decision-message',
  'file-mention-completion',
  'file-node',
  'file-operation',
  'image-attachment-contract',
  'mcp-tool-call',
  'node-picker-menu-position',
  'pending-decisions',
  'plan-update',
  'prompt-history',
  'prompt-outbox',
  'search-navigation',
  'session-usage',
  'shell-execution',
  'slash-command-completion',
  'terminal-liveness',
  'ticket-activity',
  'ticket-board',
  'ticket-board-layout',
  'tool-card',
  'tool-input',
  'worklog-activities',
  'worktree-removal'
]
const rendererFeaturePattern = (names) => `${renderer}(${names.join('|')})\\.ts$`
const pureRendererFeatures = rendererFeaturePattern(pureRendererFeatureNames)
const pureRendererFeaturesExceptFileOperation = rendererFeaturePattern(
  pureRendererFeatureNames.filter((name) => name !== 'file-operation')
)

export default {
  forbidden: [
    {
      name: 'no-circular-dependencies',
      comment: 'Dependency cycles obscure module ownership and make the documented direction unenforceable.',
      severity: 'error',
      from: {},
      to: { circular: true }
    },
    {
      name: 'shared-does-not-import-application-layers',
      severity: 'error',
      from: { path: shared },
      to: { path: `(${main}|${preload}|${renderer})` }
    },
    {
      name: 'shared-has-no-runtime-dependencies',
      comment: 'Shared code is runtime-neutral. Type-only external contracts remain allowed.',
      severity: 'error',
      from: { path: shared },
      to: {
        path: '(^|/)node_modules/(electron|react)/',
        dependencyTypesNot: ['type-only']
      }
    },
    {
      name: 'shared-does-not-import-node-runtime',
      severity: 'error',
      from: { path: shared },
      to: { dependencyTypes: ['core'] }
    },
    {
      name: 'main-does-not-import-preload-or-renderer',
      severity: 'error',
      from: { path: main },
      to: { path: `(${preload}|${renderer})` }
    },
    {
      name: 'preload-does-not-import-main-or-renderer',
      comment: 'Preload may import shared contracts and Electron, but not process implementations or UI.',
      severity: 'error',
      from: { path: preload },
      to: { path: `(${main}|${renderer})` }
    },
    {
      name: 'preload-only-imports-electron-externally',
      comment: 'Electron is the sole runtime package required by the context-isolated bridge.',
      severity: 'error',
      from: { path: preload },
      to: { dependencyTypes: ['npm'], pathNot: '(^|/)node_modules/electron/' }
    },
    {
      name: 'renderer-does-not-import-privileged-layers',
      comment: 'The preload declaration file is allowed; the runtime implementation and main process are not.',
      severity: 'error',
      from: { path: renderer },
      to: { path: `(${main}|${source}preload/index\\.ts$|(^|/)node_modules/electron/)` }
    },
    {
      name: 'renderer-does-not-import-node-runtime',
      severity: 'error',
      from: { path: renderer },
      to: { dependencyTypes: ['core'] }
    },
    {
      name: 'pure-renderer-features-do-not-import-impure-modules',
      comment:
        'Pure decisions may be consumed by views/orchestration; runtime imports of them or preload APIs reverse the dependency.',
      severity: 'error',
      from: { path: pureRendererFeatures },
      to: {
        path: `(${renderer}|${preload})`,
        pathNot: pureRendererFeatures
      }
    },
    {
      name: 'pure-renderer-features-do-not-import-externals',
      severity: 'error',
      from: { path: pureRendererFeaturesExceptFileOperation },
      to: { dependencyTypes: ['npm'] }
    },
    {
      name: 'file-operation-only-imports-diff',
      comment: 'Exception: file-operation uses the browser-safe diff package for its pure presentation model.',
      severity: 'error',
      from: { path: `${renderer}file-operation\\.ts$` },
      to: { dependencyTypes: ['npm'], pathNot: '(^|/)node_modules/diff/' }
    },
    {
      name: 'mobile-only-imports-shared-contracts',
      comment:
        'The mobile client runs in a phone browser and reaches the host over HTTP. Importing a main, preload or renderer module would put privileged code in a page anyone on the tailnet can load.',
      severity: 'error',
      from: { path: mobile },
      to: { path: `(${main}|${preload}|${renderer})` }
    },
    {
      name: 'mobile-does-not-import-node-runtime',
      severity: 'error',
      from: { path: mobile },
      to: { dependencyTypes: ['core'] }
    },
    {
      name: 'shared-does-not-import-the-mobile-client',
      comment: 'Shared contracts are read by every runtime; depending on one client inverts that.',
      severity: 'error',
      from: { path: shared },
      to: { path: mobile }
    },
    {
      name: 'production-does-not-import-tests',
      comment: 'The negative lookahead only keeps architecture-rule fixtures from masquerading as production tests.',
      severity: 'error',
      from: { path: source },
      to: { path: '(^|/)tests/(?!fixtures/architecture/src/)' }
    }
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: '(^|/)(\\.test-out|dist|dist-out|out)/',
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'] },
    reporterOptions: { dot: { collapsePattern: 'node_modules/[^/]+' } }
  }
}
