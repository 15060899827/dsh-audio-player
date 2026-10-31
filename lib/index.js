import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, isAbsolute, basename, resolve, relative } from 'node:path';
import { homedir } from 'node:os';

export const name = 'dsh-audio-player';

/** `tools` is required: the agent-scope registry is where play_audio lives. */
export const inject = ['tools'];

const ROUTE = '/plugins/dsh-audio/file';
const MAX_BYTES = 512 * 1024 * 1024;

const MIME = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
};

/**
 * Directories this plugin may serve from.
 *
 * The route is reachable from the local web port, so "any absolute path" would be
 * a file-read hole. Resolution order:
 *   1. `DSH_AUDIO_ROOTS` — semicolon separated absolute paths
 *   2. `~/.dsh/dsh-audio-roots.json` — a JSON array of paths
 *   3. the process working directory, the user's Music and Documents folders
 */
function allowedRoots() {
  const fromEnv = (process.env.DSH_AUDIO_ROOTS ?? '')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (fromEnv.length > 0) return fromEnv.map((entry) => resolve(entry));

  const fromFile = readRootsFile();
  if (fromFile.length > 0) return fromFile.map((entry) => resolve(entry));

  return [
    resolve(process.cwd()),
    resolve(homedir(), 'Music'),
    resolve(homedir(), 'Documents'),
  ];
}

/** Read `~/.dsh/dsh-audio-roots.json`; a broken file must not break playback. */
function readRootsFile() {
  try {
    const file = resolve(homedir(), '.dsh', 'dsh-audio-roots.json');
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => typeof entry === 'string' && entry.trim() !== '');
  } catch {
    return [];
  }
}

function insideAllowedRoot(fullPath) {
  const target = resolve(fullPath);
  return allowedRoots().some((root) => {
    const rel = relative(root, target);
    if (rel === '') return true;
    return !rel.startsWith('..') && !isAbsolute(rel);
  });
}

/** Validate one requested path into `{ full, info, mime }` or throw a readable error. */
async function inspectAudio(requestedPath) {
  if (typeof requestedPath !== 'string' || requestedPath.trim() === '') {
    throw new Error('an absolute audio path is required');
  }
  if (!isAbsolute(requestedPath)) throw new Error('only absolute paths are accepted');
  const full = resolve(requestedPath);
  if (!insideAllowedRoot(full)) throw new Error('path is outside the allowed audio roots');
  const info = await stat(full);
  if (!info.isFile()) throw new Error('not a file');
  const ext = extname(full).toLowerCase();
  const mime = MIME[ext];
  if (mime === undefined) throw new Error('unsupported audio type: ' + (ext || '(none)'));
  if (info.size > MAX_BYTES) throw new Error('audio file too large: ' + String(info.size) + ' bytes');
  return { full, info, mime };
}

/** Parse one `Range: bytes=a-b` header against the file size; null means "send it all". */
function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const [, rawStart, rawEnd] = match;
  let start;
  let end;
  if (rawStart === '' && rawEnd === '') return null;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
    if (!Number.isFinite(start) || start >= size || end < start) return 'invalid';
  }
  return { start, end };
}

export function apply(ctx) {
  const disposers = [];

  // A missing tool registry is a real failure: report it instead of silently
  // shipping a plugin with no tools.
  disposers.push(ctx.tools.register({
    name: 'play_audio',
    description:
      'Show an inline audio player inside the conversation so the user can listen with one click, without opening a file manager or another app. ' +
      'Pass the absolute path of a local audio file (wav/mp3/ogg/opus/m4a/aac/flac/webm). The file must live under one of the plugin\'s allowed audio roots. ' +
      'Use this whenever you produce a voice clip, a song, or any sound the user should hear.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Absolute path of the audio file on this machine.' },
        title: { type: 'string', description: 'Optional short label shown above the player.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          bytes: { type: 'integer' },
        },
        required: ['url', 'title', 'bytes'],
      },
      render: (args, value) => [{
        type: 'text',
        text: 'Audio player: ' + String(value.title ?? basename(String(args?.path ?? ''))),
      }],
      // Without this projection the browser half never receives the address of the
      // player; the tool result is the only place it may come from.
      presentationMeta: (args, value) => ({
        kind: 'dsh-audio',
        url: String(value.url ?? ''),
        title: String(value.title ?? ''),
      }),
    },
    async execute(args) {
      const { full, info } = await inspectAudio(String(args?.path ?? ''));
      const title = typeof args?.title === 'string' && args.title.trim() !== ''
        ? args.title.trim()
        : basename(full);
      return {
        url: ROUTE + '?path=' + encodeURIComponent(full) + '&v=' + String(info.mtimeMs),
        title,
        bytes: info.size,
      };
    },
  }));

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: async (req, res) => {
        let target;
        try {
          const url = new URL(req.url ?? '', 'http://localhost');
          target = await inspectAudio(url.searchParams.get('path') ?? '');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const status = message.includes('unsupported') || message.includes('too large') ? 415 : 404;
          res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(message);
          return;
        }

        const { full, info, mime } = target;
        const range = parseRange(req.headers.range, info.size);
        if (range === 'invalid') {
          res.writeHead(416, { 'content-range': 'bytes */' + String(info.size) });
          res.end();
          return;
        }
        if (range === null) {
          res.writeHead(200, {
            'content-type': mime,
            'content-length': String(info.size),
            'accept-ranges': 'bytes',
            'cache-control': 'no-cache',
          });
          if (req.method === 'HEAD') {
            res.end();
            return;
          }
          createReadStream(full).pipe(res);
          return;
        }

        res.writeHead(206, {
          'content-type': mime,
          'content-length': String(range.end - range.start + 1),
          'content-range': 'bytes ' + String(range.start) + '-' + String(range.end) + '/' + String(info.size),
          'accept-ranges': 'bytes',
          'cache-control': 'no-cache',
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        createReadStream(full, { start: range.start, end: range.end }).pipe(res);
      },
    }), 'dsh-audio: file route');
  });

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // A failing disposer must not mask the others.
      }
    }
  };
}
