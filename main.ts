// stdin/stdout loop for mechfight/1. Answers only the newest observation.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GameMap } from "./map.ts"
import { makeBot } from "./bot.ts"

const send = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n")
const log = (...a: unknown[]) => console.error(...a)

let bot: { name: string; act(o: any): any } | null = null
let last: any = {}
let errors = 0
let buf = ""
let queued = false

function seeded(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

function onHello(msg: any) {
  try {
    const dir = msg.map?.dir ?? "/arena"
    const world = JSON.parse(readFileSync(join(dir, "v2/world.json"), "utf8"))
    const tb = readFileSync(join(dir, "v2/terrain.i16"))
    const terrain = new Int16Array(tb.buffer.slice(tb.byteOffset, tb.byteOffset + tb.length))
    const map = new GameMap(world, terrain)
    bot = makeBot(msg, map, seeded(msg.seed ?? 1))
  } catch (e) {
    log("init failed", e)
  }
  send({ type: "ready", name: "survivor" })
}

function handle(lines: string[]) {
  let latest: any = null
  for (const line of lines) {
    let msg: any
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.type === "hello") onHello(msg)
    else if (msg.type === "obs") latest = msg
    else if (msg.type === "end") process.exit(0)
  }
  if (!latest) return
  let action: any = {}
  if (bot)
    try {
      action = bot.act(latest)
      last = { move: action.move, aim: action.aim, boost: action.boost }
    } catch (e) {
      errors++
      if (errors <= 5 || errors % 100 === 0) log(`act failed tick ${latest.tick}:`, e)
      action = { ...last }
    }
  const dbg = action._dbg
  delete action._dbg
  if (dbg) action.debug = { label: String(dbg).slice(0, 80) }
  action.tick = latest.tick
  send(action)
}

process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  buf += chunk
  if (queued) return
  queued = true
  setImmediate(flush)
})
function flush() {
  queued = false
  const lines = buf.split("\n")
  buf = lines.pop() ?? ""
  handle(lines.filter((l) => l.trim()))
}
process.stdin.on("end", () => { buf += "\n"; flush() })
