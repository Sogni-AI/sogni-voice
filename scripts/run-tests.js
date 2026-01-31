import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const allIndex = args.indexOf('--all');

if (allIndex !== -1) {
  args.splice(allIndex, 1);
  process.env.VITEST_ALL_MODELS = '1';
}

const child = spawn('vitest', args, {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
