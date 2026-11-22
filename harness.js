// Runs inside play.joinbuilders.org. Drives window.channel with MR bot.
(async () => {
  const H = window.MRH = window.MRH || { logs: [], cur: null }
  if (!H.map) {
    const w = await fetch('/arena/v2/world.json').then(r => r.json())
    const tb = await fetch('/arena/v2/terrain.i16').then(r => r.arrayBuffer())
    H.map = new MR.GameMap(w, new Int16Array(tb))
  }
  const ch = window.channel
  if (!ch) return 'no channel'
  if (!H.patched) {
    H.patched = true
    const oh = ch.onHello.bind(ch), oe = ch.onEnd.bind(ch), oo = ch.onObs.bind(ch), orr = ch.onResults.bind(ch)
    ch.onHello = (e) => {
      oh(e)
      H.bot = MR.makeBot(e, H.map)
      H.cur = { start: Date.now(), slot: e.slot, modes: {}, dmg: 0, dmgBy: {}, hits: 0, kills: 0, trail: [], lastObs: null, maxMs: 0, events: [] }
      try { ch.send({ type: 'loaded' }) } catch (x) {}
    }
    ch.onObs = (e) => {
      oo(e)
    }
    ch.act = () => {
      const m = ch.m, o = m && m.last
      if (!o || m.end || !H.bot) return
      const t0 = performance.now()
      let a
      try { a = H.bot.act(o) } catch (err) { H.err = String(err && err.stack || err); a = {} }
      const c = H.cur
      if (c) {
        c.maxMs = Math.max(c.maxMs, performance.now() - t0); c.fireT = c.fireT || {}; c.hitW = c.hitW || {}; (a.fire || []).forEach((f, i) => { const w = o.self.weapons[i]; if (f && w) c.fireT[w.kind] = (c.fireT[w.kind] || 0) + 1 }); for (const ev of o.events) if (ev.type === 'hit') { const k = ev.weapon + (ev.target < 100 ? ':m' : ev.target < 1000 ? ':n' : ':c'); c.hitW[k] = (c.hitW[k] || 0) + 1 }; if (a.fire && a.fire[0]) c.gunShots = (c.gunShots || 0) + 1; for (const ev of o.events) if (ev.type === 'hit' && ev.weapon === 'gun') c.gunHits = (c.gunHits || 0) + 1
        const md = (a._dbg || '').split(' ')[0]; c.modes[md] = (c.modes[md] || 0) + 1
        for (const ev of o.events) {
          if (ev.type === 'damaged') { c.dmg += ev.amount; const k = ev.weapon + ':' + ev.by; c.dmgBy[k] = (c.dmgBy[k] || 0) + ev.amount }
          if (ev.type === 'hit') c.hits += ev.amount
          if (ev.type === 'kill') c.kills++
          if (['took','upgrade','kill','pickup','drop'].includes(ev.type)) c.events.push([o.t, ev.type, ev.kind || ev.id || ev.target || ev.cubes])
        }
        if (o.tick % 20 === 0) c.trail.push([Math.round(o.t), Math.round(o.self.pos[0]), Math.round(o.self.pos[1]), Math.round(o.self.hp), o.alive, (a._dbg || '').slice(0, 30)])
        c.lastObs = { t: o.t, alive: o.alive, hp: o.self.hp, cubes: o.self.cubes, weapons: o.self.weapons.map(w => w && w.kind), up: o.self.upgrades }
      }
      delete a._dbg
      a.tick = o.tick
      ch.send(a)
    }
    ch.onEnd = (e) => {
      oe(e)
      if (H.cur && !H.cur.end) { H.cur.end = e; H.cur.dur = (Date.now() - H.cur.start) / 1000; H.logs.push(H.cur) }
    }
    ch.onResults = (e) => {
      orr(e); if (H.logs.length) H.logs[H.logs.length - 1].results = e
      if (H.auto) setTimeout(() => { const b = [...document.querySelectorAll('button')].find(b => b.innerText.includes('START MATCH')); if (b) b.click() }, 4000)
    }
  }
  return 'ok ' + (ch.m ? 'in-match' : 'idle')
})()
