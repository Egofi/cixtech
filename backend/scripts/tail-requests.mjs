#!/usr/bin/env node
//
// Turn the API's pino log on stdin into one readable line per request.
//
// Fastify logs a request in two parts: an object carrying `req` when it arrives,
// and one carrying `res` plus `responseTime` when it finishes. Pairing them on
// `reqId` gives method, path, status and duration together, which is what you
// actually want to read while clicking around the console.
//
// Anything that is not one of those two -- start-up lines, warnings, a stack --
// is printed through untouched. A filter that only recognises the happy path
// would go quiet exactly when something breaks.

import { createInterface } from "node:readline";

const GREY = "[2m";
const RED = "[31m";
const YELLOW = "[33m";
const GREEN = "[32m";
const CYAN = "[36m";
const OFF = "[0m";

const statusColour = (status) => {
  if (status >= 500) return RED;
  if (status >= 400) return YELLOW;
  return GREEN;
};

/** reqId -> { method, url } seen on the way in, consumed on the way out. */
const inFlight = new Map();

const time = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "--:--:--" : d.toISOString().slice(11, 19);
};

createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (raw) => {
  const line = raw.trim();
  if (!line) return;
  if (!line.startsWith("{")) {
    console.log(line);
    return;
  }

  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    console.log(line);
    return;
  }

  if (entry.req) {
    inFlight.set(entry.reqId, { method: entry.req.method, url: entry.req.url });
    return;
  }

  if (entry.res) {
    const started = inFlight.get(entry.reqId) ?? {};
    inFlight.delete(entry.reqId);
    const status = entry.res.statusCode;
    const ms = entry.responseTime === undefined ? "" : `${entry.responseTime.toFixed(1)}ms`;
    console.log(
      `${GREY}${time(entry.time ? new Date(entry.time).toISOString() : "")}${OFF} ` +
        `${statusColour(status)}${String(status).padEnd(3)}${OFF} ` +
        `${CYAN}${(started.method ?? "?").padEnd(6)}${OFF}` +
        `${started.url ?? "?"} ${GREY}${ms}${OFF}`,
    );
    return;
  }

  // Not a request pair: a boot line, a warning, an error. Show it.
  const level = entry.level >= 50 ? RED : entry.level >= 40 ? YELLOW : GREY;
  const msg = entry.msg ?? line;
  console.log(
    `${GREY}${time(entry.time ? new Date(entry.time).toISOString() : "")}${OFF} ${level}${msg}${OFF}`,
  );
});
