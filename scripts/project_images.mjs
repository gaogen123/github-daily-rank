import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './projects/project_images.mjs';

export * from './projects/project_images.mjs';

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
