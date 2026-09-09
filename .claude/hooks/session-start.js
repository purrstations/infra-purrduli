const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let orphanWorktrees = [];
try {
  const registered = execSync('git worktree list --porcelain', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => path.resolve(line.slice(9).trim()));
} catch (e) {}

const output = {
  hookSpecificOutput: {
    additionalContext: "[Hygiene Check] Verify live status before action: check live git status, use pointers over snapshots, and enforce push-per-node."
  }
};

process.stdout.write(JSON.stringify(output) + '\n');
process.exit(0);
