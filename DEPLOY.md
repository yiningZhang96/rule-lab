# 公网部署指南 · RULE LAB

> 目标：让 http://localhost:3000 变成一个任何设备（手机 4G、别人电脑）都能打开的 https 地址。

## 一、为什么只有这几种做法

这个项目有三个硬约束，直接排除了大部分"便宜又省事"的托管方式：

| 约束 | 后果 |
| --- | --- |
| 常驻 Node 进程（`http.createServer` 常驻，自己监听端口） | 不能用 Vercel / Netlify / Cloudflare Pages / GitHub Pages 这类无服务器平台 |
| 模拟状态在**进程内存**里（`sims` Map），实验进行中靠 SSE 推 tick | 不能上函数计算（阿里云 FC / 腾讯云 SCF），也不能开多副本 |
| 结果写入 `data/results.json` | 需要持久磁盘，否则每次重启/重新部署都会清空 |

**结论：一台一直运行的容器/服务器 + 一个公网入口 + 单实例。**

## 二、已经为部署做好的改造

| 改动 | 位置 | 作用 |
| --- | --- | --- |
| 支持 `DATA_DIR` 环境变量 | `server.js` | 云平台挂持久卷（如 `/var/data`）后，结果不会随重启丢失 |
| 支持 `ADMIN_TOKEN` 环境变量 | `server.js` | 设置后，`DELETE /api/results` 需要请求头 `x-admin-token`，防止陌生人清空全站实验结果（不设置则行为完全不变） |
| 不再写死端口 | `Dockerfile` / `server.js` | 读取平台注入的 `PORT`，未设置时回落 3000，监听 `0.0.0.0` |
| Blueprint 模板 | `render.yaml` | 含 `healthCheckPath: /healthz`，持久磁盘配置已写成注释 |

自检命令（本地即可确认云上行为一致）：

```powershell
$env:PORT='8080'; $env:DATA_DIR="$env:TEMP\rl-data"; $env:ADMIN_TOKEN='secret'
node server.js
# 浏览器开 http://localhost:8080 ，能正常跑实验即说明端口/目录配置没问题
```

## 三、四条可选路线

### 方案 1：Render（最省事，免费可用）

适合：演示、黑客松、访问量不大。**代价：免费实例 15 分钟无流量会休眠，冷启动约 30 秒，且内存里的实验会被中断。**

1. 安装 Git（本机当前没有）：
   ```powershell
   winget install --id Git.Git -e --source winget
   ```
2. 建仓库并推 GitHub（GitHub 上先建一个**空的** `rule-lab` 仓库，不要勾 README）：
   ```powershell
   cd C:\Users\张益宁\Documents\deepseek-harness\default-workspace\RULE-LAB-source
   git init; git add -A; git commit -m "rule-lab: public deploy ready"
   git branch -M main
   git remote add origin https://github.com/<你的用户名>/rule-lab.git
   git push -u origin main
   ```
3. 打开 render.com → 用 GitHub 登录 → **New → Blueprint** → 选 `rule-lab` → Apply。
   平台会按 `render.yaml` 自动创建服务，几分钟后给出 `https://rule-lab-xxxx.onrender.com`。
4. 想要真的"长期在线"：把服务升级到 **Starter（$7/月）**，在 Render 控制台加 1GB 持久磁盘挂到 `/var/data`，并设环境变量 `DATA_DIR=/var/data`。

> 不需要 Docker：`render.yaml` 用的是原生 Node 运行时，`npm install` 对零依赖项目是空操作。

### 方案 2：Railway（免 GitHub，本地目录直接上传）

适合：没有 GitHub 或不想折腾仓库。**代价：$5 试用额度，之后按用量付费（约 $5/月）。**

```powershell
npm i -g @railway/cli
railway login          # 浏览器里授权
railway init           # 在当前项目目录建一个空项目
railway up             # 直接上传本地上传目录并构建（自动识别 Node）
railway domain         # 生成公网域名
```

### 方案 3：阿里云 / 腾讯云轻量服务器（国内访问最稳）

适合：访问者主要在国内、需要长期稳定。**代价：约 ¥30–40/月（学生机更便宜），用公网 IP 访问不需要备案，绑自有域名才需要 ICP 备案。**

1. 买 2 核 2G 轻量，系统选 Ubuntu 22.04；安全组放行 TCP 3000（或 80）。
2. 本机上传（无需 Git，`ssh`/`scp` 系统自带）：
   ```powershell
   scp -r "C:\Users\张益宁\Documents\deepseek-harness\default-workspace\RULE-LAB-source" root@<服务器IP>:/opt/rule-lab
   ```
3. 服务器上装 Node 并守护进程：
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
   cd /opt/rule-lab && node server.js          # 先手动跑一遍确认
   npm i -g pm2
   pm2 start server.js --name rule-lab
   pm2 save && pm2 startup                     # 开机自启
   ```
4. 访问 `http://<服务器IP>:3000`。
5. 想要 80/443 + 域名：用 nginx 反代，**SSE 必须关掉缓冲**：
   ```nginx
   location / {
     proxy_pass http://127.0.0.1:3000;
     proxy_http_version 1.1;
     proxy_set_header Connection '';
     proxy_buffering off;          # 关键：否则 SSE 的 tick 推送会被攒住
     proxy_read_timeout 3600s;
   }
   ```

### 方案 4：Fly.io 香港区（国内延迟低，无需 GitHub）

```powershell
# 安装 flyctl 后：
fly launch      # 首次会问 region，选 hkg；会生成 fly.toml
fly deploy
```
注意：Fly 新账号需要绑定信用卡（有免费额度，超出按用量计费）。`fly.toml` 里确保 `internal_port` 与 `PORT` 一致。

## 四、上线后验收清单

- [ ] `https://<你的域名>/healthz` 返回 `{"ok":true,...}`
- [ ] 首页能新建实验，指标曲线在动（说明 SSE 没被代理缓冲）
- [ ] 手机关掉 WiFi、走 4G 打开同一个地址，能正常使用（说明真公网）
- [ ] 故意重启/重新部署一次，看"结果对比"页的数据是否还在（判断持久化是否生效）
- [ ] 免费实例下别指望实验挂一晚上还在跑：实例休眠 = 内存态清零

## 五、已知的坑

1. **端口**：不要硬写 3000 到平台配置里；让平台注入 `PORT`。绑地址必须是 `0.0.0.0`（代码已经是）。
2. **SSE 被缓冲**：nginx / CDN 没关 `proxy_buffering` 时，页面会"卡住不动"，接口却是 200。
3. **多实例**：任何平台都不要开 2 个副本，否则两个用户会看到两个不同的模拟世界。
4. **实验自动回收**：`server.js` 里 30 分钟无访问就回收 sim，长实验页面前台闲置会被 404，刷新重开即可（同种子可复现恢复）。
5. **无鉴权**：任何人拿到地址都能创建实验、删除结果。要防清空，设置 `ADMIN_TOKEN` 环境变量。
