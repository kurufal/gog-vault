import { isAbsolute, resolve, sep } from 'node:path';

export function withinRoot(root: string, relative: string): string {
  if (isAbsolute(relative) || /^[a-z]:/i.test(relative) || relative.includes('\0') || relative.includes('\\')) throw new Error('Invalid vault path');
  const base = resolve(root);
  const result = resolve(base, relative);
  if (result !== base && !result.startsWith(base + sep)) throw new Error('Path escapes vault');
  return result;
}