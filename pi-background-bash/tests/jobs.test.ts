import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync, statSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { Backgrounded, JobManager } from "../src/jobs.ts";
import { until } from "./helpers.ts";

function manager(limits?: { maxLogBytes: number; maxRunning: number }) {
  const notices: string[] = [];
  const jobs = new JobManager(createLocalBashOperations(), job => notices.push(job.id), limits);
  return { jobs, notices };
}
async function start(jobs: JobManager, command: string, options: Parameters<JobManager["run"]>[2] = {}) {
  try {
    await jobs.run(command, process.cwd(), { ...options, background: true });
  } catch (error) {
    if (!(error instanceof Backgrounded)) throw error;
    assert.equal(error.reason, "requested");
    assert.equal(error.waitSeconds, undefined);
    jobs.returned(error.jobId);
    return error.jobId;
  }
  throw new Error("Expected a background handoff");
}

test("短命令保留真实退出码和输出，不发送后台通知", async t => {
  const { jobs, notices } = manager();
  t.after(() => jobs.shutdown());
  const output: Buffer[] = [];
  assert.deepEqual(await jobs.run("printf hello; printf err >&2; exit 7", process.cwd(), { onData: data => output.push(data) }), { exitCode: 7 });
  assert.equal(Buffer.concat(output).toString(), "helloerr");
  assert.equal(jobs.list()[0]!.status, "failed");
  assert.equal(jobs.list()[0]!.exit_code, 7);
  assert.deepEqual(notices, []);
});

test("主动后台立即移交，完成后只通知一次，完整日志权限为 0600", async t => {
  const { jobs, notices } = manager();
  t.after(() => jobs.shutdown());
  const before = Date.now();
  const id = await start(jobs, "printf start; sleep 0.15; printf end");
  assert.ok(Date.now() - before < 120);
  assert.equal(jobs.get(id).status, "running");
  await until(() => notices.length === 1);
  assert.equal(jobs.get(id).status, "completed");
  assert.equal(jobs.get(id).exit_code, 0);
  assert.equal(jobs.output(id).output, "startend");
  assert.equal(statSync(jobs.get(id).output_path).mode & 0o777, 0o600);
  jobs.returned(id);
  jobs.output(id);
  await delay(20);
  assert.deepEqual(notices, [id]);
});

test("软超时不终止进程，同一命令只执行一次，后续输出仍被记录", async t => {
  const { jobs, notices } = manager();
  t.after(() => jobs.shutdown());
  let id = "";
  try {
    await jobs.run("printf once; sleep 0.15; printf done", process.cwd(), { timeout: 0.02 });
  } catch (error) {
    assert.ok(error instanceof Backgrounded);
    assert.equal(error.reason, "timeout");
    assert.equal(error.waitSeconds, 0.02);
    id = error.jobId;
  }
  assert.ok(id);
  assert.equal(jobs.get(id).status, "running");
  jobs.returned(id);
  await until(() => notices.length === 1);
  assert.equal(jobs.output(id).output, "oncedone");
});

test("后台任务不受原工具轮次后续取消影响，硬超时仍然生效", async t => {
  const { jobs, notices } = manager();
  t.after(() => jobs.shutdown());
  const controller = new AbortController();
  const id = await start(jobs, "printf alive; sleep 5", { signal: controller.signal, hardTimeout: 0.15 });
  controller.abort();
  await delay(30);
  assert.equal(jobs.get(id).status, "running");
  await until(() => notices.length === 1);
  assert.equal(jobs.get(id).status, "timed_out");
  assert.equal(jobs.get(id).exit_code, undefined);
  assert.equal(jobs.output(id).output, "alive");
});

test("取消前台调用会终止命令；预先取消不会启动命令", async t => {
  const { jobs, notices } = manager();
  t.after(() => jobs.shutdown());
  const controller = new AbortController();
  const running = jobs.run("sleep 5; printf should-not-run", process.cwd(), { signal: controller.signal });
  await delay(30);
  controller.abort();
  await assert.rejects(running, /aborted/);
  assert.equal(jobs.list()[0]!.status, "stopped");
  const count = jobs.list().length;
  await assert.rejects(jobs.run("printf no", process.cwd(), { signal: controller.signal }), /aborted/);
  assert.equal(jobs.list().length, count);
  assert.deepEqual(notices, []);
});

test("手动移交移除取消信号和前台输出回调", async t => {
  const { jobs, notices } = manager();
  t.after(() => jobs.shutdown());
  const controller = new AbortController();
  const chunks: Buffer[] = [];
  const run = jobs.run("printf begin; sleep 0.1; printf end", process.cwd(), { signal: controller.signal, onData: data => chunks.push(data) });
  await until(() => chunks.length > 0);
  const id = jobs.background();
  await assert.rejects(run, error => error instanceof Backgrounded && error.jobId === id && error.reason === "manual" && error.waitSeconds === undefined);
  jobs.returned(id);
  controller.abort();
  await until(() => notices.length === 1);
  assert.equal(Buffer.concat(chunks).toString(), "begin");
  assert.equal(jobs.output(id).output, "beginend");
});

