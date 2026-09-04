import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './trending/load-trending-to-starrocks.mjs';

export * from './trending/load-trending-to-starrocks.mjs';

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
