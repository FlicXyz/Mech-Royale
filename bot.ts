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

const VAR: string = "noprovoke+steady+regen"
const V = new Set(VAR.split("+"))
const UPGRADE_PRI = [
  "plating", "armor", "nanites", "gun_damage", "laser_damage", "gun_rate", "laser_charge", "lightning_efficiency",
  "gun_mag", "servos", "sensors", "gun_velocity", "capacitor", "reactor", "jets", "gyros", "lightning_range",
  "lightning_chain", "mortar_reload", "mortar_velocity", "mortar_splash", "laser_pierce",
]
const UPGRADE_DMG = [
  "laser_damage", "gun_damage", "laser_charge", "gun_rate", "plating", "armor", "lightning_efficiency", "nanites",
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
  const attackers = new Map<number, number>()
  let hideSpot: [number, number] | null = null
  let hideT = -99
  const sounds: [number, number, number, number][] = []
  let healMode = false
  const crateMem = new Map<number, V3>()
  const pickMem = new Map<number, { id: number; kind: string; pos: number[] }>()
  let myKills = 0
  let squad = false // practice: house bots team up and never fight each other
  let ffaSeen = false
  const posHist: [number, number, number, number][] = []
  const stuckEvents: number[] = []
  let unstickJet = false
  let npcAtkT = -99

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
    const p = map.path(x, y, gx, gy, 14000)
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
        let s = -seen * 100 - R * 0.6 - noiseAt(cx, cy) * 15
        // moving away from threats is good
        for (const th of threats) s += Math.min(60, d2(th.pos, [cx, cy]) - d2(th.pos, [x, y])) * 0.5
        if (!inZoneSoon(zone, cx, cy, 8, 2)) s -= 150
        if (!map.walkLine(x, y, cx, cy, 2.6)) s -= 25
        if (s > bestS) { bestS = s; best = [cx, cy] }
      }
    }
    return best
  }

  function noiseAt(px: number, py: number): number {
    if (!V.has("ears")) return 0
    let v = 0
    for (const s of sounds) {
      const dd = Math.hypot(px - s[1], py - s[2])
      v += (s[3] * (1 - (t - s[0]) / 25)) / (1 + (dd / 45) ** 2)
    }
    return v
  }

  function chooseHide(x: number, y: number, nc: [number, number], safeR: number): [number, number] | null {
    let best: [number, number] | null = null, bs = 1e9
    const R = Math.min(120, safeR + 40)
    for (let k = 0; k < 160; k++) {
      const a = rng() * TAU, r = Math.sqrt(rng()) * R
      const cx = x + Math.cos(a) * r, cy = y + Math.sin(a) * r
      if (d2([cx, cy], nc) > safeR * 0.85) continue
      if (map.clearAt(cx, cy) < 3.2) continue
      const s = map.expoAt(cx, cy) * 100 + (map.costAt(cx, cy) - 1) * 15 + r * 0.25 + noiseAt(cx, cy) * 12 + (d2([cx, cy], nc) / Math.max(safeR, 1)) * 15
      if (s < bs) { bs = s; best = [cx, cy] }
    }
    if (!best) {
      const r = Math.min(safeR * 0.4, d2([x, y], nc))
      const a = Math.atan2(y - nc[1], x - nc[0])
      best = [nc[0] + Math.cos(a) * r, nc[1] + Math.sin(a) * r]
    }
    return best
  }

  function pickUpgrade(offer: any): number {
    let bi = 0, bp = 1e9
    offer.choices.forEach((c: any, i: number) => {
      const p = (V.has("dmgup") ? UPGRADE_DMG : UPGRADE_PRI).indexOf(c.id)
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
    for (const c of obs.crates) crateMem.set(c.id, [c.pos[0], c.pos[1], c.pos[2]])
    for (const p of obs.pickups) pickMem.set(p.id, { id: p.id, kind: p.kind, pos: p.pos })
    for (const [id, pm] of pickMem) {
      if (d2(pm.pos, [x, y]) < 30 && !obs.pickups.some((p: any) => p.id === id) && map.see(x, y, z + 8, pm.pos[0], pm.pos[1], pm.pos[2] + 0.5)) pickMem.delete(id)
    }
    for (const [id, cp] of crateMem) {
      // forget crates we should see but don't (destroyed)
      if (d2(cp, [x, y]) < 40 && !obs.crates.some((c: any) => c.id === id) && map.see(x, y, z + 8, cp[0], cp[1], cp[2] + 1.5)) crateMem.delete(id)
    }

    for (const e of obs.events) {
      if (e.type === "damaged") {
        lastDamageT = t
        if (e.by !== null && e.by !== undefined && e.bearing !== null) {
          if (!obs.mechs.some((m: any) => m.id === e.by)) { alertYaw = e.bearing; alertT = t }
        }
      } else if (e.type === "hit") lastDealT = t
      else if (e.type === "kill") myKills++
      else if (e.type === "take_failed") takeFail.set(e.id, t)
    }
    // sound danger map: estimated source points, decaying over 25 s
    for (const s of obs.sounds) {
      if (s.kind === "npc_gun" || s.kind === "drop" || s.bearing === null || s.bearing === undefined) continue
      const r = s.dist === "near" ? 35 : s.dist === "mid" ? 110 : 230
      const w = s.kind === "death" ? 0.5 : s.kind === "step" || s.kind === "boost" || s.kind === "jet" ? 1.5 : 1
      sounds.push([t - (s.age ?? 0), x + Math.cos(s.bearing) * r, y + Math.sin(s.bearing) * r, w])
    }
    while (sounds.length && (t - sounds[0][0] > 25 || sounds.length > 200)) sounds.shift()
    for (const s of obs.sounds) {
      if ((["gun", "laser", "laser_charge", "lightning", "mortar"].includes(s.kind) && s.dist !== "far" || (["step", "boost", "jet", "reload"].includes(s.kind))) && t - alertT > 2) {
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
    for (const p of pickMem.values()) {
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
      if (dd < (squad ? 170 : 110) && Math.abs(p.pos[2] - z) < 4 && sc > lootScore - 1e-9 && map.clearAt(p.pos[0], p.pos[1]) >= 2.5) { lootScore = sc; lootGoal = [p.pos[0], p.pos[1]] }
    }

    // ---- threats ----
    const enemies = [...tracks.values()].filter((tr) => t - tr.seen < 5)
    const visible = enemies.filter((e) => e.visible)
    const near = enemies.filter((e) => d2(e.pos, [x, y]) < 160)
    const mz = z + (self.stats?.muzzle_height ?? 7)
    for (const e of obs.events) if (e.type === "damaged" && typeof e.by === "number" && e.by < 100) attackers.set(e.by, t)
    for (const [id, tt] of attackers) if (t - tt > 4) attackers.delete(id)
    // who can see / is aiming at me
    const watchers: Track[] = []
    for (const e of enemies) {
      const dd = d2(e.pos, [x, y])
      if (dd > 210) continue
      const seesMe = attackers.has(e.id) || map.see(e.pos[0], e.pos[1], e.pos[2] + 8, x, y, z + 6)
      if (!seesMe) continue
      const bearing = Math.atan2(y - e.pos[1], x - e.pos[0])
      const facing = Math.abs(wrap(e.aim[0] - bearing)) < (dd < 45 ? Math.PI : 1.05)
      if (attackers.has(e.id) || facing) watchers.push(e)
    }
    const aimingAtMe = enemies.filter((e) => {
      const dd = d2(e.pos, [x, y])
      const bearing = Math.atan2(y - e.pos[1], x - e.pos[0])
      return dd < 160 && Math.abs(wrap(e.aim[0] - bearing)) * dd < 8 && map.see(e.pos[0], e.pos[1], e.pos[2] + 8, x, y, z + 6)
    })
    const engaged = attackers.size > 0 || aimingAtMe.length > 0
    // primary target: visible, LOS, prefer attackers, close, weak
    let target: Track | null = null
    let tScore = -1e9
    for (const e of visible) {
      const dd = d2(e.pos, [x, y])
      const los = map.los(x, y, mz, e.pos[0], e.pos[1], mechCenterZ(e), 1.5)
      let s = -dd - (e.hp / e.maxhp) * 60 + (los ? 80 : 0) + (attackers.has(e.id) ? 60 : 0) - (V.has("focus") ? e.hp * 0.12 : 0)
      if (dd > 230) s -= 200
      if (s > tScore) { tScore = s; target = e }
    }
    const tDist = target ? d2(target.pos, [x, y]) : 1e9
    const tLos = target ? map.los(x, y, mz, target.pos[0], target.pos[1], mechCenterZ(target), 1.5) : false
    const weakTarget = !!target && tLos && tDist < 140 && target.hp < Math.min(380, self.hp * 0.5) && hpFrac > 0.35
    const opponents = watchers.length
    // detect the practice setting: nobody dies unless we kill them
    if (obs.alive + myKills < 16 - 0.5 && t < 300) ffaSeen = true
    squad = !(V.has("earlyhide") && laserS < 0 && t < 100) // aggressive dueling won in both settings (11.2 vs 10.7 pts over ~210 live FFA games each)
    const fightable = squad
      ? engaged && !!target && tLos && opponents <= 1 && (hpFrac > (V.has("bold") ? 0.25 : V.has("cautious") ? 0.55 : 0.4) || target.hp < self.hp * 1.1 || tDist < 25)
      : engaged && !!target && tLos && opponents <= 1 && (hpFrac > 0.5 || target.hp < self.hp * 0.6 || tDist < 30) && target.hp < self.hp * 1.5
    const wantShoot = !!target && tLos && (engaged || weakTarget || tDist < 40 || (squad && !V.has("noprovoke") && tDist < 160 && hpFrac > 0.5 && opponents <= 1))

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
    // urgent only if we are (or will soon be) outside the shrinking circle
    const edgeNow = zNow.r - d2([x, y], zNow.c)
    const needZone = outside || !inZoneSoon(zone, x, y, 6 + Math.max(0, 25 - edgeNow) / 10, 3) || (lateGame && distNext > nr * 0.8)
    const sneak = (m: [number, number], f = 0.4): [number, number] => {
      const L = Math.hypot(m[0], m[1]) || 1
      return [(m[0] / L) * f, (m[1] / L) * f]
    }

    let label = ""
    if (outside || (needZone && !fightable)) {
      mode = "zone"
      const gx = nc[0] + (x - nc[0]) * (safeR * 0.6 / Math.max(distNext, 1e-3))
      const gy = nc[1] + (y - nc[1]) * (safeR * 0.6 / Math.max(distNext, 1e-3))
      planTo(x, y, gx, gy)
      move = followPath(x, y) ?? [gx - x, gy - y]
      boost = (outside && self.energy > 30) || (timeToShrink < 10 && self.energy > 40) || self.energy > 75 || (engaged && self.energy > 30)
      if (!outside && !engaged && timeToShrink > 30 && enemies.length === 0) { move = sneak(move, 0.95); boost = false }
    } else if ((engaged && !fightable && !weakTarget) || (!engaged && watchers.length > 0 && !weakTarget && !(squad && wantShoot))) {
      // break line of sight
      mode = engaged ? "evade" : "slip"
      const threats = watchers.length ? watchers : near
      if (!fleeTarget || t - fleeT > 1.0) { fleeTarget = findCover(self, threats, zone); fleeT = t }
      if (fleeTarget) {
        planTo(x, y, fleeTarget[0], fleeTarget[1], t - pathT > 1.0)
        move = followPath(x, y) ?? [fleeTarget[0] - x, fleeTarget[1] - y]
        if (d2(fleeTarget, [x, y]) < 2.5) move = [0, 0]
      }
      const closest = Math.min(...threats.map((e) => d2(e.pos, [x, y])))
      if (engaged || closest < 70) boost = self.energy > 12
      else move = sneak(move, 0.42)
    } else if (target && (fightable || weakTarget || (squad && wantShoot))) {
      mode = "fight"
      const dd = tDist
      const ux = (target.pos[0] - x) / (dd || 1), uy = (target.pos[1] - y) / (dd || 1)
      if (t > strafeFlipT) {
        strafeDir = rng() < 0.5 ? -strafeDir : strafeDir
        if (V.has("wall") && rng() < 0.7) {
          // prefer the side that is more boxed in by buildings
          const e1 = map.expoAt(x - uy * 7, y + ux * 7), e2 = map.expoAt(x + uy * 7, y - ux * 7)
          strafeDir = e1 <= e2 ? 1 : -1
        }
        strafeFlipT = V.has("jitter") ? t + 0.2 + rng() * 0.45 : V.has("calm") ? t + 1.6 + rng() * 1.6 : V.has("steady") ? t + 0.9 + rng() * 1.2 : t + 0.45 + rng() * 0.9
      }
      const hasLit = litS >= 0 && self.energy > 15
      const tw = target.weapons ?? []
      const enemyLit = tw.includes("lightning")
      const enemyMort = tw.includes("mortar")
      let prefMin = V.has("far") ? 75 : V.has("near") ? 22 : 40, prefMax = V.has("far") ? 150 : V.has("near") ? 55 : weakTarget ? 70 : 110
      let kite = false
      if (hasLit && !enemyMort && (!enemyLit || target.hp < self.hp)) { prefMin = 12; prefMax = 32 }
      else if (enemyLit) { prefMin = 58; prefMax = 120; kite = dd < 58 }
      let radial = 0
      if (dd < prefMin) radial = kite ? -1.6 : -0.7
      else if (dd > prefMax) radial = 0.8
      move = [-uy * strafeDir + ux * radial, ux * strafeDir + uy * radial]
      if (!inZoneSoon(zone, x + move[0] * 6, y + move[1] * 6, 3)) { strafeDir = -strafeDir; move = [-uy * strafeDir + ux * radial, ux * strafeDir + uy * radial] }
      if (map.clearAt(x + move[0] * 4, y + move[1] * 4) < 2.7) { strafeDir = -strafeDir; strafeFlipT = t + 0.6; move = [-uy * strafeDir + ux * radial, ux * strafeDir + uy * radial] }
      boost = (self.energy > (V.has("jink") ? 15 : V.has("saveboost") ? 70 : 45) || (kite && self.energy > 8)) && !(laserS >= 0 && (W[laserS].charge ?? 0) > 0)
      if (hasLit && prefMax < 40 && self.energy < 50 && dd < 40) boost = false
    } else {
      // unseen: drops, loot, cubes, hide
      const quiet = enemies.length === 0 && t - lastDamageT > 4
      let goal: [number, number] | null = null
      const healing = V.has("regen") && (hpFrac < 0.55 || (healMode && hpFrac < 0.92)) && !needZone
      healMode = healing
      for (const dr of obs.drops ?? []) {
        if (dr.lands_in > 0.5 || dropFailed.has(dr.id)) continue
        const dd = d2(dr.pos, [x, y])
        if (dd < (squad ? 220 : 120) && (quiet || (squad && !engaged)) && inZoneSoon(zone, dr.pos[0], dr.pos[1], 15) && (dr.holder === null || dr.holder === me_id)) { goal = [dr.pos[0], dr.pos[1]]; label = "drop" }
      }
      if (!goal) {
        let bd = engaged ? 25 : squad ? 90 : enemies.length ? 35 : 70
        for (const c of obs.cubes) {
          const dd = d2(c.pos, [x, y])
          if (dd < bd && Math.abs(c.pos[2] - z) < 4 && map.clearAt(c.pos[0], c.pos[1]) >= 2.4) { bd = dd; goal = [c.pos[0], c.pos[1]]; label = "cube" }
        }
      }
      if (!goal && lootGoal && (quiet || (squad && !engaged) || d2(lootGoal, [x, y]) < 25)) { goal = lootGoal; label = "loot" }
      if (!goal && squad && !engaged && t < 330 && hpFrac > 0.6) {
        // farm crates: walk until within shooting distance with line of sight
        let bd = 160
        for (const [, cp] of crateMem) {
          const dd = d2(cp, [x, y])
          if (dd < bd && Math.abs(cp[2] - z) < 6 && inZoneSoon(zone, cp[0], cp[1], 20)) { bd = dd; goal = [cp[0], cp[1]]; label = "crate" }
        }
        if (goal && bd < 30 && map.los(x, y, mz, goal[0], goal[1], map.groundAt(goal[0], goal[1]) + 1.2, 1)) goal = [x, y]
      }
      if (goal && !inZoneSoon(zone, goal[0], goal[1], 10)) goal = null
      if (goal && healing && label !== "drop" && d2(goal, [x, y]) > 12) goal = null
      if (goal) {
        mode = "collect"
        planTo(x, y, goal[0], goal[1])
        move = followPath(x, y) ?? [goal[0] - x, goal[1] - y]
        if (d2(goal, [x, y]) < 1.5) move = [0, 0]
        boost = quiet && self.energy > 60 && d2(goal, [x, y]) > 20
        if (!quiet && !squad) move = sneak(move, 0.42)
      } else {
        // pick / keep a hiding spot inside the safe area
        const hs = hideSpot
        const bad = !hs || d2(hs, nc) > safeR || t - hideT > 25
        if (bad && t - hideT > 2) { hideSpot = chooseHide(x, y, nc, safeR); hideT = t }
        if (hideSpot && d2(hideSpot, [x, y]) > 2.5) {
          mode = "tohide"
          planTo(x, y, hideSpot[0], hideSpot[1])
          move = followPath(x, y) ?? [hideSpot[0] - x, hideSpot[1] - y]
          const far = d2(hideSpot, [x, y]) > 60 && enemies.length === 0
          move = far ? move : sneak(move, 0.42)
          boost = false
        } else {
          mode = "hide"
          move = [0, 0]
        }
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
    const wantL = Math.hypot(move[0], move[1])
    posHist.push([t, x, y, wantL > 0.35 ? 1 : 0])
    while (posHist.length && t - posHist[0][0] > 1.6) posHist.shift()
    const old = posHist[0]
    const allWant = posHist.every((p) => p[3] === 1)
    if (t < unstickUntil) {
      move = unstickDir
      if (unstickJet) { jump = self.grounded; boost = self.energy > 3 } else boost = false
    } else if (allWant && t - old[0] > 1.4 && Math.hypot(x - old[1], y - old[2]) < 2.5) {
      stuckEvents.push(t)
      while (stuckEvents.length && t - stuckEvents[0] > 12) stuckEvents.shift()
      posHist.length = 0
      const ma = Math.atan2(move[1], move[0])
      if (self.energy > 35 && stuckEvents.length % 2 === 1) {
        // climb: jump and jet straight toward where we want to go
        unstickJet = true
        unstickDir = [Math.cos(ma), Math.sin(ma)]
        unstickUntil = t + 1.3
      } else {
        unstickJet = self.energy > 15
        const a = ma + (rng() < 0.5 ? 1 : -1) * (1.2 + rng() * 1.2)
        unstickDir = [Math.cos(a), Math.sin(a)]
        unstickUntil = t + 0.9
      }
      path = []
      pathT = -99
    }

    if (t >= unstickUntil && !dodge) move = steerClear(x, y, move)
    const ml = Math.hypot(move[0], move[1])
    if (ml > 1) move = [move[0] / ml, move[1] / ml]

    // ---- aiming and firing ----
    const fire: [boolean, boolean] = [false, false]
    let shootTarget: { pos: V3; vel: V3; cz: number; kind: string; r: number } | null = null
    if (target && wantShoot) shootTarget = { pos: target.pos, vel: target.vel, cz: mechCenterZ(target), kind: "mech", r: cfg.mech.radius * (1 + cfg.cubes.size_per_cube * target.cubes) }
    // farm NPCs/crates when quiet
    const npcAtk = obs.events.some((e: any) => e.type === "damaged" && typeof e.by === "number" && e.by >= 100)
    if (npcAtk) npcAtkT = t
    const quietFarm = !shootTarget && ((enemies.length === 0 && mode !== "evade" && mode !== "zone") || t - npcAtkT < 3 || (squad && !engaged && mode !== "evade"))
    if (quietFarm) {
      let bd = 90
      for (const m of obs.mechs) {
        if (m.kind !== "npc") continue
        const dd = d2(m.pos, [x, y])
        if (dd < bd && map.los(x, y, mz, m.pos[0], m.pos[1], m.pos[2] + 1.75, 1)) { bd = dd; shootTarget = { pos: m.pos, vel: m.vel, cz: m.pos[2] + cfg.npc.height / 2, kind: "npc", r: cfg.npc.radius } }
      }
      if (!shootTarget && (enemies.length === 0 || squad))
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
        // ears: look toward the loudest recent area half the time, sweep otherwise
        let best = -1, by = 0
        if (V.has("ears")) for (const s of sounds) { const w = s[3] * (1 - (t - s[0]) / 25); if (w > best) { best = w; by = Math.atan2(s[2] - y, s[1] - x) } }
        scanYaw = wrap(scanYaw + 0.12)
        aim = [best > 0.3 && Math.floor(t / 3) % 2 === 0 ? by : scanYaw, 0]
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
    act._dbg = `${mode}${squad ? '*' : ''} ${label} hp${Math.round(self.hp)} e${Math.round(self.energy)} n${near.length}`
    return act
  }

  return { name: "survivor", act }
}
