#!/usr/bin/env node
// 扩展管理命令行：node ext.js <validate|add|remove|list|enable|disable|test> ...
// 注册表在 ~/.claude-float/extensions.json；装好的扩展在浮窗上各占一条可收放面板
const path = require('path');
const os = require('os');
const ext = require('./extensions');

const [, , cmd, ...args] = process.argv;
const home = (i) => args[i];
const die = (e) => { console.error(`✗ ${e.code ? `[${e.code}] ` : ''}${e.message || e}`); process.exit(1); };

function help() {
  console.log(`用法：
  node ext.js validate <扩展目录>        只校验 manifest 与入口，不运行
  node ext.js add <扩展目录>            注册扩展（浮窗运行中立即生效）
  node ext.js remove <扩展id>           移除扩展
  node ext.js list                      列出已装扩展
  node ext.js enable <扩展id>           启用
  node ext.js disable <扩展id>          停用（面板隐藏，注册保留）
  node ext.js test <扩展id> [目录]      用合成上下文跑一次 view，打印规范化输出
注册表：${path.join(os.homedir(), '.claude-float', 'extensions.json')}`);
}

async function main() {
  switch (cmd) {
    case 'validate': {
      if (!home(0)) return help();
      const m = ext.loadManifest(home(0));
      ext.checkEntryFiles(m.dir, m.entry);
      console.log(`✓ ${m.id} v${m.version}（${m.name}）manifest 与入口都合法`);
      console.log(`  入口：${m.entry.join(' ')}  能力：${m.capabilities.length ? m.capabilities.join('、') : '无'}`);
      break;
    }
    case 'add': {
      if (!home(0)) return help();
      const m = ext.loadManifest(home(0));
      const e = ext.registryAdd(home(0));
      console.log(`✓ 已注册 ${e.id} v${m.version}（${m.name}），浮窗上会出现它的面板`);
      break;
    }
    case 'remove': {
      if (!home(0)) return help();
      console.log(ext.registryRemove(home(0)) ? `✓ 已移除 ${home(0)}` : `✗ 没装过 "${home(0)}"`);
      break;
    }
    case 'enable':
    case 'disable': {
      if (!home(0)) return help();
      const r = ext.registrySetEnabled(home(0), cmd === 'enable');
      if (!r) die(new Error(`没装过 "${home(0)}"`));
      console.log(`✓ ${r.id} 已${cmd === 'enable' ? '启用' : '停用'}`);
      break;
    }
    case 'list': {
      const list = ext.listInstalled();
      if (!list.length) return console.log('还没装任何扩展（node ext.js add <目录>）');
      for (const { entry, manifest, error } of list) {
        if (error) { console.log(`✗ ${entry.id}  ${entry.dir}  manifest 读不了：${error}`); continue; }
        console.log(`${entry.enabled ? '●' : '○'} ${manifest.id}  v${manifest.version}  ${manifest.name}${entry.enabled ? '' : '（已停用）'}`);
        console.log(`   ${entry.dir}`);
      }
      break;
    }
    case 'test': {
      if (!home(0)) return help();
      const hit = ext.listInstalled().find((x) => x.entry.id === home(0));
      if (!hit) die(new Error(`没装过 "${home(0)}"`));
      if (hit.error) die(new Error(hit.error));
      const cwd = home(1) || process.cwd();
      const res = await ext.invoke(hit.manifest, 'view', ext.buildViewInput({ cwd, locale: 'zh-CN' }), { timeout: 15000 });
      if (!res.ok) die(res.error);
      console.log(JSON.stringify(ext.parseViewOutput(res.json), null, 2));
      break;
    }
    default:
      help();
      process.exit(cmd ? 1 : 0);
  }
}

main().catch(die);
