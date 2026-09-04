import { expect, test } from "vitest";
import { isSafeRemoteHost, parseRemoteWatcherMessage } from "../src/codex/remote-watcher.ts";

test("remote hosts accept SSH aliases but reject option injection", () => {
  expect(isSafeRemoteHost("production-box_2")).toBe(true);
  expect(isSafeRemoteHost("-oProxyCommand=calc")).toBe(false);
  expect(isSafeRemoteHost("host name")).toBe(false);
  expect(isSafeRemoteHost("user@example.com")).toBe(false);
});

test("remote watcher protocol accepts service-tier updates", () => {
  expect(
    parseRemoteWatcherMessage(
      '{"s":"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA","t":"priority"}',
    ),
  ).toEqual({
    kind: "service_tier",
    sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    serviceTier: "priority",
  });
  expect(
    parseRemoteWatcherMessage('{"s":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","t":null}'),
  ).toEqual({
    kind: "service_tier",
    sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    serviceTier: null,
  });
});

test("remote watcher protocol accepts thread metadata", () => {
  expect(
    parseRemoteWatcherMessage(
      '{"s":"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA","n":" Selected remote task ","c":" /srv/app "}',
    ),
  ).toEqual({
    kind: "thread_metadata",
    sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    title: "Selected remote task",
    cwd: "/srv/app",
  });
});

test("remote watcher protocol rejects malformed service-tier updates", () => {
  expect(parseRemoteWatcherMessage('{"s":"not-a-session","t":"priority"}')).toBeUndefined();
  expect(
    parseRemoteWatcherMessage('{"s":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","t":true}'),
  ).toBeUndefined();
});

test("remote watcher protocol keeps goals associated with their sessions", () => {
  expect(
    parseRemoteWatcherMessage(
      '{"G":[{"s":"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA","e":3665,"c":5000,"u":6000}]}',
    ),
  ).toEqual({
    kind: "goals",
    states: new Map([
      [
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        { active: true, elapsedSeconds: 3665, startedAt: 5000, updatedAt: 6000 },
      ],
    ]),
  });
  expect(parseRemoteWatcherMessage('{"G":[]}')).toEqual({ kind: "goals", states: new Map() });
  expect(parseRemoteWatcherMessage('{"G":[{"s":"not-a-session"}]}')).toBeUndefined();
  expect(
    parseRemoteWatcherMessage('{"G":[{"s":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","e":-1}]}'),
  ).toBeUndefined();
});

test("remote watcher protocol accepts compact monthly usage", () => {
  expect(
    parseRemoteWatcherMessage(
      '{"M":"codex","T":1234,"U":{"gpt-5.6-sol":{"i":1000,"o":200,"r":300,"w":0}},"D":{"T":100,"U":{}},"W":{"T":500,"U":{}},"A":{"T":5000,"U":{}}}',
    ),
  ).toEqual({
    kind: "monthly_usage",
    agent: "codex",
    usage: {
      totalTokens: 1234,
      usageByModel: {
        "gpt-5.6-sol": { input: 1000, output: 200, cacheRead: 300, cacheWrite: 0 },
      },
      day: { totalTokens: 100, usageByModel: {} },
      week: { totalTokens: 500, usageByModel: {} },
      allTime: { totalTokens: 5000, usageByModel: {} },
    },
  });
  expect(parseRemoteWatcherMessage('{"M":"codex","T":-1,"U":{}}')).toBeUndefined();
  expect(
    parseRemoteWatcherMessage('{"M":"claude","T":1,"U":{"model":{"i":1}}}'),
  ).toBeUndefined();
});

test("remote protocol ignores JSON primitives and arrays", () => {
  for (const line of ["null", "true", "12", "[]", "\"text\""]) {
    expect(parseRemoteWatcherMessage(line)).toBeUndefined();
  }
});
