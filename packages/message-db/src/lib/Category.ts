import * as Equinox from "@equinox-js/core"
import * as Token from "./Token"
import * as Snapshot from "./Snapshot"
import * as Write from "./Write"
import * as Read from "./Read"
import * as Caching from "./Caching"
import type {
  ICache,
  ICategory,
  StateTuple,
  StreamToken,
  SyncResult,
  Codec,
  StreamEvent,
  TimelineEvent,
} from "@equinox-js/core"
import { context, trace } from "@opentelemetry/api"
import { MessageDbReader, MessageDbWriter } from "./MessageDbClient"
import { Pool } from "pg"

function keepMap<T, V>(arr: T[], fn: (v: T) => V | null | undefined): V[] {
  const result: V[] = []
  for (let i = 0; i < arr.length; ++i) {
    const value = fn(arr[i])
    if (value != null) result.push(value)
  }
  return result
}

type GatewaySyncResult =
  | { type: "Written"; token: StreamToken }
  | { type: "ConflictUnknown" }

type TryDecode<E> = (v: TimelineEvent) => E | null | undefined

export class MessageDbConnection {
  constructor(public read: MessageDbReader, public write: MessageDbWriter) {}

  static build(pool: Pool, followerPool = pool) {
    return new MessageDbConnection(
      new MessageDbReader(followerPool, pool),
      new MessageDbWriter(pool)
    )
  }
}

export class MessageDbContext {
  constructor(
    private readonly conn: MessageDbConnection,
    public readonly batchSize: number,
    public readonly maxBatches?: number
  ) {}

  tokenEmpty = Token.create(-1n)

  async loadBatched<Event>(
    streamName: string,
    requireLeader: boolean,
    tryDecode: TryDecode<Event>
  ): Promise<[StreamToken, Event[]]> {
    const [version, events] = await Read.loadForwardsFrom(
      this.conn.read,
      this.batchSize,
      this.maxBatches,
      streamName,
      0n,
      requireLeader
    )
    return [Token.create(version), keepMap(events, tryDecode)]
  }

  async loadLast<Event>(
    streamName: string,
    requireLeader: boolean,
    tryDecode: TryDecode<Event>
  ): Promise<[StreamToken, Event[]]> {
    const [version, events] = await Read.loadLastEvent(
      this.conn.read,
      requireLeader,
      streamName
    )
    return [Token.create(version), keepMap(events, tryDecode)]
  }

  async loadSnapshot<Event>(
    category: string,
    streamId: string,
    requireLeader: boolean,
    tryDecode: TryDecode<Event>,
    eventType: string
  ) {
    const snapshotStream = Snapshot.streamName(category, streamId)
    const [, events] = await Read.loadLastEvent(
      this.conn.read,
      requireLeader,
      snapshotStream,
      eventType
    )
    return Snapshot.decode(tryDecode, events)
  }

  async reload<Event>(
    streamName: string,
    requireLeader: boolean,
    token: StreamToken,
    tryDecode: TryDecode<Event>
  ): Promise<[StreamToken, Event[]]> {
    const streamVersion = Token.streamVersion(token)
    const startPos = streamVersion + 1n // Reading a stream uses {inclusive} positions, but the streamVersion is `-1`-based
    const [version, events] = await Read.loadForwardsFrom(
      this.conn.read,
      this.batchSize,
      this.maxBatches,
      streamName,
      startPos,
      requireLeader
    )
    return [
      Token.create(streamVersion > version ? streamVersion : version),
      keepMap(events, tryDecode),
    ]
  }

  async trySync(
    category: string,
    streamId: string,
    streamName: string,
    token: StreamToken,
    encodedEvents: StreamEvent[]
  ): Promise<GatewaySyncResult> {
    const streamVersion = Token.streamVersion(token)
    const result = await Write.writeEvents(
      this.conn.write,
      category,
      streamId,
      streamName,
      streamVersion,
      encodedEvents
    )
    switch (result.type) {
      case "ConflictUnknown":
        return { type: "ConflictUnknown" }
      case "Written": {
        const token = Token.create(result.position)
        return { type: "Written", token }
      }
    }
  }

