// dsh-audio 自检：host 真 import + 真跑一遍 apply/execute/路由，client 用假 loader 真执行。
import { pathToFileURL } from 'node:url';
import { Writable } from 'node:stream';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import fs from 'node:fs';

const PLUGIN = 'C:/Users/Administrator/.dsh/local-plugins/dsh-audio';
const failures = [];
const ok = (label) => console.log('  ok  ' + label);
const bad = (label, detail) => {
  failures.push(label + ': ' + detail);
  console.log('  FAIL ' + label + ' -> ' + detail);
};

// ---------- host ----------
console.log('[host]');
const host = await import(pathToFileURL(PLUGIN + '/lib/index.js').href);
if (host.inject?.includes('tools')) ok('inject 声明了 tools'); else bad('inject', JSON.stringify(host.inject));

const tools = [];
const routes = [];
const webCtx = {
  webServer: { register(route) { routes.push(route); return () => {}; } },
  effect(fn) { return fn(); },
};
const ctx = {
  tools: { register(tool) { tools.push(tool); return () => {}; } },
  inject(names, cb) { if (names.includes('webServer')) cb(webCtx); },
  effect(fn) { return fn(); },
};
const dispose = host.apply(ctx);
if (typeof dispose === 'function') ok('apply 返回 dispose'); else bad('apply', 'no disposer');
if (tools.length === 1 && tools[0].name === 'play_audio') ok('注册了 play_audio'); else bad('tool', JSON.stringify(tools.map((t) => t.name)));
if (routes.length === 1) ok('注册了文件路由'); else bad('route', String(routes.length));
const tool = tools[0];
if (tool?.output?.presentationMeta) ok('有 presentationMeta'); else bad('presentationMeta', 'missing');

// 造一段真 wav（workspace 下，落在允许根里）
const dir = mkdtempSync(join('D:/Users/Administrator/Documents/deepseek-harness/default-workspace/tmp', 'audio-verify-'));
const wav = join(dir, 'tone.wav');
const sampleRate = 8000;
const samples = sampleRate; // 1 秒
const buf = Buffer.alloc(44 + samples * 2);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples * 2, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i += 1) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000), 44 + i * 2);
writeFileSync(wav, buf);

const result = await tool.execute({ path: wav, title: '测试音' });
if (typeof result.url === 'string' && result.url.startsWith('/plugins/dsh-audio/file?path=')) ok('execute 产出 url'); else bad('execute', JSON.stringify(result));
if (result.bytes === buf.length) ok('execute 报字节数 ' + String(result.bytes)); else bad('bytes', String(result.bytes));
const meta = tool.output.presentationMeta({ path: wav }, result);
if (meta.url === result.url && meta.kind === 'dsh-audio') ok('presentationMeta 投影 url'); else bad('meta', JSON.stringify(meta));

// 拒绝越界路径
let denied = false;
try { await tool.execute({ path: 'C:/Windows/win.ini' }); } catch (error) { denied = /outside the allowed audio roots/.test(String(error.message)); }
if (denied) ok('越界路径被拒'); else bad('越界', 'not rejected');

// 拒绝非音频
let typed = false;
try { await tool.execute({ path: join(dir, 'nope.txt') }); } catch (error) { typed = true; }
if (typed) ok('非音频被拒'); else bad('类型', 'not rejected');

// 路由：整段 / Range / HEAD / 416
class FakeRes extends Writable {
  constructor() { super(); this.status = 0; this.headers = {}; this.body = []; }
  writeHead(status, headers) { this.status = status; this.headers = headers ?? {}; return this; }
  _write(chunk, _enc, cb) { this.body.push(chunk); cb(); }
}
const callRoute = (headers, method = 'GET') => new Promise((resolve, reject) => {
  const res = new FakeRes();
  res.on('finish', () => resolve({ status: res.status, headers: res.headers, body: Buffer.concat(res.body) }));
  res.on('error', reject);
  const req = { method, url: routes[0].path + '?path=' + encodeURIComponent(wav), headers };
  Promise.resolve(routes[0].handler(req, res)).catch(reject);
});

const full = await callRoute({});
if (full.status === 200 && full.body.length === buf.length) ok('整段 GET 200，' + String(full.body.length) + ' 字节'); else bad('GET', full.status + '/' + full.body.length);
if (full.headers['accept-ranges'] === 'bytes') ok('声明 accept-ranges'); else bad('accept-ranges', JSON.stringify(full.headers));

const part = await callRoute({ range: 'bytes=0-99' });
if (part.status === 206 && part.body.length === 100 && part.headers['content-range'] === 'bytes 0-99/' + String(buf.length)) ok('Range 206 正常'); else bad('Range', part.status + '/' + part.body.length + '/' + part.headers['content-range']);

const head = await callRoute({}, 'HEAD');
if (head.status === 200 && head.body.length === 0) ok('HEAD 不返内容'); else bad('HEAD', head.status + '/' + head.body.length);

const badRange = await callRoute({ range: 'bytes=999999-1000000' });
if (badRange.status === 416) ok('越界 Range 416'); else bad('416', String(badRange.status));

const missing = await callRoute({}, 'GET');
// 换个不存在文件的路径
const notFound = await new Promise((resolve) => {
  const res = new FakeRes();
  res.on('finish', () => resolve({ status: res.status }));
  routes[0].handler({ method: 'GET', url: routes[0].path + '?path=' + encodeURIComponent(join(dir, 'ghost.wav')), headers: {} }, res);
});
if (notFound.status === 404) ok('缺失文件 404'); else bad('404', String(notFound.status));

console.log('');
if (failures.length === 0) { console.log('全部通过'); } else { console.log('失败 ' + failures.length + ' 项'); process.exitCode = 1; }
