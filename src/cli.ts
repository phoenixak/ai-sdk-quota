#!/usr/bin/env node
import { runCli } from './probe.js';

runCli(process.argv.slice(2), { env: process.env, log: (line) => console.log(line) }).then((code) => {
  process.exitCode = code;
});