test("运行中可以读取当前输出；截尾不加载整个日志或破坏 UTF-8", async t => {
  const { jobs } = manager();
  t.after(() => jobs.shutdown());
  const id = await start(jobs, "printf '前缀你好世界'; sleep 5");
  await until(() => jobs.get(id).output_bytes > 0);
  const output = jobs.output(id, 7);
  assert.equal(output.truncated, true);
  assert.equal(output.output, "世界");
  assert.equal(jobs.get(id).status, "running");
  assert.equal(readFileSync(output.full_output_path, "utf8"), "前缀你好世界");
  const stopped = await jobs.stop(id);
  assert.equal(stopped.status, "stopped");
  assert.equal((await jobs.stop(id)).status, "stopped");
});

test("日志超出上限立即停止，磁盘日志不会超过上限", async t => {
  const { jobs, notices } = manager({ maxLogBytes: 1024, maxRunning: 16 });
  t.after(() => jobs.shutdown());
  const id = await start(jobs, "while :; do printf '0123456789abcdef'; done");
  await until(() => notices.length === 1);
  assert.equal(jobs.get(id).status, "output_limit");
  assert.equal(statSync(jobs.get(id).output_path).size, 1024);
});

test("非法参数、并发上限和未知 ID 不启动额外命令", async t => {
  const { jobs } = manager({ maxLogBytes: 1024, maxRunning: 1 });
  t.after(() => jobs.shutdown());
  for (const timeout of [0, -1, NaN, Infinity, 3_000_000]) await assert.rejects(jobs.run("printf no", process.cwd(), { timeout }), /timeout must/);
  await assert.rejects(jobs.run(" ", process.cwd()), /empty/);
  assert.equal(jobs.list().length, 0);
  await start(jobs, "sleep 5");
  await assert.rejects(jobs.run("printf no", process.cwd()), /At most 1/);
  assert.throws(() => jobs.output("../../etc/passwd"), /Unknown job/);
  assert.throws(() => jobs.background("unknown"), /Unknown job/);
});

test("关闭清理活动任务，禁止旧会话完成通知和新命令", async () => {
  const { jobs, notices } = manager();
  const id = await start(jobs, "sleep 5; printf no");
  await jobs.shutdown();
  await jobs.shutdown();
  assert.equal(jobs.active, false);
  assert.equal(jobs.get(id).status, "stopped");
  assert.ok(existsSync(jobs.get(id).output_path));
  assert.deepEqual(notices, []);
  await assert.rejects(jobs.run("printf no", process.cwd()), /closed/);
});

test("每个会话隔离任务 ID、目录和管理权限", async t => {
  const first = manager().jobs;
  const second = manager().jobs;
  t.after(async () => { await first.shutdown(); await second.shutdown(); });
  const a = await start(first, "sleep 5");
  const b = await start(second, "sleep 5");
  assert.notEqual(first.get(a).output_path, second.get(b).output_path);
  assert.throws(() => second.get(a), /Unknown job/);
  await assert.rejects(second.stop(a), /Unknown job/);
});

test("停止会终止正常进程组的后代，不执行取消后的后续命令", async t => {
  const { jobs } = manager();
  const directory = mkdtempSync(join(tmpdir(), "pi-background-bash-tree-"));
  t.after(async () => { await jobs.shutdown(); rmSync(directory, { recursive: true, force: true }); });
  const marker = join(directory, "should-not-exist");
  const script = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad'),400)`)}],{stdio:'inherit'}); console.log(process.pid+','+child.pid); setInterval(()=>{},1000);`;
  const id = await start(jobs, `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`);
  await until(() => jobs.get(id).output_bytes > 0);
  const pids = jobs.output(id).output.trim().split(",").map(Number);
  assert.equal(pids.length, 2);
  await jobs.stop(id);
  await delay(450);
  assert.ok(!existsSync(marker));
  for (const pid of pids) {
    assert.ok(Number.isInteger(pid) && pid > 0);
    try {
      // 容器的 PID 1 可能暂不回收僵尸，僵尸不再执行命令。
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      assert.equal(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0], "Z");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
});

test("最近完成记录最多保留 20 个，淘汰不影响仍运行的任务", async t => {
  const { jobs } = manager();
  t.after(() => jobs.shutdown());
  const active = await start(jobs, "sleep 5");
  for (let i = 0; i < 25; i++) await jobs.run("printf done", process.cwd());
  const records = jobs.list();
  assert.equal(records.filter(job => job.status !== "running").length, 20);
  assert.equal(jobs.get(active).status, "running");
});

test("工作目录不存在时保留错误状态，而不是假装命令成功", async t => {
  const { jobs, notices } = manager();
  t.after(() => jobs.shutdown());
  const directory = mkdtempSync(join(tmpdir(), "pi-background-bash-missing-"));
  rmSync(directory, { recursive: true });
  await assert.rejects(jobs.run("printf no", directory), /Working directory does not exist/);
  assert.equal(jobs.list()[0]!.status, "failed");
  assert.equal(jobs.list()[0]!.exit_code, undefined);
  assert.equal(jobs.list()[0]!.output_bytes, 0);
  assert.deepEqual(notices, []);
});
