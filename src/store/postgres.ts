import type { SeriesUsage, StoreBackend } from './scripted.js';
import { createScriptedStore } from './scripted.js';
import type { QuotaStore } from './types.js';

/** Anything with a `pg`-style `query(text, params)`: a `pg` Pool or Client, PGlite, or a small wrapper. */
export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface PostgresStoreOptions {
  /** Schema that holds the tables and `quota_op()`; must match `postgresSchemaSql()`. Default `'public'`. */
  schema?: string;
  /** Namespaces all keys, so several pools can share the tables. Default `'aisq'`. */
  prefix?: string;
}

function ident(schema: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`ai-sdk-quota: invalid schema name "${schema}"`);
  return schema;
}

/**
 * SQL that creates the tables and the `quota_op()` function. Run it once (a migration).
 * Every table has RLS on with no policies, and the function runs as its owner, so on
 * Supabase only roles you grant EXECUTE to (e.g. `service_role`) can use the store.
 */
export function postgresSchemaSql(schema = 'public'): string {
  const s = ident(schema);
  return `
create schema if not exists ${s};

create table if not exists ${s}.quota_buckets (
  series text not null,
  bucket bigint not null,
  amount bigint not null default 0,
  expires_at bigint not null,
  primary key (series, bucket)
);
create index if not exists quota_buckets_expires_at on ${s}.quota_buckets (expires_at);

create table if not exists ${s}.quota_floors (
  series text primary key,
  used bigint not null,
  until bigint not null,
  at_ms bigint not null,
  drain boolean not null default false,
  added bigint not null default 0
);

create table if not exists ${s}.quota_reservations (
  id text primary key,
  placements jsonb not null,
  expires_at bigint not null
);
create index if not exists quota_reservations_expires_at on ${s}.quota_reservations (expires_at);

create table if not exists ${s}.quota_kv (
  key text primary key,
  value text not null,
  until bigint not null
);

alter table ${s}.quota_buckets enable row level security;
alter table ${s}.quota_floors enable row level security;
alter table ${s}.quota_reservations enable row level security;
alter table ${s}.quota_kv enable row level security;

create or replace function ${s}.quota_op(p jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_now bigint := (p->>'now')::bigint;
  v_op text := p->>'op';
  r record;
  o jsonb;
  pl jsonb;
  i int;
  v_used bigint;
  v_floor_used bigint;
  v_floor_until bigint;
  v_floor_at bigint;
  v_floor_drain boolean;
  v_floor_added bigint;
  v_floor_now numeric;
  v_room bigint;
  v_text text;
  v_f0 float8;
  v_at bigint;
  v_cur float8;
  v_nf float8;
  v_key text;
  v_need bigint;
  v_limit bigint;
  v_wait bigint;
  v_worst bigint := 0;
  v_worst_idx int := 0;
  v_excess bigint;
  v_bucket bigint;
  v_actual bigint;
  v_out jsonb;
  v_row jsonb;
  inf constant bigint := 9223372036854775807;
begin
  -- One store operation at a time; the lock ends with the transaction.
  perform pg_advisory_xact_lock(hashtext('ai-sdk-quota:${s}'));

  -- Release reservations that were never committed or released.
  for r in delete from ${s}.quota_reservations where expires_at <= v_now returning placements loop
    for pl in select value from jsonb_array_elements(r.placements) loop
      update ${s}.quota_buckets set amount = greatest(0, amount - (pl->>'amount')::bigint)
        where series = pl->>'series' and bucket = (pl->>'bucket')::bigint;
    end loop;
  end loop;

  if v_op = 'reserve' then
    delete from ${s}.quota_buckets where expires_at < v_now;
    i := 0;
    for o in select value from jsonb_array_elements(p->'ops') loop
      i := i + 1;
      v_need := (o->>'need')::bigint;
      v_limit := (o->>'limit')::bigint;
      delete from ${s}.quota_buckets where series = o->>'series' and bucket < (o->>'from')::bigint;
      select coalesce(sum(amount), 0) into v_used from ${s}.quota_buckets where series = o->>'series';
      v_floor_used := null; v_floor_until := null; v_floor_at := null; v_floor_drain := null; v_floor_added := null;
      select f.used, f.until, f.at_ms, f.drain, f.added
        into v_floor_used, v_floor_until, v_floor_at, v_floor_drain, v_floor_added
        from ${s}.quota_floors f where f.series = o->>'series' and f.until > v_now;
      -- See floor.ts: the reading (flat, or draining from used at at_ms to 0 at until) plus calls added since.
      v_floor_now := case
        when v_floor_used is null then 0
        when v_floor_drain and v_floor_at < v_floor_until
          then v_floor_used::numeric * (v_floor_until - v_now) / (v_floor_until - v_floor_at) + v_floor_added
        else v_floor_used + v_floor_added end;
      v_wait := 0;
      if v_floor_now > v_used and v_floor_now + v_need > v_limit then
        v_room := v_limit - v_need - coalesce(v_floor_added, 0);
        if v_need > v_limit then
          v_wait := -1;
        elsif v_floor_drain and v_floor_at < v_floor_until and v_room >= 0 then
          v_wait := least(v_floor_until - v_now, greatest(1, ceil(
            v_floor_until - v_room::numeric * (v_floor_until - v_floor_at) / v_floor_used - v_now)))::bigint;
        else
          v_wait := v_floor_until - v_now;
        end if;
      elsif v_need > v_limit then
        v_wait := -1;
      elsif v_used + v_need > v_limit then
        if (o->>'kind')::int = 1 then
          v_wait := (o->>'nextResetMs')::bigint;
        else
          v_excess := v_used + v_need - v_limit;
          select x.bucket into v_bucket from (
            select b.bucket, sum(b.amount) over (order by b.bucket) as running
            from ${s}.quota_buckets b where b.series = o->>'series'
          ) x where x.running >= v_excess order by x.bucket limit 1;
          v_wait := v_bucket + (o->>'bucketMs')::bigint + (o->>'windowMs')::bigint - v_now;
        end if;
      end if;
      if v_wait <> 0 and (v_worst_idx = 0
          or (case when v_wait = -1 then inf else v_wait end) > (case when v_worst = -1 then inf else v_worst end)) then
        v_worst := v_wait;
        v_worst_idx := i;
      end if;
    end loop;
    if v_worst_idx > 0 then
      return jsonb_build_object('ok', false, 'wait', v_worst, 'index', v_worst_idx);
    end if;
    if jsonb_array_length(p->'ops') > 0 then
      for o in select value from jsonb_array_elements(p->'ops') loop
        insert into ${s}.quota_buckets (series, bucket, amount, expires_at)
          values (o->>'series', (o->>'bucket')::bigint, (o->>'need')::bigint, v_now + (o->>'keepMs')::bigint)
          on conflict (series, bucket) do update
            set amount = ${s}.quota_buckets.amount + excluded.amount,
                expires_at = greatest(${s}.quota_buckets.expires_at, excluded.expires_at);
        update ${s}.quota_floors set added = added + (o->>'need')::bigint
          where series = o->>'series' and until > v_now;
      end loop;
      insert into ${s}.quota_reservations (id, placements, expires_at)
        select p->>'id',
               jsonb_agg(jsonb_build_object('series', value->>'series', 'bucket', value->'bucket', 'amount', value->'need')),
               v_now + (p->>'ttlMs')::bigint
        from jsonb_array_elements(p->'ops');
    end if;
    return jsonb_build_object('ok', true);

  elsif v_op = 'commit' then
    v_actual := (p->>'actual')::bigint;
    delete from ${s}.quota_reservations where id = p->>'id' returning placements into pl;
    if pl is not null then
      if v_actual is not null then
        for o in select value from jsonb_array_elements(p->'placements') loop
          if (o->>'isToken')::boolean then
            update ${s}.quota_buckets set amount = greatest(0, amount + v_actual - (o->>'amount')::bigint)
              where series = o->>'series' and bucket = (o->>'bucket')::bigint;
          end if;
        end loop;
      end if;
    else
      -- Expired before commit: the call still happened, so record it now.
      for o in select value from jsonb_array_elements(p->'placements') loop
        insert into ${s}.quota_buckets (series, bucket, amount, expires_at)
          values (o->>'series', (o->>'nowBucket')::bigint,
                  case when (o->>'isToken')::boolean and v_actual is not null then v_actual else (o->>'amount')::bigint end,
                  v_now + (o->>'keepMs')::bigint)
          on conflict (series, bucket) do update
            set amount = ${s}.quota_buckets.amount + excluded.amount,
                expires_at = greatest(${s}.quota_buckets.expires_at, excluded.expires_at);
      end loop;
    end if;
    return 'true'::jsonb;

  elsif v_op = 'release' then
    delete from ${s}.quota_reservations where id = p->>'id' returning placements into pl;
    if pl is not null then
      for o in select value from jsonb_array_elements(pl) loop
        update ${s}.quota_buckets set amount = greatest(0, amount - (o->>'amount')::bigint)
          where series = o->>'series' and bucket = (o->>'bucket')::bigint;
      end loop;
    end if;
    return 'true'::jsonb;

  elsif v_op = 'truth' then
    for o in select value from jsonb_array_elements(p->'entries') loop
      insert into ${s}.quota_floors (series, used, until, at_ms, drain, added)
        values (o->>'series', (o->>'used')::bigint, (o->>'until')::bigint, v_now, (o->>'drain')::boolean, 0)
        on conflict (series) do update
          set used = excluded.used, until = excluded.until, at_ms = excluded.at_ms, drain = excluded.drain, added = 0
          where ${s}.quota_floors.until <= v_now
             or (${s}.quota_floors.drain and not excluded.drain)
             or excluded.used >= ${s}.quota_floors.added + case
                  when ${s}.quota_floors.drain and ${s}.quota_floors.at_ms < ${s}.quota_floors.until
                    then ${s}.quota_floors.used::numeric * (${s}.quota_floors.until - v_now)
                         / (${s}.quota_floors.until - ${s}.quota_floors.at_ms)
                  else ${s}.quota_floors.used end;
    end loop;
    return 'true'::jsonb;

  elsif v_op = 'usage' then
    v_out := '[]'::jsonb;
    for o in select value from jsonb_array_elements(p->'entries') loop
      v_floor_used := null; v_floor_until := null; v_floor_at := null; v_floor_drain := null; v_floor_added := null;
      select f.used, f.until, f.at_ms, f.drain, f.added
        into v_floor_used, v_floor_until, v_floor_at, v_floor_drain, v_floor_added
        from ${s}.quota_floors f where f.series = o->>'series' and f.until > v_now;
      select coalesce(jsonb_agg(jsonb_build_array(b.bucket, b.amount) order by b.bucket), '[]'::jsonb) into v_row
        from ${s}.quota_buckets b where b.series = o->>'series' and b.bucket >= (o->>'from')::bigint;
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'floorUsed', coalesce(v_floor_used, 0), 'floorUntil', coalesce(v_floor_until, 0),
        'floorAt', coalesce(v_floor_at, 0), 'floorDrain', coalesce(v_floor_drain, false),
        'floorAdded', coalesce(v_floor_added, 0), 'buckets', v_row));
    end loop;
    return v_out;

  elsif v_op = 'cd-set' then
    insert into ${s}.quota_kv (key, value, until) values ('c:' || (p->>'key'), p->>'until', (p->>'until')::bigint)
      on conflict (key) do update set value = excluded.value, until = excluded.until
        where ${s}.quota_kv.until < excluded.until;
    return 'true'::jsonb;

  elsif v_op = 'st-set' then
    insert into ${s}.quota_kv (key, value, until) values ('k:' || (p->>'key'), p->>'value', (p->>'until')::bigint)
      on conflict (key) do update set value = excluded.value, until = excluded.until;
    return 'true'::jsonb;

  elsif v_op = 'kv-get' then
    select jsonb_build_object('value', k.value, 'until', k.until) into v_out from ${s}.quota_kv k where k.key = p->>'key';
    return coalesce(v_out, 'null'::jsonb);
  end if;

  -- Adaptive limits (see adaptive.ts): value is 'factor|at'.
  if v_op = 'ad-set' then
    v_key := 'a:' || (p->>'key');
    select k.value into v_text from ${s}.quota_kv k where k.key = v_key;
    v_cur := 1;
    if v_text is not null then
      v_f0 := split_part(v_text, '|', 1)::float8;
      v_at := split_part(v_text, '|', 2)::bigint;
      v_cur := least(1, v_f0 + greatest(0, v_now - v_at)::float8 / (p->>'recoverMs')::float8 * (1 - v_f0));
      if v_now - v_at < (p->>'debounceMs')::bigint then
        return jsonb_build_object('factor', v_cur, 'changed', false);
      end if;
    end if;
    v_nf := greatest((p->>'min')::float8, v_cur * (p->>'step')::float8);
    insert into ${s}.quota_kv (key, value, until)
      values (v_key, v_nf::text || '|' || v_now::text, v_now + (p->>'recoverMs')::bigint + 60000)
      on conflict (key) do update set value = excluded.value, until = excluded.until;
    return jsonb_build_object('factor', v_nf, 'changed', true);

  elsif v_op = 'ad-get' then
    v_out := '[]'::jsonb;
    for v_key in select jsonb_array_elements_text(p->'keys') loop
      v_text := null;
      select k.value into v_text from ${s}.quota_kv k where k.key = 'a:' || v_key;
      v_out := v_out || jsonb_build_array(case when v_text is null then 'null'::jsonb else jsonb_build_object(
        'factor', split_part(v_text, '|', 1)::float8, 'at', split_part(v_text, '|', 2)::bigint) end);
    end loop;
    return v_out;
  end if;

  raise exception 'ai-sdk-quota: unknown op %', v_op;
end;
$fn$;

revoke all on function ${s}.quota_op(jsonb) from public;
`;
}

