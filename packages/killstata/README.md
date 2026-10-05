# killstata

[![npm version](https://img.shields.io/npm/v/killstata?label=npm)](https://www.npmjs.com/package/killstata)
![Cross-platform CLI](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078D4)

killstata is an AI-native CLI for econometric analysis workflows.

It is designed for users who need reproducible data import, staged preprocessing, econometric estimation, and paper-ready outputs from the command line.

## Install

Install globally:

```bash
npm install -g killstata@latest
killstata --version
```

For source development:

```bash
bun install
```

## Quick Start

```bash
killstata
killstata --version
```

On first run, enter a DeepSeek API key. KillStata prepares its private data-analysis environment automatically; Python, Stata, MCP, and skills setup are not required.

### Local Web interface

Web mode will be available starting with release `0.1.30`. The npm `latest` tag must point to a Web-enabled release before these commands will work; older published packages do not contain the Web assets.

```bash
npm install -g killstata@latest
killstata --version
killstata web
```

By default KillStata opens the browser at `http://127.0.0.1:3080` and accepts connections only from that computer. Keep the terminal open while using it and press `Ctrl+C` to stop the service. Workspaces and model credentials are stored on the host computer. In connected mode, analysis requests are sent to the selected model provider.

Web and Desktop share the same research UI and default to a local experience that records research information without connecting the analysis core. To run a real analysis, open **设置 → 分析模式 → 连接分析核心**. Model credentials are accessed only after this explicit action.

To let people on the same trusted private network use the host's configured analysis service:

```bash
killstata web --share
```

Share the private-LAN link printed in the terminal; its token can be exchanged for one hour. Visitors use their own browser file picker and separate workspace ID. They can connect to the host's configured analysis core, but cannot view or change its API Key or model profiles. A selected file is uploaded to the host only after the visitor explicitly connects and submits an analysis. The default `killstata web` command remains available at `127.0.0.1:3080` only.

For remote access over SSH, forward the local port (`ssh -L 3080:127.0.0.1:3080 user@host`), run `killstata web --no-open` on the host, and open the printed local launch link through the tunnel.

`killstata config` remains available only for optional advanced model settings.

## Screenshots

![KillStata start screen](https://raw.githubusercontent.com/dean-create/KillStata/main/docs/images/killstata-home.png)

![KillStata capability view](https://raw.githubusercontent.com/dean-create/KillStata/main/docs/images/killstata-capabilities.png)

## Common Prompt Examples

- `Import this Excel file and show me the schema.`
- `Run QA on the current dataset and tell me if panel keys are duplicated.`
- `Use the current panel stage and run a fixed-effects regression with clustered SE.`
- `Export a three-line table and a short result summary.`

## What It Supports

- Data import from `CSV`, `XLSX`, and `DTA`
- Structured working datasets with tracked stages
- QA, filtering, preprocessing, and rollback workflows
- Econometric methods such as OLS, panel fixed effects, DID-style flows, IV, and PSM-related flows
- Output generation for summaries, regression tables, and deliverables

## Output Layout

Typical artifact layout:

```text
.killstata/
  datasets/
    <datasetId>/
      manifest.json
      stages/
      inspection/
      meta/
      audit/
      reports/
```

## Install Troubleshooting

If installation succeeds but the CLI still does not start, reinstall the package for the current platform:

```bash
npm i -g killstata@latest
```

If you are developing from source on a platform without a bundled native binary, install Bun:

- https://bun.sh

## Key Design

- Continue from saved artifacts instead of rereading raw files
- Treat preprocessing as tracked stages, not silent overwrites
- Generate outputs from structured result files for better traceability

## Repository

- GitHub: `https://github.com/dean-create/KillStata`

## License

MIT