  async storeSnapshot(
    categoryName: string,
    streamId: string,
    event: StreamEvent
  ) {
    const snapshotStream = Snapshot.streamName(categoryName, streamId)
    const category = Snapshot.snapshotCategory(categoryName)
    return Write.writeEvents(
      this.conn.write,
      category,
      streamId,
      snapshotStream,
      null,
      [event]
    )
  }
}

type AccessStrategy<Event, State> =
  | { type: "Unoptimized" }
  | { type: "LatestKnownEvent" }
  | {
      type: "AdjacentSnapshots"
      eventName: string
      toSnapshot: (state: State) => Event
    }

class CategoryWithAccessStrategy<Event, State, Context> {
  constructor(
    private readonly context: MessageDbContext,
    private readonly codec: Codec<Event, Context>,
    private readonly access: AccessStrategy<Event, State> = {
      type: "Unoptimized",
    }
  ) {}

  private async loadAlgorithm(
    category: string,
    streamId: string,
    streamName: string,
    requireLeader: boolean
  ): Promise<[StreamToken, Event[]]> {
    switch (this.access?.type) {
      case "Unoptimized":
        return this.context.loadBatched(
          streamName,
          requireLeader,
          this.codec.decode
        )
      case "LatestKnownEvent":
        return this.context.loadLast(
          streamName,
          requireLeader,
          this.codec.decode
        )
      case "AdjacentSnapshots": {
        const result = await this.context.loadSnapshot(
          category,
          streamId,
          requireLeader,
          this.codec.decode,
          this.access.eventName
        )
        if (!result)
          return this.context.loadBatched(
            streamName,
            requireLeader,
            this.codec.decode
          )
        const [pos, snapshotEvent] = result
        const [token, rest] = await this.context.reload(
          streamName,
          requireLeader,
          pos,
          this.codec.decode
        )
        return [token, [snapshotEvent].concat(rest)]
      }
    }
  }

  private async load_(
    fold: (state: State, events: Event[]) => State,
    initial: State,
    f: Promise<[StreamToken, Event[]]>
  ): Promise<[StreamToken, State]> {
    const [token, events] = await f
    return [token, fold(initial, events)]
  }

  async load(
    fold: (state: State, events: Event[]) => State,
    initial: State,
    category: string,
    streamId: string,
    streamName: string,
    requireLeader: boolean
  ) {
    return this.load_(
      fold,
      initial,
      this.loadAlgorithm(category, streamId, streamName, requireLeader)
    )
  }

  async reload(
    fold: (state: State, events: Event[]) => State,
    state: State,
    streamName: string,
    requireLeader: boolean,
    token: StreamToken
  ) {
    return this.load_(
      fold,
      state,
      this.context.reload(streamName, requireLeader, token, this.codec.decode)
    )
  }

  async trySync(
    fold: (state: State, events: Event[]) => State,
    category: string,
    streamId: string,
    streamName: string,
    token: StreamToken,
    state: State,
    events: Event[],
    ctx: Context
  ): Promise<SyncResult<State>> {
    const encode = (ev: Event) => this.codec.encode(ev, ctx)
    const encodedEvents = events.map(encode)
    const result = await this.context.trySync(
      category,
      streamId,
      streamName,
      token,
      encodedEvents
    )
    switch (result.type) {
      case "ConflictUnknown":
        return {
          type: "Conflict",
          resync: () => this.reload(fold, state, streamName, true, token),
        }
      case "Written": {
        const state_ = fold(state, events)
        switch (this.access.type) {
          case "LatestKnownEvent":
          case "Unoptimized":
            break
          case "AdjacentSnapshots":
            if (
              Token.shouldSnapshot(this.context.batchSize, token, result.token)
            ) {
              await this.storeSnapshot(
                category,
                streamId,
                ctx,
                result.token,
                this.access.toSnapshot(state_)
              )
            }
        }
        return { type: "Written", data: [result.token, state_] }
      }
    }
  }
  async storeSnapshot(
    category: string,
    streamId: string,
    ctx: Context,
    token: StreamToken,
    snapshotEvent: Event
  ) {
    const event = this.codec.encode(snapshotEvent, ctx)
    event.metadata = Snapshot.meta(token)
    await this.context.storeSnapshot(category, streamId, event)
  }
}

