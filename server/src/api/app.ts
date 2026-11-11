import fs from 'node:fs';
import path from 'node:path';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { analyze } from '../analyze.js';
import type { InputFile } from '../types.js';

export interface AppConfig {
  samplesDir: string;
  webDir?: string; // built frontend; served when present
  logger?: boolean;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 20;

function readSamples(samplesDir: string): InputFile[] {
  if (!fs.existsSync(samplesDir)) return [];
  return fs
    .readdirSync(samplesDir)
    .filter((f) => !f.startsWith('.') && fs.statSync(path.join(samplesDir, f)).isFile())
    .sort()
    .map((name) => ({ name, content: fs.readFileSync(path.join(samplesDir, name), 'utf8') }));
}

export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: config.logger ?? false });

  await app.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES } });

  app.setErrorHandler((error: FastifyError, _req, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: 'Invalid options', details: error.issues });
    }
    const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    if (status === 500) app.log.error(error);
    return reply.status(status).send({ error: status === 500 ? 'Internal error' : error.message });
  });

  app.get('/api/health', async () => ({ status: 'ok' }));

  app.post('/api/analyze', async (req, reply) => {
    if (!req.isMultipart()) return reply.status(400).send({ error: 'Expected multipart/form-data with log files' });

    const files: InputFile[] = [];
    const fields: Record<string, string> = {};
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const buf = await part.toBuffer();
        files.push({ name: part.filename || `upload-${files.length + 1}.log`, content: buf.toString('utf8') });
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
    if (files.length === 0) return reply.status(400).send({ error: 'No files uploaded' });
    return analyze(files, fields);
  });

  app.get('/api/samples', async () => readSamples(config.samplesDir).map((f) => f.name));

  app.post('/api/analyze/samples', async (req) => analyze(readSamples(config.samplesDir), req.query ?? {}));

  if (config.webDir && fs.existsSync(config.webDir)) {
    await app.register(fastifyStatic, { root: config.webDir });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') ? reply.status(404).send({ error: 'Not found' }) : reply.sendFile('index.html'),
    );
  }

  return app;
}
