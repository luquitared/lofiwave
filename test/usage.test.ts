import { test, expect } from "bun:test";
import { parseVmStat } from "../src/capacity";
import { parseMeminfoSwap, parseSwapUsage } from "../src/usage";

// Captured shapes of macOS `vm_stat` and `sysctl -n vm.swapusage` (the macOS paths can't run on Linux).
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               11270.
Pages active:                            250000.
Pages inactive:                          240000.
Pages speculative:                         3000.
Pages throttled:                              0.
Pages wired down:                        110000.
Pages purgeable:                           9000.
`;

test("vm_stat: available = free + inactive + speculative + purgeable pages", () => {
  expect(parseVmStat(VM_STAT)).toBe(Math.floor(((11270 + 240000 + 3000 + 9000) * 16384) / 2 ** 20));
});

test("vm_stat: 4 KB pages when the header has no size, null when it isn't vm_stat", () => {
  expect(parseVmStat("Pages free: 256.\n")).toBe(1);
  expect(parseVmStat("nonsense")).toBeNull();
});

test("sysctl vm.swapusage", () => {
  expect(parseSwapUsage("total = 3072.00M  used = 1623.44M  free = 1448.56M  (encrypted)")).toEqual({ total_mb: 3072, used_mb: 1623 });
  expect(parseSwapUsage("total = 2.00G  used = 512.00M  free = 1536.00M  (encrypted)")).toEqual({ total_mb: 2048, used_mb: 512 });
  expect(parseSwapUsage("total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)")).toEqual({ total_mb: 0, used_mb: 0 });
  expect(parseSwapUsage("")).toBeNull();
});

test("/proc/meminfo swap", () => {
  expect(parseMeminfoSwap("MemTotal: 8000000 kB\nSwapTotal:  2097152 kB\nSwapFree:   1048576 kB\n")).toEqual({ total_mb: 2048, used_mb: 1024 });
  expect(parseMeminfoSwap("MemTotal: 8000000 kB\n")).toBeNull();
});
