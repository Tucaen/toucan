import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentPromptResult } from '../shared/agent'
import type { AgentProvider } from '../shared/agent-provider'
import { isRecord } from '../shared/record'
import {
  askPrompt,
  deliveryVerdict,
  interruptedText,
  listState,
  noAnswerText,
  notRunningRefusal,
  queuedNote,
  replyPrompt,
  SESSION_MESSAGE_TEXT_LIMIT,
  sessionMessagingShortId,
  targetClosedText,
  type MessagingCommand,
  type MessagingSessionState,
  type SessionMessage,
  type SessionMessageFile,
  type SessionMessagingEvent,
  type SessionMessagingListEntry,
  type SessionMessagingRole,
  type SessionMessagingSettings,
  type SessionReplyKind
} from '../shared/session-messaging'
import { errorMessage } from '../shared/text'
import type { DurableJsonStore } from './durable-json-store'
import { createSerialQueue } from './serial-queue'

/**
 * Sibling-session messaging (#2), the part that decides: who may ask whom, when a message starts a
 * turn, where an answer goes, and what survives a restart. The endpoint (`messaging-endpoint.ts`)
 * only authenticates the calling session and hands its command here.
 *
 * Delivery has one rule - a message starts a turn of an idle session and nothing else. A busy
 * session is never steered: the message waits for its turn to end. A session waiting on its human
 * (a permission prompt, a question, a sign-in) keeps waiting, and the message with it; messaging
 * never answers a prompt. Queued messages go one per turn, oldest first, at the target's next
 * `ready`. A target that is not running cannot be asked at all, because nothing says it will run
 * again - the asker is pointed at its outcome record instead.
 *
 * The asker never waits: `ask` returns at once and the answer wakes it later, by the same delivery
 * rule. The answer is the target's `reply`, or - when the turn the question started ends without
 * one - that turn's final message, marked implicit. A target that leaves the canvas with the
 * question open answers "target closed" on its behalf.
 *
 * Two limits bound a conversation between agents: a chain of questions is at most `hopLimit` deep -
 * a turn a question started asks one hop further down, and a turn a reply woke asks at its asker's
 * depth, so answers cannot deepen a chain - and a session may ask at most `asksPerTurn` times per
 * turn. A refusal over either is also a notice for the human.
 *
 * Open messages (queued ones, and asks still waiting for an answer) are persisted. Turns are not -
 * every session dies with Toucan - so after a restart a question whose turn was in flight is
 * answered "interrupted", and queued messages go out once their target runs again.
 */

export interface MessagingDirectoryEntry {
  nodeId: string
  projectId: string
  provider: AgentProvider
  role: SessionMessagingRole
  title: string
  ticketId?: string
  branch?: string
  /** When the session was last active as far as a durable source knows, ISO. */
  updatedAt?: string
}

/** The canvas's chat sessions, as the persisted workspace (and the orchestration records) know them. */
export interface MessagingDirectory {
  entry(nodeId: string): Promise<MessagingDirectoryEntry | undefined>
  /** Every chat session of a project, the caller included. */
  project(projectId: string): Promise<MessagingDirectoryEntry[]>
}

/** Main's reach into running sessions. */
export interface MessagingSessions {
  /** Undefined for a session Toucan is not running. */
  state(nodeId: string): MessagingSessionState | undefined
  /** Starts a turn of an idle session, reporting acceptance only. */
  startPrompt(nodeId: string, text: string): AgentPromptResult
  /** The final message of the turn that just ended; read at the turn boundary. */
  finalText(nodeId: string): string | undefined
}

export interface SessionMessengerOptions {
  store: Pick<DurableJsonStore<SessionMessageFile>, 'load' | 'save'>
  /** Read at every ask, so an edited settings file applies to the next one. */
  settings(): Promise<SessionMessagingSettings>
  sessions: MessagingSessions
  directory: MessagingDirectory
  /** Every message change and every refusal the human should see, for the canvas. */
  publish?(event: SessionMessagingEvent): void
  now?(): string
  newId?(): string
  log?(message: string): void
}

/** One call's answer: an HTTP status and the JSON line the CLI prints. */
export interface MessagingReply {
  status: number
  body: { ok: true; [key: string]: unknown } | { ok: false; error: string; [key: string]: unknown }
}

