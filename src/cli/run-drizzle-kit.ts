import { spawn } from 'node:child_process';

// drizzle-kit's `push` can print a database error (e.g. `LibsqlBatchError: SQLITE_ERROR: ...`) to
// stderr and still exit 0. Treating that as success would let `ratchet dev` restart onto a schema
// that never applied. stdout stays inherited (push's interactive rename prompts render there).
const DB_ERROR_PATTERN = /SQLITE_ERROR|LibsqlError|LibsqlBatchError|PostgresError|^\s*error:/im;

export function runDrizzleKit(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('bunx', ['drizzle-kit', ...args], { cwd, stdio: ['inherit', 'inherit', 'pipe'] });
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderr += chunk.toString();
    });
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`drizzle-kit ${args.join(' ')} exited with code ${code}`));
        return;
      }
      const dbError = stderr.match(DB_ERROR_PATTERN);
      if (dbError) {
        const line = stderr.split('\n').find((l) => DB_ERROR_PATTERN.test(l))?.trim() ?? dbError[0];
        reject(new Error(`drizzle-kit ${args[0]} reported a database error: ${line}`));
        return;
      }
      resolve();
    });
    child.on('error', reject);
  });
}
