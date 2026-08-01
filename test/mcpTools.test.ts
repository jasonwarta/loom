import { describe, it, expect } from "vitest";
import { DaemonRuntime } from "../src/daemon/runtime.js";
import { createTools, type LoomTool } from "../src/mcp/tools.js";
import { makeStack } from "./helpers.js";

function toolMap(rt: DaemonRuntime): Map<string, LoomTool> {
  return new Map(createTools(rt).map((t) => [t.name, t]));
}

describe("MCP tool handlers (the operator's whole interface)", () => {
  it("drives a task end to end through the tools alone", async () => {
    const { cp } = makeStack();
    const rt = new DaemonRuntime(cp);
    await rt.start();
    const tools = toolMap(rt);

    const { taskId } = (await tools.get("dispatch_worker")!.handler({
      description: "do the thing",
      acceptanceCriteria: ["it works"],
      repo: "example.com",
    })) as { taskId: string };
    expect(typeof taskId).toBe("string");

    await rt.idle();

    const result = (await tools.get("get_result")!.handler({ taskId })) as { task: { state: string } };
    expect(result.task.state).toBe("completed");

    const status = (await tools.get("status")!.handler({})) as { tasksByState: Record<string, number> };
    expect(status.tasksByState["completed"]).toBe(1);

    const queue = (await tools.get("query_queue")!.handler({})) as { counts: Record<string, number> };
    expect(queue.counts["completed"]).toBe(1);

    const registry = (await tools.get("query_registry")!.handler({})) as unknown[];
    expect(registry.length).toBeGreaterThan(0);
    await rt.stop();
  });

  it("dispatch_worker without acceptance criteria escalates via the readiness gate", async () => {
    const { cp } = makeStack();
    const rt = new DaemonRuntime(cp);
    await rt.start();
    const tools = toolMap(rt);

    const { taskId } = (await tools.get("dispatch_worker")!.handler({
      description: "vague task",
      acceptanceCriteria: [],
      repo: "example.com",
    })) as { taskId: string };
    await rt.idle();

    const result = (await tools.get("get_result")!.handler({ taskId })) as { task: { state: string } };
    expect(result.task.state).toBe("escalated");
    await rt.stop();
  });

  it("threads resumeFromBranch through to the task definition + run spec (recovery mode)", async () => {
    const { cp } = makeStack();
    const rt = new DaemonRuntime(cp);
    await rt.start();
    const tools = toolMap(rt);

    const { taskId } = (await tools.get("dispatch_worker")!.handler({
      description: "continue prior work",
      acceptanceCriteria: ["it works"],
      repo: "example.com",
      resumeFromBranch: "loom/prior-run",
    })) as { taskId: string };
    await rt.idle();

    const result = (await tools.get("get_result")!.handler({ taskId })) as {
      task: { definition: { resumeFromBranch?: string } };
      runs: Array<{ runSpec: { taskType: string; resumedWork?: boolean } }>;
    };
    expect(result.task.definition.resumeFromBranch).toBe("loom/prior-run");
    const implRun = result.runs.find((r) => r.runSpec.taskType !== "review");
    expect(implRun?.runSpec.resumedWork).toBe(true);
    await rt.stop();
  });

  it("requires description and repo", async () => {
    const { cp } = makeStack();
    const rt = new DaemonRuntime(cp);
    const tools = toolMap(rt);
    await expect(async () => tools.get("dispatch_worker")!.handler({ acceptanceCriteria: ["x"] })).rejects.toThrow(
      /description/,
    );
    await rt.stop();
  });
});
