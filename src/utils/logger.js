const LEVELS = { DEBUG: 0, INFO: 1, TRADE: 2, WARN: 3, ERROR: 4 };
const COLORS = {
  DEBUG: "\x1b[90m",
  INFO: "\x1b[36m",
  TRADE: "\x1b[32m",
  WARN: "\x1b[33m",
  ERROR: "\x1b[31m",
  RESET: "\x1b[0m",
};

let minLevel = LEVELS.INFO;

function setLevel(level) {
  if (LEVELS[level] !== undefined) minLevel = LEVELS[level];
}

function log(level, tag, msg, data) {
  if (LEVELS[level] < minLevel) return;

  const ts = new Date().toISOString();
  const color = COLORS[level] || COLORS.RESET;
  const prefix = `${color}[${ts}] [${level.padEnd(5)}] [${tag}]${COLORS.RESET}`;

  if (data !== undefined) {
    const dataStr = typeof data === "object" ? JSON.stringify(data) : String(data);
    console.log(`${prefix} ${msg} ${dataStr}`);
  } else {
    console.log(`${prefix} ${msg}`);
  }
}

module.exports = {
  setLevel,
  debug: (tag, msg, data) => log("DEBUG", tag, msg, data),
  info: (tag, msg, data) => log("INFO", tag, msg, data),
  trade: (tag, msg, data) => log("TRADE", tag, msg, data),
  warn: (tag, msg, data) => log("WARN", tag, msg, data),
  error: (tag, msg, data) => log("ERROR", tag, msg, data),
};
