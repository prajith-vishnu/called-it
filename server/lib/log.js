"use strict";
// simple logger - never pass secrets in as `extra`

function line(level, msg, extra) {
  const ts = new Date().toISOString();
  let suffix = "";
  if (extra !== undefined) {
    try { suffix = " " + JSON.stringify(extra); } catch (e) { suffix = " [unserializable]"; }
  }
  return `[${ts}] ${level} ${msg}${suffix}`;
}

module.exports = {
  info(msg, extra)  { console.log(line("INFO ", msg, extra)); },
  warn(msg, extra)  { console.warn(line("WARN ", msg, extra)); },
  error(msg, err, extra) {
    const detail = err instanceof Error ? { error: err.message, stack: err.stack } : { error: String(err) };
    console.error(line("ERROR", msg, Object.assign(detail, extra || {})));
  },
};
