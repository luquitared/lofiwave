#!/usr/bin/env bun
/**
 * `lw`: lofiwave's command line, on every run's PATH (a shim in DATA_DIR/bin, see src/lw.ts). It talks to the console
 * that started the run with the run's own environment; in your own terminal, link the shim onto your PATH.
 */
import { keysCommand, KEYS_HELP } from "./lw-keys";
import { presetsCommand, restartCommand, PRESETS_HELP } from "./lw-presets";

const HELP = `lw: lofiwave from the command line

${KEYS_HELP}
${PRESETS_HELP}`;

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case undefined: case "help": case "--help": case "-h":
    console.log(HELP);
    break;
  case "keys": case "key": case "secrets":
    await keysCommand(rest);
    break;
  case "presets": case "preset":
    await presetsCommand(rest);
    break;
  case "restart":
    await restartCommand(rest);
    break;
  default:
    console.error(`lw: unknown command "${cmd}" (lw help)`);
    process.exit(1);
}