class Folder<Event, State, Context>
  implements ICategory<Event, State, Context>
{
  constructor(
    private readonly category: CategoryWithAccessStrategy<
      Event,
      State,
      Context
    >,
    private readonly fold: (state: State, events: Event[]) => State,
    private readonly initial: State,
    private readonly readCache?: [ICache, string | null]
  ) {}
  async load(
    categoryName: string,
    streamId: string,
    streamName: string,
    allowStale: boolean,
    requireLeader: boolean
  ) {
    const load = () =>
      this.category.load(
        this.fold,
        this.initial,
        categoryName,
        streamId,
        streamName,
        requireLeader
      )
    if (!this.readCache) {
      return load()
    }
    const [cache, prefix] = this.readCache
    const cacheItem = await cache.tryGet<State>(prefix + streamName)
    trace
      .getSpan(context.active())
      ?.setAttribute("eqx.cache_hit", cacheItem != null)
    if (!cacheItem) return load()
    if (allowStale) return cacheItem
    const [token, state] = cacheItem
    return this.category.reload(
      this.fold,
      state,
      streamName,
      requireLeader,
      token
    )
  }

  trySync(
    categoryName: string,
    streamId: string,
    streamName: string,
    context: Context,
    token: StreamToken,
    originState: State,
    events: Event[]
  ) {
    return this.category.trySync(
      this.fold,
      categoryName,
      streamId,
      streamName,
      token,
      originState,
      events,
      context
    )
  }
}

export type CachingStrategy =
  | { type: "SlidingWindow"; cache: ICache; windowInMs: number }
  | { type: "FixedTimespan"; cache: ICache; periodInMs: number }
  | {
      type: "SlidingWindowPrefixed"
      prefix: string
      cache: ICache
      windowInMs: number
    }

export class MessageDbCategory<
  Event,
  State,
  Context = null
> extends Equinox.Category<Event, State, Context> {
  constructor(
    resolveInner: (
      categoryName: string,
      streamId: string
    ) => readonly [ICategory<Event, State, Context>, string],
    empty: StateTuple<State>
  ) {
    super(resolveInner, empty)
  }

  static build<Event, State, Context = null>(
    context: MessageDbContext,
    codec: Codec<Event, Context>,
    fold: (state: State, events: Event[]) => State,
    initial: State,
    caching?: CachingStrategy,
    access?: AccessStrategy<Event, State>
  ) {
    const inner = new CategoryWithAccessStrategy(context, codec, access)
    const readCache = ((): [ICache, string | null] | undefined => {
      switch (caching?.type) {
        case undefined:
          return undefined
        case "SlidingWindow":
        case "FixedTimespan":
          return [caching.cache, null]
        case "SlidingWindowPrefixed":
          return [caching.cache, caching.prefix]
      }
    })()
    const folder = new Folder(inner, fold, initial, readCache)
    const category = ((): ICategory<Event, State, Context> => {
      switch (caching?.type) {
        case undefined:
          return folder
        case "SlidingWindow":
          return Caching.applyCacheUpdatesWithSlidingExpiration(
            caching.cache,
            "",
            caching.windowInMs,
            folder,
            Token.supersedes
          )
        case "SlidingWindowPrefixed":
          return Caching.applyCacheUpdatesWithSlidingExpiration(
            caching.cache,
            caching.prefix,
            caching.windowInMs,
            folder,
            Token.supersedes
          )
        case "FixedTimespan":
          return Caching.applyCacheUpdatesWithFixedTimeSpan(
            caching.cache,
            "",
            caching.periodInMs,
            folder,
            Token.supersedes
          )
      }
    })()

    const resolveInner = (categoryName: string, streamId: string) =>
      [category, `${categoryName}-${streamId}`] as const
    const empty: StateTuple<State> = [context.tokenEmpty, initial]
    return new MessageDbCategory(resolveInner, empty)
  }
}
