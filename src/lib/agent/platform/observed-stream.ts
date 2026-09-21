import {
  observeStream,
  type ExecutionObserver,
} from "thesidedoor-core/observability";
import {
  invocationMetrics,
  closeInvocationMetrics,
  profileMetricConsumer,
} from "./metrics";
import type { AgentTurn, ProviderId } from "../types";
import { randomUUID } from "node:crypto";

type StreamSource = (observer: ExecutionObserver) => AsyncIterable<string>;

/** The shared observer owns cancellation; this adapter owns profile persistence after it settles. */
export function observeAgentStream(
  provider: ProviderId,
  turn: AgentTurn,
  source: StreamSource | { prepare(): { open: StreamSource; model?: string } },
): AsyncGenerator<string> {
  let observed: AsyncGenerator<string> | undefined;
  async function* consume(): AsyncGenerator<string> {
    const metrics = invocationMetrics(turn.metricOwner);
    const started = performance.now();
    let prepared = false;
    const consumerId =
      turn.metricOwner === "instance"
        ? "instance"
        : turn.metricOwner
          ? profileMetricConsumer(turn.metricOwner)
          : undefined;
    try {
      turn.signal?.throwIfAborted();
      const { open, model } =
        typeof source === "function"
          ? { open: source, model: undefined }
          : source.prepare();
      prepared = true;
      observed = observeStream(
        {
          collector: metrics.collector,
          operation: "cli",
          provider,
          model,
          signal: turn.signal,
          consumerId,
          credentialOwnerId: "instance",
        },
        open,
        (text) => Boolean(text.length),
      );
      yield* observed;
    } catch (error) {
      if (!prepared)
        metrics.collector.record({
          version: 1,
          id: randomUUID(),
          timestamp: Date.now(),
          kind: "execution",
          operation: "prepare",
          provider,
          consumerId,
          credentialOwnerId: "instance",
          outcome: turn.signal?.aborted ? "cancelled" : "error",
          durationMs: performance.now() - started,
          inputTokens: null,
          outputTokens: null,
          estimatedCost: null,
          errorCode: "preparation_failed",
        });
      throw error;
    } finally {
      await closeInvocationMetrics(metrics);
    }
  }
  const output = consume();
  const finish = output.return.bind(output);
  const fail = output.throw.bind(output);
  output.return = async (value) => {
    const closing = observed?.return(undefined);
    const results = await Promise.allSettled([closing, finish(value)]);
    if (results[1].status === "rejected") throw results[1].reason;
    if (results[0].status === "rejected") throw results[0].reason;
    return results[1].value;
  };
  output.throw = async (error) => {
    // Shared return aborts immediately, before the outer generator can process throw.
    const closing = observed?.return(undefined);
    await Promise.allSettled([closing, fail(error)]);
    throw error;
  };
  return output;
}
