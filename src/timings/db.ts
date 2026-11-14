import { createHash } from "node:crypto";
import postgres from "postgres";
import type { CueHash, FixCue } from "./fingerprint.ts";

export type VideoKey = { hash: string; size: number };

export type NewFix = {
  video: VideoKey;
  subtitleHashes: CueHash[];
  cues: FixCue[];
  method: "audio" | "reference" | "release-name";
  referenceKey?: string;
  submitter: string;
  origin?: string;
};

export type NewMismatch = {
  video: VideoKey;
  subtitleHashes: CueHash[];
  submitter: string;
  origin?: string;
};

export type NewReport = {
  video: VideoKey;
  subtitleHashes: CueHash[];
  reason:
    | "machine-translated"
    | "wrong-language"
    | "lines-missing"
    | "timing-off"
    | "broken-characters";
  submitter: string;
  origin?: string;
};

export type FixRow = NewFix & { createdAt: Date };
export type MismatchRow = NewMismatch & { createdAt: Date };
export type ReportRow = NewReport & { createdAt: Date };

export type StoreStats = { fixes: number; confirmed: number; videos: number; hidden: number };

export type TimingsStore = {
  fixesFor(video: VideoKey, limit?: number): Promise<FixRow[]>;
  mismatchesFor(video: VideoKey, limit?: number): Promise<MismatchRow[]>;
  reportsFor(video: VideoKey, limit?: number): Promise<ReportRow[]>;
  putFix(row: NewFix): Promise<void>;
  putMismatch(row: NewMismatch): Promise<void>;
  putReport(row: NewReport): Promise<void>;
  stats(): Promise<StoreStats>;
};

const readLimit = 500;

export const subtitleKey = (hashes: CueHash[]) =>
  createHash("md5").update(hashes.join(",")).digest("hex");

const rowsPerSlot = 8;

type Keyed = { video: VideoKey; submitter: string; subtitleHashes: CueHash[]; origin?: string };

const sameVideo = (a: VideoKey, b: VideoKey) => a.hash === b.hash && a.size === b.size;

const sameSlot = (a: Keyed, b: Keyed) =>
  sameVideo(a.video, b.video) &&
  a.submitter === b.submitter &&
  a.subtitleHashes.join(",") === b.subtitleHashes.join(",");

const memoryTable = <Row extends Keyed>() => {
  let rows: (Row & { createdAt: Date })[] = [];

  return {
    all: () => rows,
    for: (video: VideoKey, limit = readLimit) => {
      const videoRows = rows.filter((row) => sameVideo(row.video, video));
      const kept = new Set(
        [...Map.groupBy(videoRows, (row) => row.origin ?? row.submitter).values()].flatMap(
          (slotRows) => slotRows.slice(-rowsPerSlot),
        ),
      );

      return videoRows.filter((row) => kept.has(row)).slice(-limit);
    },
    put: (row: Row) => {
      rows = [
        ...rows.filter((existing) => !sameSlot(existing, row)),
        { ...row, createdAt: new Date() },
      ];
    },
  };
};

const videoId = ({ video }: Keyed) => `${video.hash}:${video.size}`;

const videosFromTwoOrigins = (rows: Keyed[]) =>
  [...Map.groupBy(rows, videoId).values()].filter(
    (videoRows) => new Set(videoRows.flatMap((row) => row.origin ?? [])).size >= 2,
  ).length;

export const memoryStore = (): TimingsStore => {
  const fixes = memoryTable<NewFix>();
  const mismatches = memoryTable<NewMismatch>();
  const reports = memoryTable<NewReport>();

  return {
    fixesFor: async (video, limit) => fixes.for(video, limit),
    mismatchesFor: async (video, limit) => mismatches.for(video, limit),
    reportsFor: async (video, limit) => reports.for(video, limit),
    putFix: async (row) => fixes.put(row),
    putMismatch: async (row) => mismatches.put(row),
    putReport: async (row) => reports.put(row),
    stats: async () => ({
      fixes: fixes.all().length,
      confirmed: videosFromTwoOrigins(fixes.all()),
      videos: new Set([...fixes.all(), ...mismatches.all(), ...reports.all()].map(videoId)).size,
      hidden: videosFromTwoOrigins(mismatches.all()),
    }),
  };
};

type VideoColumns = { video_hash: string; video_size: string | number; origin: string | null };

const videoOf = (row: VideoColumns): VideoKey => ({
  hash: row.video_hash,
  size: Number(row.video_size),
});

const originOf = (row: VideoColumns) => (row.origin === null ? {} : { origin: row.origin });

type FixColumns = VideoColumns & {
  subtitle_hashes: string[];
  cues: FixCue[];
  method: NewFix["method"];
  reference_key: string | null;
  submitter: string;
  created_at: Date;
};

type MismatchColumns = VideoColumns & {
  subtitle_hashes: string[];
  submitter: string;
  created_at: Date;
};