/**
 * A shared store in Postgres (Supabase, Neon, RDS, local). Run `postgresSchemaSql()`
 * once, grant EXECUTE on `quota_op(jsonb)` to the role your server uses, then:
 *
 * ```ts
 * import { Pool } from 'pg';
 * const store = postgresStore(new Pool({ connectionString: process.env.DATABASE_URL }));
 * ```
 */
export function postgresStore(db: PgQueryable, options: PostgresStoreOptions = {}): QuotaStore {
  const schema = ident(options.schema ?? 'public');
  const prefix = options.prefix ?? 'aisq';
  const sql = `select ${schema}.quota_op($1::jsonb) as r`;
  const ns = (s: string) => `${prefix}|${s}`;

  async function op(payload: Record<string, unknown>): Promise<unknown> {
    const { rows } = await db.query(sql, [JSON.stringify(payload)]);
    const r = rows[0]?.['r'];
    return typeof r === 'string' ? JSON.parse(r) : r;
  }

  const backend: StoreBackend = {
    async reserve({ ops, id, now, ttlMs }) {
      const r = (await op({ op: 'reserve', now, ttlMs, id: ns(id), ops: ops.map((o) => ({ ...o, series: ns(o.series) })) })) as {
        ok: boolean;
        wait: number;
        index: number;
      };
      return r.ok ? { ok: true } : { ok: false, wait: Number(r.wait), index: Number(r.index) };
    },
    async commit({ id, actual, placements, now }) {
      await op({ op: 'commit', now, id: ns(id), actual: actual ?? null, placements: placements.map((p) => ({ ...p, series: ns(p.series) })) });
    },
    async release({ id, now }) {
      await op({ op: 'release', now, id: ns(id) });
    },
    async truth({ entries, now }) {
      await op({ op: 'truth', now, entries: entries.map((e) => ({ ...e, series: ns(e.series) })) });
    },
    async usage({ entries, now }) {
      const rows = (await op({ op: 'usage', now, entries: entries.map((e) => ({ ...e, series: ns(e.series) })) })) as {
        floorUsed: number;
        floorUntil: number;
        floorAt: number;
        floorDrain: boolean;
        floorAdded: number;
        buckets: [number, number][];
      }[];
      return rows.map(
        (r): SeriesUsage => ({
          floorUsed: Number(r.floorUsed),
          floorUntil: Number(r.floorUntil),
          floorAt: Number(r.floorAt),
          floorDrain: r.floorDrain === true,
          floorAdded: Number(r.floorAdded),
          buckets: r.buckets.map(([b, a]) => [Number(b), Number(a)]),
        }),
      );
    },
    async setCooldown(memberId, until) {
      await op({ op: 'cd-set', now: 0, key: ns(memberId), until });
    },
    async getCooldown(memberId) {
      const r = (await op({ op: 'kv-get', now: 0, key: `c:${ns(memberId)}` })) as { until: number } | null;
      return r ? Number(r.until) : undefined;
    },
    async setSticky(key, memberId, until) {
      await op({ op: 'st-set', now: 0, key: ns(key), value: memberId, until });
    },
    async adapt(key, now, o) {
      const r = (await op({ op: 'ad-set', now, key: ns(key), ...o })) as { factor: number; changed: boolean };
      return { factor: Number(r.factor), changed: r.changed === true };
    },
    async getAdapted(keys) {
      const rows = (await op({ op: 'ad-get', now: 0, keys: keys.map(ns) })) as ({ factor: number; at: number } | null)[];
      return rows.map((r) => (r ? { factor: Number(r.factor), at: Number(r.at) } : undefined));
    },
    async getSticky(key) {
      const r = (await op({ op: 'kv-get', now: 0, key: `k:${ns(key)}` })) as { value: string; until: number } | null;
      return r ? { memberId: r.value, until: Number(r.until) } : undefined;
    },
  };
  return createScriptedStore(backend);
}
