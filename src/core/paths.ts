import { sep } from 'node:path'

// Path comparisons the sandbox relies on, kept in one place so the gate and
// the workdir guard can never disagree about what "the same path" means.

// A root that already ends in the separator is the filesystem root: "/" + "/"
// would match nothing.
export const inside = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

// NFC, then upper, then lower: a real case fold for what APFS treats as one
// name (ſ and S, the Kelvin sign and k), which toLowerCase alone misses.
export const fold = (path: string): string => path.normalize('NFC').toUpperCase().toLowerCase()
