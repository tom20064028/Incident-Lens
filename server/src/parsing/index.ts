import type { InputFile, LogEvent, LogFormat, ParseWarning } from '../types.js';
import { detectFormat } from './detect.js';
import { parseJsonLines } from './jsonParser.js';
import { normalizeRecord } from './normalize.js';
import { parseTextLines } from './textParser.js';

export interface ParsedFile {
  name: string;
  format: LogFormat;
  events: LogEvent[];
  warnings: ParseWarning[];
}

export function parseFile(file: InputFile): ParsedFile {
  const format = detectFormat(file.content);
  const { records, warnings } =
    format === 'json' ? parseJsonLines(file.content, file.name) : parseTextLines(file.content, file.name);

  const events: LogEvent[] = [];
  for (const record of records) {
    const result = normalizeRecord(record);
    if ('error' in result) warnings.push({ sourceFile: file.name, sourceLine: record.sourceLine, reason: result.error });
    else events.push(result);
  }
  return { name: file.name, format, events, warnings };
}
