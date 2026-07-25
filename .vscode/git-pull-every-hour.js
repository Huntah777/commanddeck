const { spawnSync } = require('child_process');

const cwd = process.cwd();
const intervalMs = 60 * 60 * 1000;

function runPull() {
  const result = spawnSync('git', ['pull'], {
    cwd,
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) {
    console.error(result.error.message);
    process.exitCode = 1;
    return;
  }

  setTimeout(runPull, intervalMs);
}

runPull();
