/**
 * docs/NETWORK_AUDIT.md: the network fixes — graceful reconnect (N5), disconnect reasons, metrics, per-type budgets
 * (N3), compact wire positions (N2) and frame coalescing (N1).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { MESSAGE_RATE_LIMITS, MSG_BURST, MSG_RATE } from '../src/connection.ts'
import { NetStats, isLoopback } from '../src/netstats.ts'
import { BodyHolds, dropHoldsBody } from '../src/resume.ts'
import { wirePos, wireYaw, type Player } from '../src/world.ts'
import { Client, newAccount, rawGet, sleep, startTestServer, type TestServer } from './helpers.ts'

describe('units', () => {
  it('dropHoldsBody: only drops the player did not choose hold the body', () => {
    expect(dropHoldsBody('client 1006')).toBe(true)
    expect(dropHoldsBody('client 1001 going away')).toBe(true)
    expect(dropHoldsBody('heartbeat timeout')).toBe(true)
    expect(dropHoldsBody('socket error ECONNRESET')).toBe(true)
    expect(dropHoldsBody('server 4000 replaced by a new login')).toBe(true)
    expect(dropHoldsBody('client 1000 client closed')).toBe(false)
    expect(dropHoldsBody('client 1005')).toBe(false)
    expect(dropHoldsBody('server 4010 kicked')).toBe(false)
    expect(dropHoldsBody('server 4009 server shutting down')).toBe(false)
    expect(dropHoldsBody('server 4001 logged out')).toBe(false)
    expect(dropHoldsBody('closed')).toBe(false)
  })

  it('BodyHolds holds once, mutes the body, and releases (finish) on time or on demand', async () => {
    const logs: string[] = []
    const holds = new BodyHolds(() => 50, (m) => logs.push(m))
    const sent: unknown[] = []
    const p = { characterId: 7, name: 'Kim', dead: false, action: { kind: 'attack' }, send: (m: unknown) => sent.push(m) } as unknown as Player
    let finished = 0
    expect(holds.hold(p, () => finished++)).toBe(true)
    expect(holds.hold(p, () => finished++)).toBe(false)
    p.send({ t: 'pong' } as never)
    expect(sent).toHaveLength(0)
    expect(p.action).toBeNull()
    expect(holds.isHeld(7)).toBe(true)
    await sleep(120)
    expect(finished).toBe(1)
    expect(holds.isHeld(7)).toBe(false)
    expect(holds.release(7)).toBe(false)
    // on demand
    expect(holds.hold(p, () => finished++)).toBe(true)
    expect(holds.release(7)).toBe(true)
    expect(finished).toBe(2)
    // no grace, or dead: not held
    expect(new BodyHolds(() => 0, () => {}).hold(p, () => {})).toBe(false)
    expect(new BodyHolds(() => 1000, () => {}).hold({ ...p, dead: true } as Player, () => {})).toBe(false)
  })

  it('NetStats counts by type, tick percentiles, disconnect reasons; reset clears', () => {
    const n = new NetStats(10)
    n.sent('move', 100)
    n.sent('move', 50)
    n.recvd('ping', 30)
    n.closed('client 1006')
    for (let i = 1; i <= 100; i++) n.tick(i)
    const s = n.snapshot()
    expect(s.out.move).toEqual({ n: 2, bytes: 150 })
    expect(s.outTotal).toEqual({ n: 2, bytes: 150 })
    expect(s.inTotal).toEqual({ n: 1, bytes: 30 })
    expect(s.tick).toMatchObject({ n: 100, p50: 51, p95: 96, max: 100, budgetMs: 100 })
    expect(s.disconnects).toEqual({ 'client 1006': 1 })
    n.reset()
    expect(n.snapshot().outTotal.n).toBe(0)
  })

  it('isLoopback', () => {
    for (const a of ['127.0.0.1', '127.0.3.25', '::1', '::ffff:127.0.0.1']) expect(isLoopback(a)).toBe(true)
    for (const a of ['10.0.0.1', '::ffff:192.168.1.2', '', undefined]) expect(isLoopback(a)).toBe(false)
  })

  it('wire positions: cm and 1/1000 rad', () => {
    expect(wirePos([101.234567891234, -3.260912, -70.0062])).toEqual([101.23, -3.26, -70.01])
    expect(wireYaw(-0.4763655242223778)).toBe(-0.476)
    expect(JSON.stringify(wirePos([101.234567891234, 12.3456789, -70.12345678901]))).toBe('[101.23,12.35,-70.12]')
  })

  it('budgets: every timer-driven or lobby type has its own; the ceiling sits above the client cadence', () => {
    // the client: WASD moveTo 10/s, attacks/skills 5/s each, ping 0.2/s, chat 1/s; flight input (private) 20/s
    expect(MSG_RATE).toBeGreaterThanOrEqual(10 + 5 + 5 + 1 + 20)
    expect(MSG_BURST).toBeGreaterThanOrEqual(2 * MSG_RATE)
    expect(MESSAGE_RATE_LIMITS.moveTo!.perSecond).toBeGreaterThanOrEqual(10)
    expect(MESSAGE_RATE_LIMITS.ping).toBeDefined()
  })
})

describe('connection lifecycle (server)', () => {
  let s: TestServer
  const logs: string[] = []
  afterEach(async () => {
    await s?.stopAndClean()
    logs.length = 0
  })

  async function enter(name: string): Promise<{ c: Client; token: string; charId: number }> {
    const acc = await newAccount(s.url, 'net')
    const c = await Client.login(s.url, acc.token)
    c.send({ t: 'charCreate', name, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
    const ch = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: ch.id })
    await c.next('worldEnter')
    return { c, token: acc.token, charId: ch.id }
  }

  it('a dropped socket leaves the character held; the reconnect takes it back where it stood', async () => {
    s = await startTestServer({ config: { resumeGraceS: 10 }, logs })
    const { c, token, charId } = await enter('Dropper')
    const watcher = await enter('Watcher')
    const { world } = s.ctx
    const p = [...world.players.values()].find((x) => x.characterId === charId)!
    c.send({ t: 'moveTo', x: p.pos[0] + 3, z: p.pos[2] })
    await c.next('stop', (m) => m.id === p.id, 3000)
    const at = world.positionAt(p, Date.now())
    c.ws.terminate() // no close frame: the server sees 1006
    await sleep(150)
    expect(world.players.get(p.id)).toBe(p)
    expect(s.ctx.holds.isHeld(charId)).toBe(true)
    await watcher.c.none('despawn', 100)
    expect(logs.some((l) => /disconnect: .*\(Dropper\) in world: client 1006/.test(l))).toBe(true)
    const c2 = await Client.login(s.url, token)
    c2.send({ t: 'enterWorld', id: charId })
    const back = await c2.next('worldEnter')
    expect(s.ctx.holds.isHeld(charId)).toBe(false)
    expect(world.players.has(p.id)).toBe(false)
    expect(back.self.pos[0]).toBeCloseTo(at[0], 1)
    expect(back.self.pos[2]).toBeCloseTo(at[2], 1)
    expect(logs.some((l) => l.includes('Dropper reconnected: resumed'))).toBe(true)
    c2.close()
    watcher.c.close()
  })

  it('a clean close (logout) leaves at once; an expired hold saves and removes the body', async () => {
    s = await startTestServer({ config: { resumeGraceS: 0.2 }, logs })
    const a = await enter('Leaver')
    const b = await enter('Dropped')
    const { world } = s.ctx
    a.c.close() // 1000
    b.c.ws.terminate()
    await sleep(100)
    expect([...world.players.values()].map((p) => p.name)).toEqual(['Dropped'])
    await sleep(300)
    expect(world.players.size).toBe(0)
    expect(logs.some((l) => /disconnect: .*\(Leaver\) in world: client 100[05]/.test(l))).toBe(true)
  })

  it('without a grace (tests, RESUME_GRACE_S=0) a drop leaves at once, as before', async () => {
    s = await startTestServer({ logs })
    const a = await enter('Plain')
    a.c.ws.terminate()
    await sleep(150)
    expect(s.ctx.world.players.size).toBe(0)
  })

  it('a duplicate login replaces the old socket and takes its body back', async () => {
    s = await startTestServer({ config: { resumeGraceS: 10 }, logs })
    const a = await enter('Twice')
    const c2 = await Client.login(s.url, a.token)
    expect((await a.c.closed).code).toBe(4000)
    expect(s.ctx.holds.isHeld(a.charId)).toBe(true)
    c2.send({ t: 'enterWorld', id: a.charId })
    await c2.next('worldEnter')
    expect(s.ctx.world.players.size).toBe(1)
    c2.close()
  })

  it('counts messages by type; /netstats answers only with NET_STATS=1', async () => {
    s = await startTestServer({ logs })
    const a = await enter('Counter')
    a.c.send({ t: 'ping', n: 1, clientTime: 0 })
    await a.c.next('pong')
    const snap = s.ctx.net.snapshot()
    expect(snap.in.ping!.n).toBe(1)
    expect(snap.out.pong!.n).toBe(1)
    expect(snap.out.worldEnter!.n).toBe(1)
    expect(snap.connections.open).toBe(1)
    expect((await rawGet(s.url, '/netstats')).status).toBe(404)
    process.env.NET_STATS = '1'
    try {
      const r = await rawGet(s.url, '/netstats')
      expect(r.status).toBe(200)
      expect(JSON.parse(r.body).in.ping.n).toBe(1)
    } finally {
      delete process.env.NET_STATS
    }
    a.c.close()
  })

  it('frames of one turn arrive complete and in order (the socket is corked per turn)', async () => {
    s = await startTestServer({ logs })
    const a = await enter('Orderly')
    for (let i = 0; i < 4; i++) a.c.send({ t: 'ping', n: i, clientTime: 0 })
    const ns: number[] = []
    for (let i = 0; i < 4; i++) ns.push((await a.c.next('pong')).n)
    expect(ns).toEqual([0, 1, 2, 3])
    a.c.close()
  })
})
