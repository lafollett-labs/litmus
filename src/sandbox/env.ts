// The environment every child process litmus starts (the harness, command
// graders, validate proofs) begins from. It is an allowlist, never a denylist:
// a new credential variable nobody thought of stays out by default.
const ALLOW = ['PATH', 'LANG', 'TERM', 'TMPDIR', 'GOCACHE', 'GOMODCACHE', 'GOPATH', 'GOFLAGS', 'npm_config_cache']

export function scrubbedEnv(
  opts: { home: string; extra?: Record<string, string> },
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && (ALLOW.includes(k) || k.startsWith('LC_'))) env[k] = v
  }
  // HOME points at a throwaway directory, so tools that look for credentials in
  // dotfiles (~/.aws, ~/.config, ~/.netrc) find nothing by default. This keeps
  // keys out of casual reach; it does not contain a process that goes looking.
  env['HOME'] = opts.home
  return { ...env, ...opts.extra }
}
