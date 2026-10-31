// 用假加载器真执行 client.js，验证 promote 定义与组件
import vm from 'node:vm';
import fs from 'node:fs';

const code = fs.readFileSync('C:/Users/Administrator/.dsh/local-plugins/dsh-audio/lib/client.js', 'utf8');
const failures = [];
const ok = (m) => console.log('  ok  ' + m);
const bad = (m, d) => { failures.push(m); console.log('  FAIL ' + m + ' -> ' + d); };

let loaded = null;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(spec) {
        loaded = spec.factory((id) => (id === 'react' ? { createElement: (...a) => ({ $$el: a[0], props: a[1] }) } : {}));
      },
    },
  },
};
vm.runInNewContext(code, sandbox);

if (!loaded) { console.log('factory 没执行'); process.exit(1); }
if (Array.isArray(loaded.inject) && loaded.inject.includes('slots')) ok('exports.inject = ' + JSON.stringify(loaded.inject)); else bad('inject', JSON.stringify(loaded.inject));

// ---- apply ----
const defs = [];
const chatNodes = [];
let registeredDef = null;
const slotsApi = {
  inject(name, fn) { ok('slots.inject("' + name + '")'); fn(); },
  register(def, comp) { defs.push({ def, comp, thisOk: this === slotsApi }); return () => {}; },
};
const ownerSlots = {
  inject(name, fn) { ok('owner.slots.inject("' + name + '")'); fn(); },
  register(def, comp) { chatNodes.push({ def, comp }); return () => {}; },
};
const uiConversation = {
  events: { register(def) { registeredDef = def; return () => {}; } },
};
const owner = {
  slots: ownerSlots,
  effect(fn) { return fn(); },
  get(name) { return name === 'uiConversation' ? uiConversation : undefined; },
};
const ctx = {
  slots: slotsApi,
  inject(names, cb) { if (names.includes('uiConversation')) cb(owner); },
};
loaded.apply(ctx);

if (defs.length === 1 && defs[0].def.key === 'play_audio') ok('toolview 注册 play_audio'); else bad('toolview', JSON.stringify(defs));
if (defs[0]?.thisOk) ok('register 的 this 绑对'); else bad('this', 'unbound');
if (registeredDef !== null) ok('已注册 promote definition'); else bad('definition', 'missing');
if (chatNodes.length === 1 && chatNodes[0].def.key === 'dsh-audio') ok('conversation.chat.node 注册 dsh-audio'); else bad('chat.node', JSON.stringify(chatNodes));

// ---- definition 行为 ----
const def = registeredDef;
const goodEvent = { type: 'tool/result', seq: 42, data: { turn: 3, meta: { kind: 'dsh-audio', url: '/plugins/dsh-audio/file?path=x', title: 'T' } } };
const match = def.match(goodEvent);
if (match && match.id === 'result:42' && match.role === 'start') ok('match 命中 tool/result'); else bad('match', JSON.stringify(match));
if (def.match({ type: 'tool/result', seq: 1, data: { turn: 1, meta: { kind: 'other' } } }) === null) ok('非本插件结果不命中'); else bad('match-negative', 'matched');
if (def.match({ type: 'tool/result', seq: 1, data: { turn: 1, meta: { kind: 'dsh-audio', url: '' } } }) === null) ok('空 url 不命中'); else bad('match-empty', 'matched');

const state = def.start({}, { event: goodEvent });
if (state && state.url === '/plugins/dsh-audio/file?path=x' && state.turn === 3) ok('start 产出 state'); else bad('start', JSON.stringify(state));
const node = def.buildViewNode({ state, key: 'k', id: 'i' });
if (node && node.kind === 'dsh-audio' && node.data.url === state.url && node.anchorSeq === 42 && node.visibility === 'visible') ok('buildViewNode 产出正文节点'); else bad('buildViewNode', JSON.stringify(node));

// ---- 组件 ----
const promoted = chatNodes[0].comp({ node: { data: { url: 'u', title: 'T' } } });
if (promoted && promoted.$$el === 'div') ok('PromotedAudio 渲染 div'); else bad('promoted-render', JSON.stringify(promoted));
const cardHidden = defs[0].comp({ promoted: true, block: { meta: { url: 'u' } } });
if (cardHidden === null) ok('提升后折叠卡片隐藏'); else bad('hide', JSON.stringify(cardHidden));
const cardShown = defs[0].comp({ block: { meta: { url: 'u', title: 'T' } } });
if (cardShown && cardShown.$$el === 'div') ok('未提升时折叠卡片渲染'); else bad('card', JSON.stringify(cardShown));

console.log('');
console.log(failures.length === 0 ? '全部通过' : '失败 ' + failures.length + ' 项');
process.exitCode = failures.length === 0 ? 0 : 1;
