import { expect, test } from "bun:test";
import { TraceEventBuffer } from "./traceEventBuffer";

test("trace event buffer retains data and resize ordering", () => {
  const trace = new TraceEventBuffer(1024);
  trace.appendData(Buffer.from("abc"));
  trace.appendResize(100, 30);
  trace.appendData(Buffer.from("def"));

  expect(trace.totalDataBytes()).toBe(6);
  expect(trace.count()).toBe(3);
  expect(trace.serialize()).toEqual([
    { type: "data", base64: Buffer.from("abc").toString("base64"), bytes: 3 },
    { type: "resize", cols: 100, rows: 30 },
    { type: "data", base64: Buffer.from("def").toString("base64"), bytes: 3 },
  ]);
});

test("trace event buffer trims oldest data events to stay within budget", () => {
  const trace = new TraceEventBuffer(5);
  trace.appendData(Buffer.from("aa"));
  trace.appendResize(90, 25);
  trace.appendData(Buffer.from("bbb"));
  trace.appendData(Buffer.from("cccc"));

  const serialized = trace.serialize();
  expect(trace.totalDataBytes()).toBeLessThanOrEqual(5);
  expect(serialized.some((event) => event.type === "data" && event.base64 === Buffer.from("aa").toString("base64"))).toBe(false);
  expect(serialized.some((event) => event.type === "resize" && event.cols === 90 && event.rows === 25)).toBe(true);
});
