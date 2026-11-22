// Survival-first mech bot. Pure logic: makeBot(hello, map) -> { name, act(obs) }.
import { GameMap } from "./map.ts"

type V3 = [number, number, number]
const TAU = Math.PI * 2
const wrap = (a: number) => {
  a = (a + Math.PI) % TAU
  if (a < 0) a += TAU
  return a - Math.PI
}
const d2 = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1])
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

const UPGRADE_PRI = [
  "plating", "armor", "nanites", "gun_damage", "laser_damage", "gun_rate", "laser_charge", "lightning_efficiency",
  "gun_mag", "servos", "sensors", "gun_velocity", "capacitor", "reactor", "jets", "gyros", "lightning_range",
  "lightning_chain", "mortar_reload", "mortar_velocity", "mortar_splash", "laser_pierce",
]
const WEAPON_PRI: Record<string, number> = { laser: 3, lightning: 2, mortar: 1, gun: 0 }

type Track = { id: number; pos: V3; vel: V3; seen: number; hp: number; maxhp: number; cubes: number; weapons: string[]; charging: boolean; aim: [number, number]; visible: boolean }

export function makeBot(hello: any, map: GameMap, rng: () => number = Math.random) {
  const cfg = hello.config
  const me_id = hello.slot
  let t = 0
  // memory
  const tracks = new Map<number, Track>()
  let lastDamageT = -99
  let lastDealT = -99
  let alertYaw: number | null = null
  let alertT = -99
  // nav
  let path: [number, number][] = []
  let pathGoal: [number, number] | null = null
  let pathT = -99
  // motion state
  let strafeDir = 1
  let strafeFlipT = 0
  let stuckN = 0
  let unstickUntil = -1
  let unstickDir: [number, number] = [1, 0]
  let lastPos: V3 = [0, 0, 0]
  let fleeTarget: [number, number] | null = null
  let fleeT = -99
  let scanYaw = 0
  let mode = "start"
  let laserHeldT = -1
  let lastMoveCmd: [number, number] = [0, 0]
  let dropFailed = new Set<number>()
  let takeFail = new Map<number, number>()

  const zoneAt = (z: any, tt: number): { c: [number, number]; r: number } => {
    if (tt <= z.shrink_start) return { c: z.center, r: z.radius }
    const f = clamp((tt - z.shrink_start) / Math.max(0.001, z.shrink_end - z.shrink_start), 0, 1)
    return { c: [z.center[0] + (z.next_center[0] - z.center[0]) * f, z.center[1] + (z.next_center[1] - z.center[1]) * f], r: z.radius + (z.next_radius - z.radius) * f }
  }

  function inZoneSoon(z: any, x: number, y: number, horizon: number, margin = 4) {
    const zz = zoneAt(z, t + horizon)
    return d2([x, y], zz.c) < zz.r - margin
  }

  function planTo(x: number, y: number, gx: number, gy: number, force = false) {
    const goalMoved = !pathGoal || d2(pathGoal, [gx, gy]) > 6
    if (!force && !goalMoved && t - pathT < 2.0 && path.length) return
    const p = map.path(x, y, gx, gy, 50000)
    path = p ?? []
    pathGoal = [gx, gy]
    pathT = t
  }

  function followPath(x: number, y: number): [number, number] | null {
    while (path.length && d2(path[0], [x, y]) < 2.5) path.shift()
    // skip ahead if a later waypoint is directly walkable
    if (path.length >= 2 && map.walkLine(x, y, path[1][0], path[1][1])) path.shift()
    if (!path.length) return null
    const w = path[0]
    const dx = w[0] - x, dy = w[1] - y, L = Math.hypot(dx, dy) || 1
    return [dx / L, dy / L]
  }

  function steerClear(x: number, y: number, m: [number, number]): [number, number] {
    // nudge away from nearby walls
    const L = Math.hypot(m[0], m[1])
    if (L < 1e-3) return m
    let ux = m[0] / L, uy = m[1] / L
    const look = 3.5
    if (map.clearAt(x + ux * look, y + uy * look) >= 2.6) return m
    // try rotated directions
    for (const a of [0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.6, -1.6, 2.2, -2.2]) {
      const c = Math.cos(a), s = Math.sin(a)
      const vx = ux * c - uy * s, vy = ux * s + uy * c
      if (map.clearAt(x + vx * look, y + vy * look) >= 2.6) return [vx * L, vy * L]
    }
    return m
  }

  function mechCenterZ(tr: { pos: V3; cubes?: number }, kind = "mech") {
    if (kind === "npc") return tr.pos[2] + cfg.npc.height * 0.5
    if (kind === "crate") return tr.pos[2] + cfg.crates.height * 0.5
    return tr.pos[2] + cfg.mech.height * 0.5 * (1 + cfg.cubes.size_per_cube * (tr.cubes ?? 0))
  }

  function solveAim(self: any, tp: V3, tv: V3, speed: number, lat: number): { yaw: number; pitch: number; dist: number; tof: number; pt: V3 } {
    const mz = self.pos[2] + (self.stats?.muzzle_height ?? cfg.mech.muzzle_height)
    const ox = self.pos[0], oy = self.pos[1]
    let tof = 0
    let px = tp[0], py = tp[1], pz = tp[2]
    for (let i = 0; i < 4; i++) {
      const tt = tof + lat
      px = tp[0] + tv[0] * tt
      py = tp[1] + tv[1] * tt
      pz = tp[2] + (Math.abs(tv[2]) > 0.5 ? clamp(tv[2] * tt, -6, 6) : 0)
      const D = Math.hypot(px - ox, py - oy, pz - mz)
      tof = isFinite(speed) ? Math.max(0, D - 3) / speed : 0
    }
    const H = Math.hypot(px - ox, py - oy)
    return { yaw: Math.atan2(py - oy, px - ox), pitch: Math.atan2(pz - mz, H), dist: H, tof, pt: [px, py, pz] }
  }

  function mortarAim(self: any, tp: V3, tv: V3, ws: any): { yaw: number; pitch: number } | null {
    const v = ws.speed, g = ws.gravity
    const ox = self.pos[0], oy = self.pos[1], oz = self.pos[2] + cfg.mech.height + 0.5
    let tof = 1
    let res: { yaw: number; pitch: number } | null = null
    for (let it = 0; it < 3; it++) {
      const px = tp[0] + tv[0] * (tof + 0.05), py = tp[1] + tv[1] * (tof + 0.05), pz = tp[2] + 1
      const D = Math.hypot(px - ox, py - oy), H = pz - oz
      const disc = v ** 4 - g * (g * D * D + 2 * H * v * v)
      if (disc < 0) return null
      const sq = Math.sqrt(disc)
      const yaw = Math.atan2(py - oy, px - ox)
      // choose low arc if its path is clear, else high arc
      let chosen: number | null = null
      for (const th of [Math.atan((v * v - sq) / (g * D)), Math.atan((v * v + sq) / (g * D))]) {
        if (th > cfg.mech.max_pitch || th < cfg.mech.min_pitch) continue
        const vx = v * Math.cos(th), vz = v * Math.sin(th)
        const T = D / vx
        let ok = true
        for (let s = 1; s < 12; s++) {
          const tt = (T * s) / 12
          const hx = ox + Math.cos(yaw) * vx * tt, hy = oy + Math.sin(yaw) * vx * tt, hz = oz + vz * tt - 0.5 * g * tt * tt
          const k = map.idx(hx, hy)
          if (hz < map.ground[k] || (hz >= map.solidLo[k] && hz <= map.solidHi[k])) { ok = false; break }
        }
        if (ok) { chosen = th; tof = T; break }
      }
      if (chosen === null) return null
      res = { yaw, pitch: chosen }
    }
    return res
  }

  function visibleFrom(ex: number, ey: number, ez: number, x: number, y: number, z: number) {
    // can an enemy eye at e see a mech standing at (x,y,z feet)?
    return map.los(ex, ey, ez + 8, x, y, z + 4.5, 0.5) || map.los(ex, ey, ez + 8, x, y, z + 8.8, 0.5)
  }

  function findCover(self: any, threats: Track[], zone: any): [number, number] | null {
    const [x, y] = self.pos
    let best: [number, number] | null = null
    let bestS = -1e9
    for (const R of [12, 22, 35, 50, 70]) {
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * TAU + R * 0.1
        const cx = x + Math.cos(ang) * R, cy = y + Math.sin(ang) * R
        if (map.clearAt(cx, cy) < 3.2) continue
        const cz = map.floorAt(cx, cy)
        if (Math.abs(cz - self.pos[2]) > 6) continue
        let seen = 0
        for (const th of threats) if (visibleFrom(th.pos[0], th.pos[1], th.pos[2], cx, cy, cz)) seen++
        let s = -seen * 100 - R * 0.6
        // moving away from threats is good
        for (const th of threats) s += Math.min(60, d2(th.pos, [cx, cy]) - d2(th.pos, [x, y])) * 0.5
        if (!inZoneSoon(zone, cx, cy, 8, 2)) s -= 150
        if (!map.walkLine(x, y, cx, cy, 2.6)) s -= 25
        if (s > bestS) { bestS = s; best = [cx, cy] }
      }
    }
    return best
  }

  function pickUpgrade(offer: any): number {
    let bi = 0, bp = 1e9
    offer.choices.forEach((c: any, i: number) => {
      const p = UPGRADE_PRI.indexOf(c.id)
      const pp = p < 0 ? 100 : p
      if (pp < bp) { bp = pp; bi = i }
    })
    return bi
  }

  function act(obs: any): any {
    t = obs.t
    const self = obs.self
    const [x, y, z] = self.pos
    const act: any = {}
    const zone = obs.zone
    const hpFrac = self.hp / self.max_hp

    // ---- memory ----
    for (const tr of tracks.values()) tr.visible = false
    for (const m of obs.mechs) {
      if (m.kind !== "mech") continue
      let tr = tracks.get(m.id)
      if (!tr) { tr = { id: m.id } as Track; tracks.set(m.id, tr) }
      tr.pos = m.pos; tr.vel = m.vel; tr.seen = t; tr.hp = m.hp ?? tr.hp ?? 1400; tr.maxhp = m.max_hp ?? 1400
      tr.cubes = m.cubes ?? 0; tr.weapons = m.weapons ?? []; tr.charging = !!m.charging; tr.aim = m.aim; tr.visible = true
    }
    for (const [id, tr] of tracks) if (t - tr.seen > 20) tracks.delete(id)

    for (const e of obs.events) {
      if (e.type === "damaged") {
        lastDamageT = t
        if (e.by !== null && e.by !== undefined && e.bearing !== null) {
          if (!obs.mechs.some((m: any) => m.id === e.by)) { alertYaw = e.bearing; alertT = t }
        }
      } else if (e.type === "hit") lastDealT = t
      else if (e.type === "take_failed") takeFail.set(e.id, t)
    }
    for (const s of obs.sounds) {
      if (["gun", "laser", "laser_charge", "lightning", "mortar"].includes(s.kind) && s.dist !== "far" && t - alertT > 2) {
        if (!obs.mechs.some((m: any) => m.kind === "mech")) { alertYaw = s.bearing; alertT = t - 1 }
      }
    }

    // ---- upgrades ----
    if (obs.offer) act.pick = pickUpgrade(obs.offer)

    // ---- weapons ----
    const W = self.weapons as any[]
    const slotOf = (k: string) => W.findIndex((w) => w && w.kind === k)
    const gunS = slotOf("gun"), laserS = slotOf("laser"), litS = slotOf("lightning"), mortS = slotOf("mortar")
    const extra = W[1]
    const extraPri = extra ? WEAPON_PRI[extra.kind] ?? 0 : -1

    // pickups: take if within reach and better
    let lootGoal: [number, number] | null = null
    let lootScore = 0
    for (const p of obs.pickups) {
      const pr = WEAPON_PRI[p.kind] ?? 0
      if (pr <= extraPri || slotOf(p.kind) >= 0) continue
      if (takeFail.has(p.id) && t - (takeFail.get(p.id) ?? 0) < 3) continue
      const dd = d2(p.pos, [x, y])
      if (dd < cfg.loot.pickup_radius - 0.3 && Math.abs(p.pos[2] - z) < 3.8) {
        if (!(extra && extra.kind === "laser" && (extra.charge ?? 0) > 0)) {
          act.take = p.id
          if (W[1]) act.drop = 1
        }
      }
      const sc = pr * 30 - dd
      if (dd < 90 && Math.abs(p.pos[2] - z) < 4 && sc > lootScore - 1e-9 && map.clearAt(p.pos[0], p.pos[1]) >= 2.5) { lootScore = sc; lootGoal = [p.pos[0], p.pos[1]] }
    }

    // ---- threats ----
    const enemies = [...tracks.values()].filter((tr) => t - tr.seen < 5)
    const visible = enemies.filter((e) => e.visible)
    const near = enemies.filter((e) => d2(e.pos, [x, y]) < 160)
    // primary target: visible, LOS, score by distance and hp
    const mz = z + (self.stats?.muzzle_height ?? 7)
    let target: Track | null = null
    let tScore = -1e9
    for (const e of visible) {
      const dd = d2(e.pos, [x, y])
      const los = map.los(x, y, mz, e.pos[0], e.pos[1], mechCenterZ(e), 1.5)
      let s = -dd - (e.hp / e.maxhp) * 60 + (los ? 80 : 0)
      if (dd > 230) s -= 200
      if (s > tScore) { tScore = s; target = e }
    }

    // ---- movement mode ----
    let move: [number, number] = [0, 0]
    let boost = false
    let jump = false
    let aim: [number, number] | null = null

    const zNow = zoneAt(zone, t)
    const outside = d2([x, y], zNow.c) > zNow.r - 1
    const nc = zone.next_center as [number, number], nr = zone.next_radius as number
    const distNext = d2([x, y], nc)
    const timeToShrink = zone.shrink_start - t
    const lateGame = nr <= 70
    const safeR = lateGame ? Math.max(4, nr * 0.45) : nr * 0.7
    const needZone = distNext > safeR && (timeToShrink < (distNext - safeR) / 9 + 25 || t > zone.shrink_start || outside || nr < 150)

    const danger = near.length
    const recentlyHit = t - lastDamageT < 3
    const strongest = Math.max(0, ...near.map((e) => e.hp))
    const wantFlee = near.length > 0 && (hpFrac < 0.35 || (near.length >= 3 && hpFrac < 0.75) || (near.length >= 2 && hpFrac < 0.5) || (hpFrac < 0.5 && strongest > self.hp * 1.6))

    let label = ""
    if (outside || (needZone && !(target && d2(target.pos, [x, y]) < 60 && !wantFlee))) {
      mode = "zone"
      const gx = nc[0] + (x - nc[0]) * (safeR * 0.6 / Math.max(distNext, 1e-3))
      const gy = nc[1] + (y - nc[1]) * (safeR * 0.6 / Math.max(distNext, 1e-3))
      planTo(x, y, gx, gy)
      move = followPath(x, y) ?? [gx - x, gy - y]
      boost = outside || timeToShrink < 10 || self.energy > 70
    } else if (wantFlee) {
      mode = "flee"
      if (!fleeTarget || t - fleeT > 1.2) { fleeTarget = findCover(self, near, zone); fleeT = t }
      if (fleeTarget) {
        planTo(x, y, fleeTarget[0], fleeTarget[1], t - pathT > 1.2)
        move = followPath(x, y) ?? [fleeTarget[0] - x, fleeTarget[1] - y]
        if (d2(fleeTarget, [x, y]) < 2.5) move = [0, 0]
      }
      boost = self.energy > 15
    } else if (target) {
      mode = "fight"
      const dd = d2(target.pos, [x, y])
      const ux = (target.pos[0] - x) / (dd || 1), uy = (target.pos[1] - y) / (dd || 1)
      if (t > strafeFlipT) { strafeDir = rng() < 0.5 ? -strafeDir : strafeDir; strafeFlipT = t + 0.45 + rng() * 0.9 }
      const hasLit = litS >= 0 && self.energy > 20
      const prefMin = hasLit && target.hp < self.hp ? 15 : 45
      const prefMax = hasLit && target.hp < self.hp ? 35 : 110
      let radial = 0
      if (dd < prefMin) radial = -0.7
      else if (dd > prefMax) radial = 0.8
      move = [-uy * strafeDir + ux * radial, ux * strafeDir + uy * radial]
      // don't strafe out of the zone
      if (!inZoneSoon(zone, x + move[0] * 6, y + move[1] * 6, 3)) { strafeDir = -strafeDir; move = [-uy * strafeDir + ux * radial, ux * strafeDir + uy * radial] }
      // flip if blocked
      if (map.clearAt(x + move[0] * 4, y + move[1] * 4) < 2.7) { strafeDir = -strafeDir; strafeFlipT = t + 0.6; move = [-uy * strafeDir + ux * radial, ux * strafeDir + uy * radial] }
      boost = self.energy > 45 && !(laserS >= 0 && (W[laserS].charge ?? 0) > 0)
    } else {
      // no visible target: drops, loot, cubes, crates, zone positioning, hide
      const quiet = enemies.length === 0 && t - lastDamageT > 4
      let goal: [number, number] | null = null
      // supply drop
      for (const dr of obs.drops ?? []) {
        if (dr.lands_in > 0.5 || dropFailed.has(dr.id)) continue
        const dd = d2(dr.pos, [x, y])
        if (dd < 140 && (quiet || hpFrac < 0.6) && inZoneSoon(zone, dr.pos[0], dr.pos[1], 15) && (dr.holder === null || dr.holder === me_id)) {
          goal = [dr.pos[0], dr.pos[1]]
          label = "drop"
        }
      }
      // cubes
      if (!goal) {
        let bd = 70
        for (const c of obs.cubes) {
          const dd = d2(c.pos, [x, y])
          if (dd < bd && Math.abs(c.pos[2] - z) < 4 && map.clearAt(c.pos[0], c.pos[1]) >= 2.4) { bd = dd; goal = [c.pos[0], c.pos[1]]; label = "cube" }
        }
      }
      if (!goal && lootGoal && (quiet || d2(lootGoal, [x, y]) < 30)) { goal = lootGoal; label = "loot" }
      if (goal && !inZoneSoon(zone, goal[0], goal[1], 10)) goal = null
      if (goal) {
        mode = "collect"
        planTo(x, y, goal[0], goal[1])
        move = followPath(x, y) ?? [goal[0] - x, goal[1] - y]
        if (d2(goal, [x, y]) < 1.5) move = [0, 0]
        boost = self.energy > 60 && hpFrac > 0.5
      } else if (distNext > safeR) {
        mode = "drift"
        const gx = nc[0] + (x - nc[0]) * (safeR * 0.6 / Math.max(distNext, 1e-3))
        const gy = nc[1] + (y - nc[1]) * (safeR * 0.6 / Math.max(distNext, 1e-3))
        planTo(x, y, gx, gy)
        move = followPath(x, y) ?? [0, 0]
        // walk slowly (silent) when not in a hurry
        const L = Math.hypot(move[0], move[1])
        if (L > 0 && timeToShrink > 40) { move = [move[0] * 0.95, move[1] * 0.95] }
      } else {
        mode = "hide"
        move = [0, 0]
      }
    }

    // ---- dodge incoming fire ----
    let dodge: [number, number] | null = null
    for (const p of obs.projectiles) {
      const rx = x - p.pos[0], ry = y - p.pos[1], rz = z + 4.5 - p.pos[2]
      const v2 = p.vel[0] ** 2 + p.vel[1] ** 2 + p.vel[2] ** 2
      if (v2 < 1) continue
      const tc = (rx * p.vel[0] + ry * p.vel[1] + rz * p.vel[2]) / v2
      if (tc < 0 || tc > 0.8) continue
      const cx = p.pos[0] + p.vel[0] * tc - x, cy = p.pos[1] + p.vel[1] * tc - y
      const miss = Math.hypot(cx, cy)
      const thr = p.kind === "mortar" ? 9 : 3.5
      if (miss < thr) {
        const vl = Math.hypot(p.vel[0], p.vel[1]) || 1
        let px = -p.vel[1] / vl, py = p.vel[0] / vl
        if (px * -cx + py * -cy < 0) { px = -px; py = -py }
        dodge = [px, py]
      }
    }
    for (const e of visible) {
      if (!e.charging) continue
      const dd = d2(e.pos, [x, y])
      const ang = Math.atan2(y - e.pos[1], x - e.pos[0])
      if (Math.abs(wrap(e.aim[0] - ang)) * dd < 6) {
        const ux = (x - e.pos[0]) / dd, uy = (y - e.pos[1]) / dd
        dodge = [-uy * strafeDir, ux * strafeDir]
      }
    }
    if (dodge && mode !== "zone") { move = dodge; boost = self.energy > 10 }

    // ---- stuck handling ----
    const sp = Math.hypot(self.vel[0], self.vel[1])
    const wantL = Math.hypot(move[0], move[1])
    if (t < unstickUntil) {
      move = unstickDir
      jump = self.grounded
      boost = true
    } else if (wantL > 0.5 && sp < 1.2 && self.grounded) {
      if (++stuckN > 6) {
        stuckN = 0
        const a = Math.atan2(move[1], move[0]) + (rng() < 0.5 ? 1 : -1) * (0.9 + rng() * 0.9)
        unstickDir = [Math.cos(a), Math.sin(a)]
        unstickUntil = t + 0.7
        path = []
        pathT = -99
      }
    } else stuckN = Math.max(0, stuckN - 1)

    if (t >= unstickUntil && !dodge) move = steerClear(x, y, move)
    const ml = Math.hypot(move[0], move[1])
    if (ml > 1) move = [move[0] / ml, move[1] / ml]

    // ---- aiming and firing ----
    const fire: [boolean, boolean] = [false, false]
    let shootTarget: { pos: V3; vel: V3; cz: number; kind: string; r: number } | null = null
    if (target) shootTarget = { pos: target.pos, vel: target.vel, cz: mechCenterZ(target), kind: "mech", r: cfg.mech.radius * (1 + cfg.cubes.size_per_cube * target.cubes) }
    // farm NPCs/crates when quiet
    const quietFarm = !target && enemies.length === 0 && mode !== "flee" && mode !== "zone"
    if (quietFarm) {
      let bd = 90
      for (const m of obs.mechs) {
        if (m.kind !== "npc") continue
        const dd = d2(m.pos, [x, y])
        if (dd < bd && map.los(x, y, mz, m.pos[0], m.pos[1], m.pos[2] + 1.75, 1)) { bd = dd; shootTarget = { pos: m.pos, vel: m.vel, cz: m.pos[2] + cfg.npc.height / 2, kind: "npc", r: cfg.npc.radius } }
      }
      if (!shootTarget)
        for (const c of obs.crates) {
          const dd = d2(c.pos, [x, y])
          if (dd < bd && map.los(x, y, mz, c.pos[0], c.pos[1], c.pos[2] + 1.2, 1)) { bd = dd; shootTarget = { pos: c.pos, vel: [0, 0, 0], cz: c.pos[2] + cfg.crates.height / 2, kind: "crate", r: cfg.crates.radius } }
        }
    }

    if (shootTarget) {
      const tp: V3 = [shootTarget.pos[0], shootTarget.pos[1], shootTarget.cz]
      const gunW = gunS >= 0 ? W[gunS] : null
      const gs = gunW ? gunW.stats.speed : 252
      const sol = solveAim(self, tp, shootTarget.vel, gs, 0.06)
      aim = [sol.yaw, sol.pitch]
      const yawErr = Math.abs(wrap(self.aim[0] - sol.yaw)) * sol.dist
      const pitErr = Math.abs(self.aim[1] - sol.pitch) * sol.dist
      const tol = shootTarget.r * 0.9 + 0.3
      const los = map.los(x, y, mz, sol.pt[0], sol.pt[1], sol.pt[2], 1.5)
      const onTarget = yawErr < tol && pitErr < 2.5
      if (gunW && los && onTarget && sol.dist < gunW.stats.range * 0.98 && (gunW.ammo ?? 1) > 0) fire[gunS] = true
      if (laserS >= 0) {
        const lw = W[laserS]
        const ls = solveAim(self, tp, shootTarget.vel, Infinity, 0.05)
        const lerr = Math.abs(wrap(self.aim[0] - ls.yaw)) * ls.dist
        const charging = (lw.charge ?? 0) > 0
        const full = (lw.charge ?? 0) >= lw.stats.charge * 0.97
        const losL = map.los(x, y, mz, ls.pt[0], ls.pt[1], ls.pt[2], 1.5)
        if (shootTarget.kind !== "crate" || !charging) {
          if (!charging) {
            if (lw.cooldown <= 0.05 && losL && ls.dist < lw.stats.range && shootTarget.kind !== "crate") fire[laserS] = true
          } else {
            // keep holding until full and on target
            fire[laserS] = !(full && lerr < shootTarget.r * 0.8 && losL)
            if (full) aim = [ls.yaw, ls.pitch]
          }
        }
      }
      if (litS >= 0) {
        const lw = W[litS]
        const yawE = Math.abs(wrap(self.aim[0] - sol.yaw))
        if (sol.dist < lw.stats.range * 0.95 && yawE < (lw.stats.cone_deg * Math.PI) / 360 * 0.8 && self.energy > lw.stats.energy + 8 && lw.cooldown <= 0.05 && los) fire[litS] = true
      }
      if (mortS >= 0 && shootTarget.kind === "mech") {
        const mw = W[mortS]
        if (sol.dist > 25 && sol.dist < 220 && mw.cooldown <= 0.05) {
          const ma = mortarAim(self, [shootTarget.pos[0], shootTarget.pos[1], shootTarget.pos[2]], shootTarget.vel, mw.stats)
          if (ma && gunW && (gunW.ammo === 0 || (gunW.reload ?? 0) > 0)) {
            aim = [ma.yaw, ma.pitch]
            if (Math.abs(wrap(self.aim[0] - ma.yaw)) < 0.03 && Math.abs(self.aim[1] - ma.pitch) < 0.03) fire[mortS] = true
          }
        }
      }
    } else {
      // keep a charged laser from wasting
      if (laserS >= 0 && (W[laserS].charge ?? 0) > 0) fire[laserS] = true
      // look toward threats or scan
      const remembered = enemies.sort((a, b) => d2(a.pos, [x, y]) - d2(b.pos, [x, y]))[0]
      if (remembered) {
        aim = [Math.atan2(remembered.pos[1] - y, remembered.pos[0] - x), 0]
      } else if (t - alertT < 4 && alertYaw !== null) {
        aim = [alertYaw, 0]
      } else if (mode === "hide") {
        scanYaw = wrap(scanYaw + 0.12)
        aim = [scanYaw, 0]
      } else if (Math.hypot(move[0], move[1]) > 0.2) {
        aim = [Math.atan2(move[1], move[0]), 0]
        scanYaw = aim[0]
      }
      if (gunS >= 0 && W[gunS].ammo !== undefined && W[gunS].ammo < W[gunS].stats.mag * 0.5 && !(W[gunS].reload > 0) && enemies.length === 0) act.reload = true
    }

    // ---- supply drop give-up ----
    for (const dr of obs.drops ?? []) if (dr.holder !== null && dr.holder !== me_id && dr.lands_in <= 0) dropFailed.add(dr.id)

    lastPos = [x, y, z]
    lastMoveCmd = move
    act.move = [Math.round(move[0] * 1000) / 1000, Math.round(move[1] * 1000) / 1000]
    act.boost = boost && Math.hypot(move[0], move[1]) > 0.3
    if (jump) act.jump = true
    if (aim) act.aim = [Math.round(aim[0] * 10000) / 10000, Math.round(clamp(aim[1], cfg.mech.min_pitch, cfg.mech.max_pitch) * 10000) / 10000]
    act.fire = fire
    act._dbg = `${mode} ${label} hp${Math.round(self.hp)} e${Math.round(self.energy)} n${near.length}`
    return act
  }

  return { name: "survivor", act }
}
