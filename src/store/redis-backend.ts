import type { CommitPlacement, SeriesUsage, StoreBackend } from './scripted.js';

/**
 * Every operation runs inside this one script, so each is atomic. All keys share the
 * `{prefix}` hash tag (declared through KEYS[1]), which keeps them in one slot and
 * satisfies Upstash's key-locking rules. No cjson: arguments are flat strings.
 *
 * ARGV: [1] op, [2] prefix, [3] now, then op-specific fields.
 */
export const QUOTA_SCRIPT = String.raw`
local p = '{' .. ARGV[2] .. '}:'
local now = tonumber(ARGV[3])
local op = ARGV[1]
local rx = p .. 'rx'

local function adjust(series, bucket, delta)
  local k = p .. 's:' .. series
  local cur = redis.call('HGET', k, bucket)
  if cur then
    local v = tonumber(cur) + delta
    if v < 0 then v = 0 end
    redis.call('HSET', k, bucket, string.format('%d', v))
  end
end

local function undo(id)
  for _, f in ipairs(redis.call('HVALS', p .. 'r:' .. id)) do
    local series, bucket, amount = string.match(f, '^(.*)\t([^\t]+)\t([^\t]+)$')
    adjust(series, bucket, -tonumber(amount))
  end
end

local function sweep()
  for _, id in ipairs(redis.call('ZRANGEBYSCORE', rx, '-inf', now)) do
    undo(id)
    redis.call('DEL', p .. 'r:' .. id)
    redis.call('ZREM', rx, id)
  end
end

-- A provider floor (see floor.ts): the reading, flat or draining linearly from 'used'
-- at 'at' to 0 at 'until', plus 'added' calls reserved since the reading.
-- Returns current value, used, until, at, drain, added.
local function readFloor(series)
  local f = redis.call('HMGET', p .. 'f:' .. series, 'used', 'until', 'at', 'drain', 'added')
  if not f[1] or tonumber(f[2]) <= now then return 0, 0, 0, 0, 0, 0 end
  local used, untilMs, at = tonumber(f[1]), tonumber(f[2]), tonumber(f[3])
  local drain, added = tonumber(f[4]), tonumber(f[5] or '0') or 0
  local reading = used
  if drain == 1 and at < untilMs then reading = used * (untilMs - now) / (untilMs - at) end
  return reading + added, used, untilMs, at, drain, added
end

local function rank(w)
  if w == -1 then return math.huge end
  return w
end

if op == 'reserve' then
  sweep()
  local ttl, id, n = tonumber(ARGV[4]), ARGV[5], tonumber(ARGV[6])
  local worst, worstIdx = 0, 0
  for i = 0, n - 1 do
    local b = 7 + i * 10
    local series = ARGV[b]
    local need, limit, from = tonumber(ARGV[b + 1]), tonumber(ARGV[b + 2]), tonumber(ARGV[b + 3])
    local kind, windowMs, bucketMs, nextReset = tonumber(ARGV[b + 5]), tonumber(ARGV[b + 6]), tonumber(ARGV[b + 7]), tonumber(ARGV[b + 8])
    local sk = p .. 's:' .. series
    local all = redis.call('HGETALL', sk)
    local live, used = {}, 0
    for j = 1, #all, 2 do
      local start, amount = tonumber(all[j]), tonumber(all[j + 1])
      if start < from then
        redis.call('HDEL', sk, all[j])
      else
        used = used + amount
        live[#live + 1] = { start, amount }
      end
    end
    local floorNow, floorUsed, floorUntil, floorAt, floorDrain, floorAdded = readFloor(series)
    local wait = 0
    if floorNow > used and floorNow + need > limit then
      local room = limit - need - floorAdded
      if need > limit then
        wait = -1
      elseif floorDrain == 1 and floorAt < floorUntil and room >= 0 then
        local fitsAt = floorUntil - room * (floorUntil - floorAt) / floorUsed
        wait = math.min(floorUntil - now, math.max(1, math.ceil(fitsAt - now)))
      else
        wait = floorUntil - now
      end
    elseif need > limit then
      wait = -1
    elseif used + need > limit then
      if kind == 1 then
        wait = nextReset
      else
        table.sort(live, function(x, y) return x[1] < y[1] end)
        local excess, freed = used + need - limit, 0
        for _, e in ipairs(live) do
          freed = freed + e[2]
          if freed >= excess then
            wait = e[1] + bucketMs + windowMs - now
            break
          end
        end
      end
    end
    if wait ~= 0 and (worstIdx == 0 or rank(wait) > rank(worst)) then
      worst, worstIdx = wait, i + 1
    end
  end
  if worstIdx > 0 then return { 0, worst, worstIdx } end
  if n > 0 then
    local rk = p .. 'r:' .. id
    for i = 0, n - 1 do
      local b = 7 + i * 10
      local sk = p .. 's:' .. ARGV[b]
      redis.call('HINCRBY', sk, ARGV[b + 4], ARGV[b + 1])
      redis.call('PEXPIRE', sk, ARGV[b + 9])
      local fk = p .. 'f:' .. ARGV[b]
      local fu = redis.call('HGET', fk, 'until')
      if fu and tonumber(fu) > now then redis.call('HINCRBY', fk, 'added', ARGV[b + 1]) end
      redis.call('HSET', rk, tostring(i + 1), ARGV[b] .. '\t' .. ARGV[b + 4] .. '\t' .. ARGV[b + 1])
    end
    redis.call('PEXPIRE', rk, ttl + 3600000)
    redis.call('ZADD', rx, string.format('%d', now + ttl), id)
  end
  return { 1 }
end

if op == 'commit' then
  sweep()
  local id, hasActual, actual, n = ARGV[4], ARGV[5] == '1', tonumber(ARGV[6]), tonumber(ARGV[7])
  local rk = p .. 'r:' .. id
  local live = redis.call('EXISTS', rk) == 1
  if live then
    redis.call('DEL', rk)
    redis.call('ZREM', rx, id)
  end
  for i = 0, n - 1 do
    local b = 8 + i * 6
    local series, bucket, amount, isToken, nowBucket, keep = ARGV[b], ARGV[b + 1], tonumber(ARGV[b + 2]), ARGV[b + 3] == '1', ARGV[b + 4], ARGV[b + 5]
    if live then
      if hasActual and isToken then adjust(series, bucket, actual - amount) end
    else
      local amt = amount
      if hasActual and isToken then amt = actual end
      local sk = p .. 's:' .. series
      redis.call('HINCRBY', sk, nowBucket, string.format('%d', amt))
      redis.call('PEXPIRE', sk, keep)
    end
  end
  return 1
end

if op == 'release' then
  sweep()
  local id = ARGV[4]
  local rk = p .. 'r:' .. id
  if redis.call('EXISTS', rk) == 1 then
    undo(id)
    redis.call('DEL', rk)
    redis.call('ZREM', rx, id)
  end
  return 1
end

if op == 'truth' then
  local n = tonumber(ARGV[4])
  for i = 0, n - 1 do
    local b = 5 + i * 4
    local fk = p .. 'f:' .. ARGV[b]
    local used, untilMs = tonumber(ARGV[b + 1]), tonumber(ARGV[b + 2])
    local current, _, _, _, curDrain = readFloor(ARGV[b])
    if used >= current or (curDrain == 1 and ARGV[b + 3] == '0') then
      redis.call('HSET', fk, 'used', ARGV[b + 1], 'until', ARGV[b + 2], 'at', string.format('%d', now), 'drain', ARGV[b + 3], 'added', '0')
      redis.call('PEXPIRE', fk, math.max(1000, untilMs - now))
    end
  end
  return 1
end

if op == 'usage' then
  sweep()
  local n = tonumber(ARGV[4])
  local out = {}
  for i = 0, n - 1 do
    local b = 5 + i * 2
    local series, from = ARGV[b], tonumber(ARGV[b + 1])
    local _, floorUsed, floorUntil, floorAt, floorDrain, floorAdded = readFloor(series)
    local row = { floorUsed, floorUntil, floorAt, floorDrain, floorAdded }
    local all = redis.call('HGETALL', p .. 's:' .. series)
    for j = 1, #all, 2 do
      if tonumber(all[j]) >= from then
        row[#row + 1] = tonumber(all[j])
        row[#row + 1] = tonumber(all[j + 1])
      end
    end
    out[#out + 1] = row
  end
  return out
end

if op == 'cd-set' then
  local ck = p .. 'c:' .. ARGV[4]
  local cur = redis.call('GET', ck)
  if not cur or tonumber(cur) < tonumber(ARGV[5]) then
    redis.call('SET', ck, ARGV[5], 'PX', ARGV[6])
  end
  return 1
end

if op == 'cd-get' then
  return redis.call('GET', p .. 'c:' .. ARGV[4])
end

if op == 'st-set' then
  redis.call('SET', p .. 'k:' .. ARGV[4], ARGV[5] .. '\t' .. ARGV[6], 'PX', ARGV[7])
  return 1
end

if op == 'st-get' then
  return redis.call('GET', p .. 'k:' .. ARGV[4])
end

-- Adaptive limits (see adaptive.ts). Factors are returned as strings: integer replies would truncate them.
if op == 'ad-set' then
  local k = p .. 'a:' .. ARGV[4]
  local step, minF, recover, debounce = tonumber(ARGV[5]), tonumber(ARGV[6]), tonumber(ARGV[7]), tonumber(ARGV[8])
  local v = redis.call('HMGET', k, 'f', 'at')
  local cur = 1
  if v[1] then
    local f0, at = tonumber(v[1]), tonumber(v[2])
    cur = math.min(1, f0 + math.max(0, now - at) / recover * (1 - f0))
    if now - at < debounce then return { tostring(cur), 0 } end
  end
  local nf = math.max(minF, cur * step)
  redis.call('HSET', k, 'f', tostring(nf), 'at', string.format('%d', now))
  redis.call('PEXPIRE', k, recover + 60000)
  return { tostring(nf), 1 }
end

if op == 'ad-get' then
  local n = tonumber(ARGV[4])
  local out = {}
  for i = 1, n do
    local v = redis.call('HMGET', p .. 'a:' .. ARGV[4 + i], 'f', 'at')
    out[#out + 1] = v[1] or ''
    out[#out + 1] = v[2] or ''
  end
  return out
end

return redis.error_reply('ai-sdk-quota: unknown op ' .. tostring(op))
`;

