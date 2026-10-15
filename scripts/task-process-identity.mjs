// Process identity for task-session recovery. A PID alone is never ownership proof.
import { readFileSync } from 'node:fs';

export function readProcessIdentity(pid, { platform = process.platform, readFile = readFileSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1 || platform !== 'linux') return { state: 'unknown', identity: null };
  try {
    const stat = String(readFile('/proc/' + pid + '/stat', 'utf8'));
    const end = stat.lastIndexOf(')');
    if (end < 0 || Number(stat.slice(0, stat.indexOf(' '))) !== pid) return { state: 'unknown', identity: null };
    const fields = stat.slice(end + 1).trim().split(/\s+/);
    if (['Z', 'X'].includes(fields[0])) return { state: 'absent', identity: null };
    const startTicks = fields[19];
    const bootId = String(readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    if (!/^\d+$/.test(startTicks || '') || !/^[a-f0-9-]{36}$/.test(bootId)) return { state: 'unknown', identity: null };
    return { state: 'alive', identity: 'linux:' + bootId + ':' + startTicks };
  } catch (error) {
    return { state: error.code === 'ENOENT' || error.code === 'ESRCH' ? 'absent' : 'unknown', identity: null };
  }
}

export function matchesProcess(record, observation) {
  return !!record?.processStartedAt && observation?.state === 'alive' && record.processStartedAt === observation.identity;
}
