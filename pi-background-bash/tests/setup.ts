import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 每个测试进程使用自己的临时根，Bash 日志也随测试产物一并清理，不污染公共 /tmp。
const root = mkdtempSync(join(tmpdir(), "pi-background-bash-tests-"));
process.env.TMPDIR = root;
process.env.TMP = root;
process.env.TEMP = root;
process.on("exit", code => {
  if (code === 0) rmSync(root, { recursive: true, force: true });
  else console.error(`[pi-background-bash] Failed test artifacts retained: ${root}`);
});
