const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

function getGitCmd(args) {
  const gitPaths = [
    'git',
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Program Files\\Git\\bin\\git.exe'
  ];
  for (const p of gitPaths) {
    try {
      const cmd = p.includes(' ') ? `"${p}"` : p;
      return execSync(`${cmd} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    } catch (e) {}
  }
  return '';
}

let input = '';
try {
  input = fs.readFileSync(0, 'utf-8');
} catch (e) {}

let parsed = {};
try {
  parsed = JSON.parse(input || '{}');
} catch (e) {}

if (parsed.stop_hook_active === true) {
  process.exit(0);
}

const sessionId = parsed.session_id || 'default';
const markerDir = path.join(os.tmpdir(), 'claude-stop-markers');
try {
  if (!fs.existsSync(markerDir)) {
    fs.mkdirSync(markerDir, { recursive: true });
  }
} catch (e) {}

const markerFile = path.join(markerDir, `stop-${sessionId}`);
if (fs.existsSync(markerFile)) {
  process.exit(0);
}

let unpushed = '';
try {
  const currentBranch = getGitCmd('rev-parse --abbrev-ref HEAD');
  if (currentBranch && currentBranch !== 'HEAD') {
    let range = 'origin/main..HEAD';
    const upstream = getGitCmd('rev-parse --abbrev-ref --symbolic-full-name @{u}');
    if (upstream) range = `${upstream}..HEAD`;
    unpushed = getGitCmd(`log ${range} --oneline`);
  }
} catch (e) {}

if (unpushed) {
  try {
    fs.writeFileSync(markerFile, Date.now().toString(), 'utf8');
  } catch (e) {}

  const response = {
    decision: "block",
    reason: `[Push-Per-Node Violation] Found unpushed commits on current branch:\n${unpushed}\n\nRule: Push every node commit immediately. Note: 'git push' publishes the WHOLE branch; if it contains commits you did not write, check with owner before publishing.`
  };
  process.stdout.write(JSON.stringify(response) + '\n');
  process.exit(0);
}

process.exit(0);