/** Runs QUOTA_SCRIPT with `KEYS[1]` and `argv`; returns the raw reply. */
export type RunScript = (key: string, argv: string[]) => Promise<unknown>;

const int = (n: number) => String(Math.round(n));

/** A StoreBackend that talks to any Redis-compatible server through QUOTA_SCRIPT. */
export function redisBackend(run: RunScript, prefix: string): StoreBackend {
  if (/[{}]/.test(prefix)) throw new Error('ai-sdk-quota: the store prefix must not contain { or }');
  const lockKey = `{${prefix}}:lock`;
  const call = (op: string, now: number, rest: string[]) => run(lockKey, [op, prefix, int(now), ...rest]);

  return {
    async reserve({ ops, id, now, ttlMs }) {
      const flat = ops.flatMap((o) => [
        o.series,
        int(o.need),
        int(o.limit),
        int(o.from),
        int(o.bucket),
        String(o.kind),
        int(o.windowMs),
        int(o.bucketMs),
        int(o.nextResetMs),
        int(o.keepMs),
      ]);
      const reply = (await call('reserve', now, [int(ttlMs), id, String(ops.length), ...flat])) as number[];
      return Number(reply[0]) === 1 ? { ok: true } : { ok: false, wait: Number(reply[1]), index: Number(reply[2]) };
    },

    async commit({ id, actual, placements, now }) {
      const flat = placements.flatMap((p: CommitPlacement) => [
        p.series,
        int(p.bucket),
        int(p.amount),
        p.isToken ? '1' : '0',
        int(p.nowBucket),
        int(p.keepMs),
      ]);
      await call('commit', now, [id, actual === undefined ? '0' : '1', int(actual ?? 0), String(placements.length), ...flat]);
    },

    async release({ id, now }) {
      await call('release', now, [id]);
    },

    async truth({ entries, now }) {
      await call('truth', now, [
        String(entries.length),
        ...entries.flatMap((e) => [e.series, int(e.used), int(e.until), e.drain ? '1' : '0']),
      ]);
    },

    async usage({ entries, now }) {
      const reply = (await call('usage', now, [
        String(entries.length),
        ...entries.flatMap((e) => [e.series, int(e.from)]),
      ])) as number[][];
      return reply.map((row): SeriesUsage => {
        const nums = row.map(Number);
        const buckets: [number, number][] = [];
        for (let i = 5; i < nums.length; i += 2) buckets.push([nums[i]!, nums[i + 1]!]);
        return { floorUsed: nums[0]!, floorUntil: nums[1]!, floorAt: nums[2]!, floorDrain: nums[3] === 1, floorAdded: nums[4]!, buckets };
      });
    },

    async setCooldown(memberId, until, ttlMs) {
      await call('cd-set', 0, [memberId, int(until), int(ttlMs)]);
    },

    async getCooldown(memberId) {
      const v = await call('cd-get', 0, [memberId]);
      return v === null || v === undefined ? undefined : Number(v);
    },

    async setSticky(key, memberId, until, ttlMs) {
      await call('st-set', 0, [key, memberId, int(until), int(ttlMs)]);
    },

    async adapt(key, now, o) {
      const reply = (await call('ad-set', now, [key, String(o.step), String(o.min), int(o.recoverMs), int(o.debounceMs)])) as [
        string,
        number,
      ];
      return { factor: Number(reply[0]), changed: Number(reply[1]) === 1 };
    },

    async getAdapted(keys) {
      const reply = (await call('ad-get', 0, [String(keys.length), ...keys])) as string[];
      return keys.map((_, i) => {
        const factor = reply[2 * i];
        return factor ? { factor: Number(factor), at: Number(reply[2 * i + 1]) } : undefined;
      });
    },

    async getSticky(key) {
      const v = await call('st-get', 0, [key]);
      if (typeof v !== 'string') return undefined;
      const tab = v.lastIndexOf('\t');
      return { memberId: v.slice(0, tab), until: Number(v.slice(tab + 1)) };
    },
  };
}

let shaPromise: Promise<string> | undefined;

/** SHA-1 of the script for EVALSHA, via Web Crypto (works in Node, edge and Workers). */
export function scriptSha(): Promise<string> {
  shaPromise ??= crypto.subtle.digest('SHA-1', new TextEncoder().encode(QUOTA_SCRIPT)).then((buf) =>
    [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''),
  );
  return shaPromise;
}

export function isNoScript(error: unknown): boolean {
  return /NOSCRIPT/i.test(error instanceof Error ? error.message : String(error));
}
