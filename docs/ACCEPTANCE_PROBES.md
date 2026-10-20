# Docker 与 Codex 协议复验

这两个探针只使用合成文件、临时授权和临时目录，不执行模型 turn，不登录账号，不公开部署。脚本要求可信的已安装工具；协议方法白名单不是针对恶意 Codex 二进制的操作系统沙箱。

## 版本与证据对应

2026-10-20 Docker 运行包来自干净提交 `0697ba5a5424f4ed2f60f7625de52c0fd53841f3`，85 个文件，release tree SHA-256 为 `245a4a26020bf2b15ef77e988a6b76ab16baffc2b44a32bdf2960da995facdb2`。本轮实际运行镜像 ID 为 `sha256:6125c9a8200592de7d6997cd163def14f3115df07448de7e71d40ae047911bbd`。

后续 `a8823a4e63642556c85b66eb43df1073b4a5da97` 仅增加浏览器验收脚本、package.json 命令和文档；本探针补充提交仅增加验收脚本、正反例和文档。两者均未修改上述运行包的产品代码。Docker 结果证明 `0697ba5` 运行包，不应重标为任意后续产品版本的镜像验收。重新构建的镜像 ID 可能因构建元数据及依赖获取而不同，应记录自己的 ID、包 manifest 和日志。

## 前置条件

- 隔离 Linux、uid 1000、已可用的本地 Docker daemon、Python 3。
- Node 24.19.0、pnpm 11.19.0；在本仓库执行 `pnpm install --frozen-lockfile --ignore-scripts`。
- Codex 协议探针要求已安装的可信 Codex。本轮是 `0.159.0-alpha.3`，不等于固定 `0.161.0` worker 验收。
- 构建需 npm 网络和足够的本地磁盘；若需要新增费用、安全设置变更或账号登录，应停止。探针不会安装 Codex 或拉取运行镜像。

## 从精确运行提交构建镜像

在含这些探针的仓库根目录执行。独立 worktree 保留 Git 身份，发布打包器会写入 sourceCommit/sourceDirty 和 treeHash。不要从混有未提交文件的源码目录打包。

```sh
set -eu
PROBE_WORK=$(mktemp -d)
git worktree add --detach "$PROBE_WORK/source" 0697ba5a5424f4ed2f60f7625de52c0fd53841f3
(
  cd "$PROBE_WORK/source"
  pnpm install --frozen-lockfile --ignore-scripts
  pnpm build
  node scripts/package-release.ts "$PROBE_WORK/release" > "$PROBE_WORK/package.json"
)
cat "$PROBE_WORK/package.json"
docker build \
  --build-arg NODE_IMAGE=node@sha256:107ceb6ad85808049dccef12414bf17b08eceb299eaf755c0339dc5fc8958d6b \
  -f "$PROBE_WORK/release/deploy/Dockerfile" \
  -t opencontext-acceptance:0697ba5 "$PROBE_WORK/release"
```

该已验证基础镜像包含 Node 24.19.0 与 Git。先确认 manifest 的 sourceCommit、sourceDirty=false、treeHash 与上文一致。构建失败时不要继续将旧镜像当作新构建结果。

受控网络若需已有代理，可给 `docker build` 增加 `--build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY`，按变量名传递已有值，不把值写进文档或日志。已有经过审查的 CA 可用 `--secret id=npm_ca,src="$NODE_EXTRA_CA_CERTS"`；Dockerfile 只在安装步骤挂载它。本次云端还需要将环境中已解析的代理主机/IP 作为此次构建的 `--add-host` 参数；这是环境相关前置条件，不提供可跨环境复用的 IP。不关闭 TLS 验证、不改全局 DNS 或系统 CA。镜像层秘密审计的旧结果见[验收报告](RELEASE_ACCEPTANCE_20261020.md)，以下运行探针不会重新审计全部镜像层。

## Docker 运行探针

```sh
PROBE_IMAGE=$(docker image inspect opencontext-acceptance:0697ba5 --format '{{.Id}}')
python3 scripts/probes/docker-acceptance.py "$PROBE_IMAGE" > "$PROBE_WORK/docker-result.json"
cat "$PROBE_WORK/docker-result.json"
```

[驱动脚本](../scripts/probes/docker-acceptance.py)只接受本地不可变 `sha256:` ID，使用空 Docker 配置与 `--pull never`。容器无网络、无主机端口、只读根、cap-drop ALL、no-new-privileges，限制 768 MiB、1 CPU、128 pids，绑定自己的临时数据目录和合成 owner 文件。显式设置 loopback，未绕过 public-origin 门禁。

[容器内探针](../scripts/probes/docker-runtime.mjs)通过 stdin 在镜像 `/opt/opencontext` 工作目录运行；它依赖镜像内 MCP SDK，不要直接以主机脚本路径运行。检查健康/匿名拒绝、reader 越权拒绝、合成会话两个版本、CLI 与真实 MCP SDK 搜索/固定历史读取、重启 head/hash 一致和正常停止。每次 Docker 操作最多 45 秒，HTTP 最多 5 秒，结束清理自己的容器和临时数据。结果须为 `passed` 且进程退出 0。

构建 worktree、发布包和日志保留供审查。审查完成后用 `git worktree remove "$PROBE_WORK/source"` 移除本次 worktree，再自行删除本次创建的临时发布包；不要清理其他运行数据或镜像。

## 实际 Codex app-server 协议探针

在含探针的仓库根目录、冻结依赖安装完成后运行：

```sh
CODEX_BINARY="$(command -v codex)" node scripts/probes/codex-protocol.mjs > codex-probe-result.json
cat codex-probe-result.json
```

[脚本](../scripts/probes/codex-protocol.mjs)创建临时 HOME/CODEX_HOME/TMPDIR 和 loopback OpenContext，只给子进程 PATH、临时目录与本次合成 reader token，不继承账号授权或代理环境。初始化后创建 ephemeral/read-only thread，显式调用 `context_search` 与固定 revision 的 `context_read`（最多 256 字节），确认没有 auth.json。它没有 `turn/start`、登录或模型自主选工具步骤。结果打印实际客户端标识、`modelTurns: 0`、`authFile: false`。

单次 RPC 最多 20 秒，子进程总时限 90 秒、stdout 最多 4 MiB；结束终止子进程组并删除临时目录。该时限约束外部客户端，不能替代对操作系统故障的恢复保证。若客户端不支持协议，记录失败，不自动安装其他版本、登录或调用模型。

[方法门禁](../scripts/probes/policy.ts)和[正反例](../tests/harness/probe-policy.test.ts)可独立检查：

```sh
node --test tests/harness/probe-policy.test.ts
pnpm check
```

三个 harness 用例覆盖允许的显式读取、拒绝模型/登录/持久或高权限 thread/写工具，以及 Docker 本地 ID 正例与 tag 拒绝；它们不替代上述实际 Docker/Codex 运行。升级、未知 schema 拒绝、备份恢复另按验收报告中的 drill 执行。本探针不覆盖 Compose、TLS、系统服务、真实模型提炼质量或生产 SLO，不能据此宣称工业级。
