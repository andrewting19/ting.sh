import { expect, test } from "bun:test";
import { LiveTailBuffer } from "./liveTail";

test("live tail buffer assigns monotonic sequence numbers", () => {
  const tail = new LiveTailBuffer(1024);
  expect(tail.latestSeq()).toBe(0);
  expect(tail.append(Buffer.from("a"))).toBe(1);
  expect(tail.append(Buffer.from("bc"))).toBe(2);
  expect(tail.latestSeq()).toBe(2);
});

test("live tail buffer returns only chunks after the requested cut", () => {
  const tail = new LiveTailBuffer(1024);
  tail.append(Buffer.from("first"));
  const cut = tail.append(Buffer.from("second"));
  tail.append(Buffer.from("third"));
  tail.append(Buffer.from("fourth"));

  const chunks = tail.getAfter(cut);
  expect(chunks.map((chunk) => chunk.seq)).toEqual([3, 4]);
  expect(chunks.map((chunk) => chunk.data.toString("utf8"))).toEqual(["third", "fourth"]);
});

test("live tail buffer trims oldest chunks to stay within byte budget", () => {
  const tail = new LiveTailBuffer(5);
  tail.append(Buffer.from("aa"));
  tail.append(Buffer.from("bb"));
  tail.append(Buffer.from("cc"));

  expect(tail.totalSize()).toBeLessThanOrEqual(5);
  expect(tail.getAfter(0).map((chunk) => chunk.data.toString("utf8"))).toEqual(["bb", "cc"]);
  expect(tail.latestSeq()).toBe(3);
});
