import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("成功的测试子进程连同受管 Bash 日志一起清理专用临时根", () => {
  const setup = fileURLToPath(new URL("./setup.ts", import.meta.url));
  const jobsUrl = new URL("../src/jobs.ts", import.meta.url).href;
  const code = `
    import { tmpdir } from 'node:os';
    import { existsSync } from 'node:fs';
    import { createLocalBashOperations } from '@earendil-works/pi-coding-agent';
    import { JobManager } from ${JSON.stringify(jobsUrl)};
    const jobs = new JobManager(createLocalBashOperations(), () => {});
    await jobs.run('printf isolated', process.cwd());
    const path = jobs.list()[0].output_path;
    console.log(JSON.stringify({ root: tmpdir(), path, existed: existsSync(path) }));
    await jobs.shutdown();
  `;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--import", setup, "--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.existed, true);
  assert.equal(existsSync(report.path), false);
  assert.equal(existsSync(report.root), false);
});
