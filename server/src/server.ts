import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './api/app.js';

// Paths resolve the same way from server/src (dev) and server/dist (build/Docker).
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

const app = await buildApp({
  samplesDir: process.env.SAMPLES_DIR ?? path.join(root, 'samples'),
  webDir: process.env.WEB_DIR ?? path.join(root, 'web/dist'),
  logger: true,
});

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
