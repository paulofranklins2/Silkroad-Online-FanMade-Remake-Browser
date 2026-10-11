// docs/NETWORK_AUDIT.md N6: a connection the server has gone silent on is dropped and reconnected (same token).
import type { ClientMessage, ServerMessage } from '@sro/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SILENCE_MS, Session } from '../src/net/session.ts'
import type { Wire } from '../src/net/wire.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('session silence watchdog', () => {
  it('reconnects after SILENCE_MS without a message; a server that answers pings is kept', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date', 'performance'] })
    const wires: { w: Wire; sent: ClientMessage[]; closed: boolean }[] = []
    let answer = true
    const factory = (): Wire => {
      const rec = { w: null as unknown as Wire, sent: [] as ClientMessage[], closed: false }
      const w: Wire = {
        onOpen: () => {},
        onMessage: () => {},
        onClose: () => {},
        send(msg) {
          rec.sent.push(msg)
          const reply = (m: ServerMessage) => queueMicrotask(() => w.onMessage(m))
          if (msg.t === 'hello') reply({ t: 'welcome', account: 'a', server: { id: 'jangan', name: 'Jangan', status: 'online', online: 1, capacity: 10 }, slots: 4 } as ServerMessage)
          if (msg.t === 'ping' && answer) reply({ t: 'pong', n: msg.n, clientTime: msg.clientTime, serverTime: Date.now() })
        },
        close() {
          rec.closed = true
        },
      }
      rec.w = w
      wires.push(rec)
      queueMicrotask(() => w.onOpen())
      return w
    }
    const s = new Session(factory, 'tok')
    const statuses: string[] = []
    s.onStatus((ev) => statuses.push(ev.status))
    await s.connect()
    await vi.advanceTimersByTimeAsync(SILENCE_MS * 3)
    expect(wires).toHaveLength(1)
    answer = false
    await vi.advanceTimersByTimeAsync(SILENCE_MS + 5000)
    expect(wires[0]!.closed).toBe(true)
    expect(statuses).toContain('reconnecting')
    await vi.advanceTimersByTimeAsync(1000)
    expect(wires).toHaveLength(2)
    expect(wires[1]!.sent[0]).toMatchObject({ t: 'hello', token: 'tok' })
    s.close()
  })
})
