import path from "node:path";
import { dataRoot } from "../../data-dir";
import { isAccessError } from "thesidedoor-core/access";
import { FileStateStore } from "thesidedoor-core/storage";
import {
  MetricCollector,
  type MetricEvent,
  type MetricSink,
} from "thesidedoor-core/observability";
import {
  LocalMetricStore,
  initialMetricState,
  metricStateSchema,
} from "thesidedoor-core/observability/store";
import { PapernookIdentityStore } from "../../auth/identity-store";
import {
  withProfileActivity,
  type ProfileCapability,
} from "../../auth/profile-capability";

/** Generation is captured at admission, before asynchronous work starts. */
export function profileMetricConsumer(capability: ProfileCapability): string {
  if (
    !/^[a-z0-9][a-z0-9-]{1,30}$/.test(capability.username) ||
    !Number.isSafeInteger(capability.generation) ||
    capability.generation < 1
  )
    throw new Error("Invalid metric profile capability");
  return `profile:${capability.username}:${capability.generation}`;
}

function metricProfile(consumer: string): ProfileCapability {
  const match = /^profile:([a-z0-9][a-z0-9-]{1,30}):([1-9][0-9]*)$/.exec(
    consumer,
  );
  if (!match) throw new Error("Unknown metric consumer");
  const capability = { username: match[1], generation: Number(match[2]) };
  profileMetricConsumer(capability);
  return capability;
}

function localStore(directory: string): LocalMetricStore {
  return new LocalMetricStore({
    store: new FileStateStore({
      path: path.join(directory, "metrics.json"),
      initial: initialMetricState,
      parse: (value) => metricStateSchema.parse(value),
    }),
  });
}

/** Separate from identity storage so telemetry never enlarges the authentication envelope. */
export class AgentMetrics implements MetricSink {
  readonly collector: MetricCollector;
  private readonly store: LocalMetricStore;
  private readonly identity: PapernookIdentityStore;
  private revoked = 0;
  private invalidOwnership = 0;

  constructor(directory: string) {
    this.store = localStore(directory);
    this.identity = new PapernookIdentityStore(directory);
    this.collector = new MetricCollector({ sink: this });
  }

  async write(
    events: readonly MetricEvent[],
    signal: AbortSignal,
  ): Promise<void> {
    const groups = new Map<string, MetricEvent[]>();
    for (const event of events) {
      if (!event.consumerId) {
        this.invalidOwnership++;
        continue;
      }
      try {
        if (event.consumerId !== "instance") metricProfile(event.consumerId);
      } catch {
        this.invalidOwnership++;
        continue;
      }
      const group = groups.get(event.consumerId) ?? [];
      group.push(event);
      groups.set(event.consumerId, group);
    }
    for (const [consumer, group] of groups) {
      signal.throwIfAborted();
      if (consumer === "instance") {
        await this.store.write(group, signal);
        continue;
      }
      const capability = metricProfile(consumer);
      try {
        await withProfileActivity(
          this.identity,
          capability,
          () => this.store.write(group, signal),
          signal,
        );
      } catch (error) {
        if (!isAccessError(error) || error.code !== "unauthorized") throw error;
        this.revoked += group.length;
      }
    }
  }

  status() {
    return {
      ...this.collector.status(),
      revoked: this.revoked,
      invalidOwnership: this.invalidOwnership,
    };
  }

  /** The caller must authorize instance-wide access before invoking this method. */
  queryInstance(filter: { since?: number; limit?: number } = {}) {
    return this.store.query(filter);
  }

  async queryProfile(
    capability: ProfileCapability,
    filter: { since?: number; limit?: number } = {},
  ) {
    return withProfileActivity(this.identity, capability, async () => {
      const events = await this.store.query({
        ...filter,
        consumerId: profileMetricConsumer(capability),
      });
      // Revocation may commit while the shared file lease is held.
      return withProfileActivity(this.identity, capability, async () => events);
    });
  }

  prune() {
    return this.store.prune();
  }
}

/** Called under the exclusive profile erasure lease before removing its tombstone. */
export async function eraseProfileMetrics(
  directory: string,
  capability: ProfileCapability,
): Promise<void> {
  await localStore(directory).eraseConsumer(profileMetricConsumer(capability));
}

const diagnostics = globalThis as typeof globalThis & {
  papernookMetricDiagnostics?: Record<
    | "missingOwner"
    | "closed"
    | "dropped"
    | "rejected"
    | "failures"
    | "revoked"
    | "invalidOwnership",
    number
  >;
};

function counters() {
  return (diagnostics.papernookMetricDiagnostics ??= {
    missingOwner: 0,
    closed: 0,
    dropped: 0,
    rejected: 0,
    failures: 0,
    revoked: 0,
    invalidOwnership: 0,
  });
}

export function metricRuntimeStatus() {
  return { ...counters() };
}

/** Each invocation owns its buffer and awaits bounded persistence after provider cleanup. */
export function invocationMetrics(
  owner: ProfileCapability | "instance" | undefined,
): AgentMetrics {
  if (!owner) {
    const status = counters();
    status.missingOwner = Math.min(
      Number.MAX_SAFE_INTEGER,
      status.missingOwner + 1,
    );
  }
  return new AgentMetrics(dataRoot());
}

export async function closeInvocationMetrics(
  metrics: AgentMetrics | undefined,
): Promise<void> {
  if (!metrics) return;
  await metrics.collector.close();
  const result = metrics.status();
  const status = counters();
  for (const key of [
    "dropped",
    "rejected",
    "failures",
    "revoked",
    "invalidOwnership",
  ] as const)
    status[key] = Math.min(Number.MAX_SAFE_INTEGER, status[key] + result[key]);
  status.closed = Math.min(Number.MAX_SAFE_INTEGER, status.closed + 1);
}
