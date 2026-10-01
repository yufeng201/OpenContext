import { noLinks } from '../packages/state-sqlite/src/maintenance.ts';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryOpenApi } from '../packages/contracts/src/query-api.ts';

const pages = [
  ['index', '开始使用', 'QUICKSTART.md'],
  ['concepts', '核心概念', 'CORE_CONCEPTS.md'],
  ['query-access', 'REST / SDK / CLI / MCP', 'QUERY_ACCESS.md'],
  ['session', 'Session 接入', 'SESSION_IMPORT.md'],
  ['feishu', '飞书支持等级', 'FEISHU_CHAT.md'],
  ['plugins', '插件开发', 'PLUGIN_DEVELOPMENT.md'],
  ['operations', '运维与安全', 'OPERATIONS.md'],
  ['backup-recovery', '备份恢复与诊断', 'BACKUP_RECOVERY.md'],
  ['deployment-security', '部署与安全门槛', 'DEPLOYMENT_SECURITY.md'],
  ['egress-audit', '出站与审计', 'EGRESS_AUDIT.md'],
  ['audit-durability', '事务审计与恢复', 'AUDIT_DURABILITY.md'],
  ['team-identity', '团队身份决策', 'TEAM_IDENTITY_DECISION.md'],
  ['readiness', '产品就绪矩阵', 'PRODUCT_READINESS.md'],
] as const;
const output = resolve('apps/docs/dist');
const escape = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
function inline(s: string): string {
  return escape(s)
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_m: string, label: string, target: string) => {
        const match = pages.find((p) => p[2] === target.replace(/^\.\//, ''));
        const href = match
          ? match[0] + '.html'
          : /^https:\/\//.test(target)
            ? target
            : undefined;
        return href
          ? '<a href="' + escape(href) + '">' + label + '</a>'
          : label;
      },
    )
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}
function markdown(source: string): string {
  const lines = source.split('\n');
  let result = '',
    code = false,
    table = false,
    list = false;
  function close(): void {
    if (table) {
      result += '</tbody></table></div>';
      table = false;
    }
    if (list) {
      result += '</ul>';
      list = false;
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('```')) {
      close();
      result += code ? '</code></pre>' : '<pre><code>';
      code = !code;
      continue;
    }
    if (code) {
      result += escape(line) + '\n';
      continue;
    }
    if (line.trim().startsWith('|')) {
      const cells = line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|');
      if (cells.every((c) => /^\s*:?-+:?\s*$/.test(c))) continue;
      if (!table) {
        close();
        result +=
          '<div class="table"><table><thead><tr>' +
          cells.map((c) => '<th>' + inline(c.trim()) + '</th>').join('') +
          '</tr></thead><tbody>';
        table = true;
      } else
        result +=
          '<tr>' +
          cells.map((c) => '<td>' + inline(c.trim()) + '</td>').join('') +
          '</tr>';
      continue;
    }
    const item = /^\s*(?:[-*]|\d+\.)\s+(.+)/.exec(line);
    if (item) {
      if (table) close();
      if (!list) {
        result += '<ul>';
        list = true;
      }
      result += '<li>' + inline(item[1]!) + '</li>';
      continue;
    }
    close();
    const title = /^(#{1,4})\s+(.+)/.exec(line);
    if (title)
      result +=
        '<h' +
        title[1]!.length +
        '>' +
        inline(title[2]!) +
        '</h' +
        title[1]!.length +
        '>';
    else if (line.trim()) result += '<p>' + inline(line) + '</p>';
  }
  close();
  if (code) throw new Error('UNCLOSED_DOC_CODE');
  return result;
}
// Only this generated output directory is replaced. No runtime/user/source data.
noLinks(output);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
writeFileSync(
  resolve(output, 'style.css'),
  `*{box-sizing:border-box}body{margin:0;color:#20232c;background:#fff;font:16px/1.7 system-ui,sans-serif}a{color:#7047eb}code,pre{font-family:ui-monospace,monospace}code{background:#f4f2fa;padding:2px 5px;border-radius:4px}pre{background:#f8f9fb;border:1px solid #e5e7ed;border-radius:8px;padding:18px;overflow:auto}pre code{padding:0;background:none}.layout{display:grid;grid-template-columns:260px minmax(0,1fr);min-height:100vh}aside{background:#f9fafb;border-right:1px solid #e5e7ed;padding:28px 20px}nav{display:grid;gap:8px}nav a{text-decoration:none;padding:8px 12px;border-radius:6px;color:#555b66}nav a[aria-current=page]{background:#ece6ff;color:#6940ee}.brand{font-size:22px;font-weight:650;color:#20232c;margin-bottom:20px}main{max-width:1100px;padding:34px 48px;min-width:0}.status{background:#f5f1ff;border:1px solid #e5dcfc;padding:14px 18px;border-radius:8px;font-size:14px}.table{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border:1px solid #e5e7ed;padding:12px;text-align:left;vertical-align:top}th{background:#f9fafb}h1{font-size:32px;line-height:1.3}h2{font-size:23px;margin-top:36px}footer{border-top:1px solid #e5e7ed;padding-top:16px;margin-top:36px;color:#626977;font-size:14px}@media(max-width:720px){.layout{display:block}aside{padding:18px;border-right:0;border-bottom:1px solid #e5e7ed}nav{grid-template-columns:repeat(2,minmax(0,1fr))}main{padding:22px 18px}h1{font-size:28px}}`,
);
for (const [slug, title, file] of pages) {
  const source = readFileSync(resolve('docs', file), 'utf8');
  const nav = pages
    .map(
      ([id, name]) =>
        '<a href="' +
        id +
        '.html"' +
        (id === slug ? ' aria-current="page"' : '') +
        '>' +
        escape(name) +
        '</a>',
    )
    .join('');
  writeFileSync(
    resolve(output, slug + '.html'),
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
      escape(title) +
      ' · OpenContext</title><link rel="stylesheet" href="style.css"></head><body><div class="layout"><aside><div class="brand">OpenContext</div><nav aria-label="文档导航">' +
      nav +
      '</nav></aside><main><div class="status">0.1.0-preview · 受控本机开发版<br>前置条件：Node 24.19 / pnpm 11.19；按本页限定范围运行。数据流向和成功判据见对应指南。真实飞书与模型 Agent E2E 未验收。</div>' +
      markdown(source) +
      '<footer>生成自仓库文档；不含用户材料、凭据或历史会话。<a href="openapi.json">查询 OpenAPI</a> · <a href="llms.txt">llms.txt</a></footer></main></div></body></html>',
  );
}
writeFileSync(
  resolve(output, 'openapi.json'),
  JSON.stringify(QueryOpenApi, null, 2) + '\n',
);
writeFileSync(
  resolve(output, 'llms.txt'),
  '# OpenContext\n\nControlled local preview, filesystem-first versioned context. All reads use current project/source authorization. This guide is data, not permission to edit client configurations.\n\n' +
    pages
      .map(([id, title]) => '- [' + title + '](' + id + '.html)')
      .join('\n') +
    '\n',
);
console.log(
  'Docs built: ' + pages.length + ' pages, query OpenAPI and llms.txt.',
);
