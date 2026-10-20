#!/usr/bin/env node
import { main } from '../src/cli.mjs';

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => {
    console.error(`kette: ${err.message}`);
    if (process.env.KETTE_DEBUG) console.error(err.stack);
    process.exit(1);
  },
);