export interface SessionMessenger {
  /** One CLI command from the session on `callerNodeId`. */
  execute(callerNodeId: string, command: MessagingCommand, args: unknown): Promise<MessagingReply>
  /** Every session event, from the broker's observer. */
  observe(nodeId: string, event: AgentEvent): void
  /**
   * The canvas's chat nodes right now, from a workspace save: an open ask whose target is gone is
   * answered "target closed", and a queued reply whose asker is gone is dropped.
   */
  nodesChanged(nodeIds: ReadonlySet<string>): void
  /** Loads what the last run left; call once, before any session runs. */
  restore(): Promise<void>
  /** Every open message, for a canvas that joins late. */
  open(): Promise<SessionMessage[]>
  /** Settles once every operation started so far has; for tests. */
  idle(): Promise<void>
}

const refused = (status: number, error: string): MessagingReply => ({ status, body: { ok: false, error } })

/** A turn of one session as far as messaging is concerned: how it started and how much it asked. */
interface TurnState {
  /** The hop depth this turn asks from: 0 for a turn the human started. */
  chainDepth: number
  asks: number
  /** The question that started this turn, which its end answers if `reply` did not. */
  question?: string
}

const BOUNDARIES = new Set(['turn_complete', 'turn_failed', 'turn_cancelled'])

