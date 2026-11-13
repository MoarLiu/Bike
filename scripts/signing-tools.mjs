import { spawnSync } from 'node:child_process';

export const attempt = (command, args, options = {}) => {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 180000, maxBuffer: 16 * 1024 * 1024, ...options });
    const stdout = result.stdout ?? '', stderr = result.stderr ?? '';
    return { ok: result.status === 0 && !result.error, stdout, stderr,
      output: `${stdout}${stderr}${result.error?.message ?? ''}`.trim() };
  } catch (error) {
    return { ok: false, stdout: '', stderr: '', output: error.message };
  }
};
export const field = (output, name) => output.match(new RegExp(`^${name}=(.+)$`, 'mu'))?.[1]?.trim();
export const notarizedAssessment = (result) => result.ok &&
  /(?:^|\n)[^\n]*: accepted(?:\r?\n|$)/u.test(result.output) &&
  /^source=Notarized Developer ID$/mu.test(result.output);
export const validTeam = (team) => typeof team === 'string' && /^[A-Z0-9]{10}$/u.test(team);
