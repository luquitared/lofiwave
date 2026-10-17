import { test, expect } from "bun:test";
import { VtScreen, keyBytes } from "../src/vtscreen";

test("plain text, CRLF, wrapping and scrollback", () => {
  const s = new VtScreen(10, 3);
  s.write("hello\r\nworld\r\n0123456789AB\r\nlast");
  expect(s.screenText()).toBe("0123456789\nAB\nlast");
  expect(s.scrollback).toEqual(["hello", "world"]);
  expect(s.text(10)).toBe("hello\nworld\n0123456789\nAB\nlast");
});

test("cursor movement, erase line/screen, colors dropped", () => {
  const s = new VtScreen(20, 4);
  s.write("\x1b[31mred\x1b[0m line\r\nsecond\x1b[2;1H\x1b[2KSECOND\x1b[1;5H\x1b[K!");
  expect(s.screenText()).toBe("red !\nSECOND");
  s.write("\x1b[2J\x1b[H> prompt");
  expect(s.screenText()).toBe("> prompt");
});

test("ink-style redraw: cursor up + erase lines", () => {
  const s = new VtScreen(30, 6);
  s.write("frame 1 a\r\nframe 1 b\r\n");
  s.write("\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[Gframe 2 a\r\nframe 2 b\r\n");
  expect(s.screenText()).toBe("frame 2 a\nframe 2 b");
});

test("alternate screen keeps the main one; OSC titles skipped", () => {
  const s = new VtScreen(20, 3);
  s.write("shell$ \x1b]0;title\x07");
  s.write("\x1b[?1049hTUI\x1b[?1049l");
  expect(s.screenText()).toBe("shell$");
});

test("scroll region and insert/delete lines", () => {
  const s = new VtScreen(10, 4);
  s.write("a\r\nb\r\nc\r\nd");
  s.write("\x1b[2;3r\x1b[2;1H\x1b[M");
  expect(s.screenText()).toBe("a\nc\n\nd");
});

test("resize keeps the bottom", () => {
  const s = new VtScreen(10, 4);
  s.write("1\r\n2\r\n3\r\n4");
  s.resize(5, 2);
  expect(s.screenText()).toBe("3\n4");
});

test("split UTF-8 across writes", () => {
  const s = new VtScreen(10, 2);
  const b = new TextEncoder().encode("héllo ✓");
  s.write(b.slice(0, 2)); s.write(b.slice(2, 9)); s.write(b.slice(9));
  expect(s.screenText()).toBe("héllo ✓");
});

test("tmux key names to bytes", () => {
  expect(keyBytes("Enter")).toBe("\r");
  expect(keyBytes("C-c")).toBe("\x03");
  expect(keyBytes("Escape")).toBe("\x1b");
  expect(keyBytes("Up")).toBe("\x1b[A");
  expect(keyBytes("M-x")).toBe("\x1bx");
  expect(keyBytes("BTab")).toBe("\x1b[Z");
  expect(keyBytes("y")).toBe("y");
  expect(keyBytes("Nope")).toBeNull();
});