function textArgument(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export function createSessionMessenger(options: SessionMessengerOptions): SessionMessenger {
  const now = options.now ?? (() => new Date().toISOString())
  const newId = options.newId ?? (() => `m-${randomUUID().slice(0, 8)}`)
  const run = createSerialQueue()
  const inFlight = new Set<Promise<unknown>>()
  let messages: SessionMessage[] = []
  const turns = new Map<string, TurnState>()
  /** When each session last published anything, for `list`. */
  const lastSeen = new Map<string, string>()

  const track = <T>(task: () => Promise<T>): Promise<T> => {
    const promise = run(task)
    inFlight.add(promise)
    void promise.finally(() => inFlight.delete(promise)).catch(() => undefined)
    return promise
  }

  const publish = (event: SessionMessagingEvent): void => {
    try {
      options.publish?.(event)
    } catch (error) {
      options.log?.(`could not publish a messaging event: ${errorMessage(error)}`)
    }
  }
  const changed = (message: SessionMessage): void => publish({ type: 'message', message: { ...message } })

  /** Only open messages are kept: a queued one, or an ask still waiting for its answer. */
  const persist = async (): Promise<void> => {
    messages = messages.filter((message) =>
      message.kind === 'ask' ? !message.answered : message.delivery === 'queued'
    )
    try {
      await options.store.save({ version: 1, messages })
    } catch (error) {
      options.log?.(`could not persist session messages: ${errorMessage(error)}`)
    }
  }

  const party = (nodeId: string, title: string): { shortId: string; title: string } => ({
    shortId: sessionMessagingShortId(nodeId),
    title
  })

  /** Starts a turn with the oldest message queued for `nodeId`, if that session can take one now. */
  const deliverNext = (nodeId: string): void => {
    const message = messages.find((candidate) => candidate.to === nodeId && candidate.delivery === 'queued')
    if (!message) return
    const verdict = deliveryVerdict(options.sessions.state(nodeId))
    if (!verdict.deliver) {
      if (message.queuedBecause !== verdict.reason) {
        message.queuedBecause = verdict.reason
        changed(message)
      }
      return
    }
    const sender = party(message.from, message.fromTitle)
    const text = message.kind === 'ask' ? askPrompt(message, sender) : replyPrompt(message, sender)
    const result = options.sessions.startPrompt(nodeId, text)
    if (!result.ok) {
      // Taken by something else between the verdict and the prompt; the next `ready` tries again.
      if (!result.undelivered) options.log?.(`a message to ${nodeId} was refused: ${result.message ?? 'no reason'}`)
      return
    }
    message.delivery = 'delivered'
    message.deliveredAt = now()
    delete message.queuedBecause
    turns.set(
      nodeId,
      message.kind === 'ask'
        ? { chainDepth: message.depth, asks: 0, question: message.id }
        : { chainDepth: message.depth - 1, asks: 0 }
    )
    changed(message)
  }

  /** Closes an ask with an answer of any kind and sends that answer to the asker. */
  const answer = async (
    ask: SessionMessage,
    replyKind: SessionReplyKind,
    text: string,
    askerPresent: boolean
  ): Promise<SessionMessage> => {
    ask.answered = true
    changed(ask)
    const reply: SessionMessage = {
      id: newId(),
      kind: 'reply',
      from: ask.to,
      to: ask.from,
      fromTitle: ask.toTitle,
      toTitle: ask.fromTitle,
      text,
      depth: ask.depth,
      createdAt: now(),
      delivery: askerPresent ? 'queued' : 'dropped',
      askId: ask.id,
      replyKind
    }
    changed(reply)
    if (askerPresent) {
      messages.push(reply)
      deliverNext(reply.to)
    }
    await persist()
    return reply
  }

  /** A session's turn ended: its question, if one started it and got no reply, is answered now. */
  const endTurn = async (nodeId: string, turn: TurnState | undefined, finalText: string): Promise<void> => {
    const ask = turn?.question
      ? messages.find((message) => message.id === turn.question && message.kind === 'ask' && !message.answered)
      : undefined
    if (!ask) return
    await answer(ask, 'implicit', finalText, (await options.directory.entry(ask.from)) !== undefined)
  }

  const list = async (caller: MessagingDirectoryEntry): Promise<MessagingReply> => {
    const siblings = (await options.directory.project(caller.projectId)).filter(
      (entry) => entry.nodeId !== caller.nodeId && entry.role !== 'orchestrator'
    )
    const sessions: SessionMessagingListEntry[] = siblings.map((entry) => {
      const updatedAt = lastSeen.get(entry.nodeId) ?? entry.updatedAt
      return {
        shortId: sessionMessagingShortId(entry.nodeId),
        title: entry.title,
        provider: entry.provider,
        role: entry.role,
        ...(entry.ticketId !== undefined ? { ticketId: entry.ticketId } : {}),
        ...(entry.branch !== undefined ? { branch: entry.branch } : {}),
        state: listState(options.sessions.state(entry.nodeId)),
        ...(updatedAt !== undefined ? { updatedAt } : {})
      }
    })
    return {
      status: 200,
      body: { ok: true, self: party(caller.nodeId, caller.title), sessions }
    }
  }

  /** A refusal over a limit is the human's business too: it becomes a canvas notice. */
  const overLimit = (caller: MessagingDirectoryEntry, error: string): MessagingReply => {
    publish({ type: 'notice', nodeId: caller.nodeId, text: `Message refused: ${error}`, at: now() })
    return refused(429, error)
  }

  const ask = async (caller: MessagingDirectoryEntry, args: Record<string, unknown>): Promise<MessagingReply> => {
    const to = textArgument(args, 'to')
    const text = textArgument(args, 'text')
    if (to === undefined || text === undefined) return refused(400, 'ask needs --to <shortId> and --text <question>')
    if (text.length > SESSION_MESSAGE_TEXT_LIMIT) {
      return refused(400, `the question is longer than ${SESSION_MESSAGE_TEXT_LIMIT} characters`)
    }
    // Only this project's sessions are reachable, so another project's session reads as unknown.
    const matches = (await options.directory.project(caller.projectId)).filter(
      (entry) => sessionMessagingShortId(entry.nodeId).toLowerCase() === to.toLowerCase()
    )
    if (matches.length === 0) return refused(404, `no session ${to} in this project; run list for the short ids`)
    if (matches.length > 1) return refused(409, `the short id ${to} names more than one session`)
    const target = matches[0]
    if (target.nodeId === caller.nodeId) return refused(400, 'a session cannot ask itself')
    if (target.role === 'orchestrator') return refused(403, 'an orchestrator is not a message target')

    const settings = await options.settings()
    const turn = turns.get(caller.nodeId) ?? { chainDepth: 0, asks: 0 }
    const depth = turn.chainDepth + 1
    if (depth > settings.hopLimit) {
      return overLimit(
        caller,
        `this ask would be hop ${depth} of a question chain, over the limit of ${settings.hopLimit}; answer with what you know`
      )
    }
    if (turn.asks >= settings.asksPerTurn) {
      return overLimit(
        caller,
        `this session already asked ${turn.asks} times this turn, the limit is ${settings.asksPerTurn}`
      )
    }
    const targetParty = party(target.nodeId, target.title)
    const verdict = deliveryVerdict(options.sessions.state(target.nodeId))
    if (!verdict.deliver && verdict.reason === 'not_running') return refused(409, notRunningRefusal(targetParty))

    turns.set(caller.nodeId, { ...turn, asks: turn.asks + 1 })
    const message: SessionMessage = {
      id: newId(),
      kind: 'ask',
      from: caller.nodeId,
      to: target.nodeId,
      fromTitle: caller.title,
      toTitle: target.title,
      text,
      depth,
      createdAt: now(),
      delivery: 'queued'
    }
    messages.push(message)
    changed(message)
    deliverNext(target.nodeId)
    if (message.delivery === 'queued' && message.queuedBecause === undefined) {
      // An older message took the target's idle turn, so this one waits for that turn to end.
      message.queuedBecause = 'busy'
      changed(message)
    }
    await persist()
    return {
      status: 200,
      body: {
        ok: true,
        id: message.id,
        to: targetParty.shortId,
        delivery: message.delivery,
        ...(message.queuedBecause ? { note: queuedNote(message.queuedBecause) } : {})
      }
    }
  }

  const reply = async (caller: MessagingDirectoryEntry, args: Record<string, unknown>): Promise<MessagingReply> => {
    const id = textArgument(args, 'id')
    const text = textArgument(args, 'text')
    if (id === undefined || text === undefined) return refused(400, 'reply needs --id <messageId> and --text <answer>')
    if (text.length > SESSION_MESSAGE_TEXT_LIMIT) {
      return refused(400, `the answer is longer than ${SESSION_MESSAGE_TEXT_LIMIT} characters`)
    }
    const open = messages.find((message) => message.kind === 'ask' && message.id === id && message.to === caller.nodeId)
    if (!open || open.delivery !== 'delivered') return refused(404, `no message ${id} was delivered to this session`)
    if (open.answered) return refused(409, `message ${id} is already answered`)
    const sent = await answer(open, 'reply', text, (await options.directory.entry(open.from)) !== undefined)
    return { status: 200, body: { ok: true, id: sent.id, delivery: sent.delivery } }
  }

  return {
    execute(callerNodeId, command, args) {
      return track(async () => {
        const caller = await options.directory.entry(callerNodeId)
        if (!caller) {
          return refused(403, 'this session is not a chat on the canvas, so it has no sibling sessions to message')
        }
        if (command === 'list') return list(caller)
        const fields = isRecord(args) ? args : {}
        return command === 'ask' ? ask(caller, fields) : reply(caller, fields)
      })
    },

    observe(nodeId, event) {
      lastSeen.set(nodeId, now())
      if (BOUNDARIES.has(event.type)) {
        // Read now, at the boundary itself: by the time the queue gets to it the next turn may have
        // started over the transcript.
        const turn = turns.get(nodeId)
        turns.delete(nodeId)
        const finalText = turn?.question ? (options.sessions.finalText(nodeId) ?? noAnswerText(event)) : ''
        if (turn?.question) void track(() => endTurn(nodeId, turn, finalText))
        return
      }
      if (event.type === 'status' && event.status === 'ready') {
        void track(async () => {
          const before = messages.find((message) => message.to === nodeId && message.delivery === 'queued')
          deliverNext(nodeId)
          if (before?.delivery === 'delivered') await persist()
        })
      }
    },

    nodesChanged(nodeIds) {
      void track(async () => {
        let touched = false
        for (const message of [...messages]) {
          if (message.kind === 'ask' && !message.answered && !nodeIds.has(message.to)) {
            await answer(
              message,
              'closed',
              targetClosedText(party(message.to, message.toTitle)),
              nodeIds.has(message.from)
            )
            touched = true
          } else if (message.kind === 'reply' && message.delivery === 'queued' && !nodeIds.has(message.to)) {
            message.delivery = 'dropped'
            delete message.queuedBecause
            changed(message)
            touched = true
          }
        }
        if (touched) await persist()
      })
    },

    restore() {
      return track(async () => {
        const file = await options.store.load()
        messages = file.messages.map((message) => ({ ...message }))
        // Every session died with the last run, so a question that had started a turn will not be
        // answered by that turn's end.
        const interrupted = messages.filter(
          (message) => message.kind === 'ask' && message.delivery === 'delivered' && !message.answered
        )
        for (const message of interrupted) {
          await answer(
            message,
            'interrupted',
            interruptedText(party(message.to, message.toTitle)),
            (await options.directory.entry(message.from)) !== undefined
          )
        }
        await persist()
      })
    },

    open() {
      return track(() => Promise.resolve(messages.map((message) => ({ ...message }))))
    },

    async idle() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight])
    }
  }
}
