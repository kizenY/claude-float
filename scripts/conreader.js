// Raw console input reader for testing console-type.ps1.
// Reads stdin in raw mode (same as what Claude Code's TUI does via ReadConsoleInput)
// and logs every byte it receives to the file given as argv[2], one JSON array per chunk.
const fs = require('fs');
const log = process.argv[2];
if (!log) { console.error('need log path'); process.exit(1); }
fs.writeFileSync(log, '');
process.stdin.setRawMode(true);
process.stdin.on('data', (d) => {
  fs.appendFileSync(log, JSON.stringify(Array.from(d)) + '\n');
});
setTimeout(() => process.exit(0), 20000);