type ReportColumns = MismatchColumns & { reason: NewReport["reason"] };

export const postgresStore = (url: string): TimingsStore => {
  const sql = postgres(url, { max: 1, prepare: false, idle_timeout: 20, connect_timeout: 5 });

  return {
    fixesFor: async (video, limit = readLimit) => {
      const rows = await sql<FixColumns[]>`
        select video_hash, video_size, subtitle_hashes, cues, method, reference_key, submitter, origin, created_at
        from (
          select *, row_number() over (
            partition by coalesce(origin, submitter) order by created_at desc, id desc
          ) as slot_rank
          from fixes
          where video_hash = ${video.hash} and video_size = ${video.size}
        ) ranked
        where slot_rank <= ${rowsPerSlot}
        order by created_at desc, id desc
        limit ${limit}`;

      return rows.toReversed().map((row) => ({
        video: videoOf(row),
        subtitleHashes: row.subtitle_hashes,
        cues: row.cues,
        method: row.method,
        ...(row.reference_key === null ? {} : { referenceKey: row.reference_key }),
        submitter: row.submitter,
        ...originOf(row),
        createdAt: row.created_at,
      }));
    },
    mismatchesFor: async (video, limit = readLimit) => {
      const rows = await sql<MismatchColumns[]>`
        select video_hash, video_size, subtitle_hashes, submitter, origin, created_at
        from (
          select *, row_number() over (
            partition by coalesce(origin, submitter) order by created_at desc, id desc
          ) as slot_rank
          from mismatches
          where video_hash = ${video.hash} and video_size = ${video.size}
        ) ranked
        where slot_rank <= ${rowsPerSlot}
        order by created_at desc, id desc
        limit ${limit}`;

      return rows.toReversed().map((row) => ({
        video: videoOf(row),
        subtitleHashes: row.subtitle_hashes,
        submitter: row.submitter,
        ...originOf(row),
        createdAt: row.created_at,
      }));
    },
    reportsFor: async (video, limit = readLimit) => {
      const rows = await sql<ReportColumns[]>`
        select video_hash, video_size, subtitle_hashes, reason, submitter, origin, created_at
        from (
          select *, row_number() over (
            partition by coalesce(origin, submitter) order by created_at desc, id desc
          ) as slot_rank
          from reports
          where video_hash = ${video.hash} and video_size = ${video.size}
        ) ranked
        where slot_rank <= ${rowsPerSlot}
        order by created_at desc, id desc
        limit ${limit}`;

      return rows.toReversed().map((row) => ({
        video: videoOf(row),
        subtitleHashes: row.subtitle_hashes,
        reason: row.reason,
        submitter: row.submitter,
        ...originOf(row),
        createdAt: row.created_at,
      }));
    },
    putFix: async (row) => {
      await sql`
        insert into fixes (video_hash, video_size, subtitle_hashes, cues, method, reference_key, submitter, origin)
        values (${row.video.hash}, ${row.video.size}, ${row.subtitleHashes}, ${sql.json(row.cues)}, ${row.method}, ${row.referenceKey ?? null}, ${row.submitter}, ${row.origin ?? null})
        on conflict (video_hash, video_size, submitter, subtitle_key) do update
        set cues = excluded.cues, method = excluded.method, reference_key = excluded.reference_key, origin = excluded.origin, created_at = now()`;
    },
    putMismatch: async (row) => {
      await sql`
        insert into mismatches (video_hash, video_size, subtitle_hashes, submitter, origin)
        values (${row.video.hash}, ${row.video.size}, ${row.subtitleHashes}, ${row.submitter}, ${row.origin ?? null})
        on conflict (video_hash, video_size, submitter, subtitle_key) do update
        set origin = excluded.origin, created_at = now()`;
    },
    putReport: async (row) => {
      await sql`
        insert into reports (video_hash, video_size, subtitle_hashes, reason, submitter, origin)
        values (${row.video.hash}, ${row.video.size}, ${row.subtitleHashes}, ${row.reason}, ${row.submitter}, ${row.origin ?? null})
        on conflict (video_hash, video_size, submitter, subtitle_key) do update
        set reason = excluded.reason, origin = excluded.origin, created_at = now()`;
    },
    stats: async () => {
      const [row] = await sql<StoreStats[]>`
        select
          (select count(*)::int from fixes) as fixes,
          (select count(*)::int from (
            select 1 from fixes where origin is not null
            group by video_hash, video_size having count(distinct origin) >= 2
          ) confirmed) as confirmed,
          (select count(*)::int from (
            select video_hash, video_size from fixes
            union select video_hash, video_size from mismatches
            union select video_hash, video_size from reports
          ) videos) as videos,
          (select count(*)::int from (
            select 1 from mismatches where origin is not null
            group by video_hash, video_size having count(distinct origin) >= 2
          ) hidden) as hidden`;

      return row ?? { fixes: 0, confirmed: 0, videos: 0, hidden: 0 };
    },
  };
};
