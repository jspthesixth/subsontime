import {
  subtitleKey,
  type FixRow,
  type MismatchRow,
  type NewReport,
  type ReportRow,
} from "./db.ts";
import {
  setSimilarity,
  sketchesSimilarity,
  subtitleSketch,
  type CueHash,
  type FixCue,
} from "./fingerprint.ts";

export type ReportReason = NewReport["reason"];

export type FixView = {
  id: string;
  subtitleSketch: CueHash[];
  status: "confirmed" | "hint";
  method: string;
  agreeing: number;
  fromAudio: boolean;
  cueCount: number;
};

export type FixWithCues = FixView & { cues: FixCue[] };

export type HiddenView = {
  subtitleSketch: CueHash[];
  reason: "mismatch" | ReportReason;
  count: number;
};

export type VideoTimings<View = FixView> = { fixes: View[]; hidden: HiddenView[] };

type Row = FixRow | MismatchRow | ReportRow;
type Timed = { fix: FixRow; once: Map<CueHash, FixCue>; repeated: CueHash[] };
type Ranked = { view: FixWithCues; newest: number };
type Hidden = { view: HiddenView; newest: number };
type Section = {
  fixView?: Ranked;
  mismatch?: Hidden;
  mismatchers: Set<string>;
  hidden: Hidden[];
};

export type Digest = Section[];

const sameSubtitleShare = 0.9;
const sketchFloor = 0.75;
const maximumGroups = 64;
const groupStartsPerSlot = 8;
const privateSketchSize = 128;
const exactChecks = 3;
const toleranceMs = 100;
const agreeingPercent = 80;
const minimumSharedCues = 20;
const reportOrigins = 3;
const weighedFixes = 50;
const maximumViews = 20;
const maximumHidden = 50;

const byAge = (a: Row, b: Row) => a.createdAt.getTime() - b.createdAt.getTime();

const byViewRank = (a: Ranked, b: Ranked) =>
  b.view.agreeing - a.view.agreeing || b.newest - a.newest;

const newestOf = <Item extends Row>(rows: Item[]) =>
  rows.reduce((newest, row) => (row.createdAt >= newest.createdAt ? row : newest));

const oldestOf = <Item extends Row>(rows: Item[]) =>
  rows.reduce((oldest, row) => (row.createdAt < oldest.createdAt ? row : oldest));

const submittersOf = (rows: Row[]) => new Set(rows.map((row) => row.submitter));

const originsOf = (rows: Row[]) => new Set(rows.flatMap((row) => row.origin ?? []));

const slotOf = (row: Row) => row.origin ?? `submitter:${row.submitter}`;

const slotsOf = (rows: Row[]) => new Set(rows.map(slotOf)).size;

const independent = (a: Row, b: Row) =>
  a.submitter !== b.submitter &&
  a.origin !== undefined &&
  b.origin !== undefined &&
  a.origin !== b.origin;

const hasIndependentPair = (rows: Row[]) => rows.some((a) => rows.some((b) => independent(a, b)));

type Leader = { row: Row; hashes: Set<CueHash>; sketch: Float64Array };

const scramble = (value: number, key: number) => {
  const mixed = Math.imul(value ^ key, 0x85ebca6b);
  const again = Math.imul(mixed ^ (mixed >>> 13), 0xc2b2ae35);

  return (again ^ (again >>> 16)) >>> 0;
};

const keyedOrders = (groupingKey: Buffer) => {
  const [first = 0, second = 0, third = 0, fourth = 0] = [0, 4, 8, 12].map((at) =>
    groupingKey.readUInt32BE(at),
  );

  return (hash: CueHash) => {
    const high = Number.parseInt(hash.slice(0, 8), 16);
    const low = Number.parseInt(hash.slice(8, 16), 16);

    return (
      scramble(high ^ scramble(low, second), first) * 2 ** 21 +
      (scramble(low ^ scramble(high, fourth), third) >>> 11)
    );
  };
};

const privateSketch = (hashes: Set<CueHash>, keyedOrder: (hash: CueHash) => number) =>
  Float64Array.from(hashes, keyedOrder).toSorted().subarray(0, privateSketchSize);

const representatives = (rows: Row[], groupingKey: Buffer): Map<Row, Row> => {
  const leaders: Leader[] = [];
  const byList = new Map<string, Row>();
  const starts = new Map<string, number>();
  const keyedOrder = keyedOrders(groupingKey);

  const leaderFor = (row: Row) => {
    const list = row.subtitleHashes.join();
    const known = byList.get(list);

    if (known !== undefined) {
      return known;
    }

    const hashes = new Set(row.subtitleHashes);
    const sketch = privateSketch(hashes, keyedOrder);
    const joined = leaders
      .map((leader) => ({ leader, estimate: sketchesSimilarity(sketch, leader.sketch) }))
      .filter(({ estimate }) => estimate >= sketchFloor)
      .toSorted((a, b) => b.estimate - a.estimate)
      .slice(0, exactChecks)
      .find(({ leader }) => setSimilarity(leader.hashes, hashes) >= sameSubtitleShare)?.leader.row;
    const slot = slotOf(row);
    const started = starts.get(slot) ?? 0;
    const canStart = leaders.length < maximumGroups && started < groupStartsPerSlot;

    if (joined === undefined && canStart) {
      leaders.push({ row, hashes, sketch });
      starts.set(slot, started + 1);
    }

    const leader = joined ?? (canStart ? row : undefined);

    if (leader !== undefined) {
      byList.set(list, leader);
    }

    return leader;
  };

  return new Map(
    rows.flatMap((row) => {
      const leader = leaderFor(row);

      return leader === undefined ? [] : [[row, leader] as const];
    }),
  );
};

const timedOf = (fix: FixRow): Timed => {
  const copies = [...Map.groupBy(fix.cues, (cue) => cue.h)];

  return {
    fix,
    once: new Map(
      copies.flatMap(([hash, [cue, ...more]]) =>
        cue === undefined || more.length > 0 ? [] : [[hash, cue] as const],
      ),
    ),
    repeated: copies.flatMap(([hash, all]) => (all.length > 1 ? [hash] : [])),
  };
};

const close = (a: FixCue, b: FixCue) =>
  Math.abs(a.s - b.s) <= toleranceMs && Math.abs(a.e - b.e) <= toleranceMs;

const agree = (left: Timed, right: Timed) => {
  const [fewer, more] =
    left.once.size <= right.once.size ? [left.once, right.once] : [right.once, left.once];
  const allowedApart = fewer.size * (100 - agreeingPercent);
  let shared = 0;
  let apart = 0;

  for (const [hash, cue] of fewer) {
    const other = more.get(hash);

    if (other !== undefined) {
      shared += 1;
      apart += close(cue, other) ? 0 : 1;
    }

    if (apart * 100 > allowedApart) {
      return false;
    }
  }

  return shared >= minimumSharedCues && (shared - apart) * 100 >= shared * agreeingPercent;
};

const agreeingComponents = (timed: Timed[]): Timed[][] => {
  const labels = timed.map((_, index) => index);

  timed.forEach((later, laterIndex) =>
    timed.slice(0, laterIndex).forEach((earlier, earlierIndex) => {
      const from = labels[laterIndex];
      const to = labels[earlierIndex] ?? earlierIndex;

      if (from !== to && independent(later.fix, earlier.fix) && agree(later, earlier)) {
        labels.forEach((label, index) => {
          labels[index] = label === from ? to : label;
        });
      }
    }),
  );

  return [...Map.groupBy(timed, (_, index) => labels[index]).values()];
};

const strength = (component: Timed[]) => {
  const fixes = component.map(({ fix }) => fix);

  return [originsOf(fixes).size, submittersOf(fixes).size] as const;
};

const largest = (components: Timed[][]) =>
  components.reduce((best, component) => {
    const [origins, submitters] = strength(component);
    const [bestOrigins, bestSubmitters] = strength(best);

    return origins > bestOrigins || (origins === bestOrigins && submitters > bestSubmitters)
      ? component
      : best;
  });

const hasKey = (fix: FixRow) => (fix.referenceKey ?? "") !== "";

const confirms = (a: FixRow, b: FixRow) =>
  independent(a, b) &&
  (a.method === "audio" ||
    b.method === "audio" ||
    (hasKey(a) && hasKey(b) && a.referenceKey !== b.referenceKey));

const isConfirmed = (fixes: FixRow[]) => fixes.some((a) => fixes.some((b) => confirms(a, b)));

const median = (values: number[]) => {
  const sorted = Int32Array.from(values).toSorted();

  return Math.round(
    ((sorted[(sorted.length - 1) >> 1] ?? 0) + (sorted[sorted.length >> 1] ?? 0)) / 2,
  );
};

type Name = Pick<FixView, "id" | "subtitleSketch">;

const viewOf = (name: Name, cues: FixCue[]) => ({ ...name, cues, cueCount: cues.length });

const confirmedView = (name: Name, component: Timed[]): Ranked => {
  const fixes = component.map(({ fix }) => fix);
  const repeated = new Set(component.flatMap((timed) => timed.repeated));
  const timings = Map.groupBy(
    component.flatMap(({ once }) => [...once.values()]).filter((cue) => !repeated.has(cue.h)),
    (cue) => cue.h,
  );
  const fromAudio = fixes.some((fix) => fix.method === "audio");
  const [mostCommon] = [...Map.groupBy(fixes, (fix) => fix.method)].reduce((best, entry) =>
    entry[1].length > best[1].length ? entry : best,
  );
  const cues = [...timings]
    .map(([h, copies]) => ({
      h,
      s: median(copies.map((cue) => cue.s)),
      e: median(copies.map((cue) => cue.e)),
    }))
    .toSorted((a, b) => a.s - b.s || a.e - b.e);

  return {
    view: {
      ...viewOf(name, cues),
      status: "confirmed",
      method: fromAudio ? "audio" : mostCommon,
      agreeing: slotsOf(fixes),
      fromAudio,
    },
    newest: newestOf(fixes).createdAt.getTime(),
  };
};

const rankedView = (leader: FixRow, group: FixRow[]): Ranked => {
  const weighed = [...Map.groupBy(group, slotOf).values()]
    .map(newestOf)
    .toSorted(byAge)
    .slice(-weighedFixes);
  const components = agreeingComponents(weighed.map(timedOf));
  const confirming = components.filter((component) => isConfirmed(component.map(({ fix }) => fix)));
  const component = largest(confirming.length > 0 ? confirming : components);
  const name = {
    id: subtitleKey(oldestOf(group).subtitleHashes),
    subtitleSketch: subtitleSketch(leader.subtitleHashes),
  };

  if (isConfirmed(component.map(({ fix }) => fix))) {
    return confirmedView(name, component);
  }

  const newest = newestOf(weighed);

  return {
    view: {
      ...viewOf(name, newest.cues),
      status: "hint",
      method: newest.method,
      agreeing: 1,
      fromAudio: newest.method === "audio",
    },
    newest: newest.createdAt.getTime(),
  };
};

const hiddenOf = (rows: Row[], reason: HiddenView["reason"]): Hidden => {
  const newest = newestOf(rows);

  return {
    view: {
      subtitleSketch: subtitleSketch(newest.subtitleHashes),
      reason,
      count: slotsOf(rows),
    },
    newest: newest.createdAt.getTime(),
  };
};

const sectionOf = (
  leader: Row,
  fixes: FixRow[],
  mismatches: MismatchRow[],
  reports: ReportRow[],
): Section => {
  const mismatch = mismatches.length === 0 ? undefined : hiddenOf(mismatches, "mismatch");
  const reportsHidden = [...Map.groupBy(reports, (row) => row.reason)].flatMap(([reason, rows]) =>
    submittersOf(rows).size >= reportOrigins && originsOf(rows).size >= reportOrigins
      ? [hiddenOf(rows, reason)]
      : [],
  );
  const leadingFix = fixes.find((fix) => fix === leader);

  return {
    fixView: leadingFix === undefined ? undefined : rankedView(leadingFix, fixes),
    mismatch,
    mismatchers: submittersOf(mismatches),
    hidden: [
      ...(mismatch !== undefined && hasIndependentPair(mismatches) ? [mismatch] : []),
      ...reportsHidden,
    ],
  };
};

export const digest = (
  fixes: FixRow[],
  mismatches: MismatchRow[],
  reports: ReportRow[],
  groupingKey: Buffer,
): Digest => {
  const leaderOf = representatives(
    [
      ...fixes.toSorted(byAge).toReversed(),
      ...[...mismatches, ...reports].toSorted(byAge).toReversed(),
    ],
    groupingKey,
  );
  const byLeader = <Item extends Row>(rows: Item[]) =>
    Map.groupBy(rows, (row) => leaderOf.get(row));
  const fixGroups = byLeader(fixes);
  const mismatchGroups = byLeader(mismatches);
  const reportGroups = byLeader(reports);

  const sections = [...new Set(leaderOf.values())].map((leader) =>
    sectionOf(
      leader,
      fixGroups.get(leader) ?? [],
      mismatchGroups.get(leader) ?? [],
      reportGroups.get(leader) ?? [],
    ),
  );
  const listable = sections.flatMap((section) =>
    section.fixView === undefined || section.hidden.length > 0 ? [] : [section.fixView],
  );
  const viewerHideable = sections.filter(
    (section) => section.fixView !== undefined && section.mismatchers.size > 0,
  ).length;
  const kept = new Set(listable.toSorted(byViewRank).slice(0, maximumViews + viewerHideable));

  return sections.map((section) =>
    section.fixView !== undefined && kept.has(section.fixView)
      ? section
      : { ...section, fixView: undefined },
  );
};

const byRank = (a: { newest: number }, b: { newest: number }) => b.newest - a.newest;

export const present = (sections: Digest, viewer?: string): VideoTimings<FixWithCues> => {
  const shown = sections.map((section) => {
    const own =
      viewer !== undefined &&
      section.mismatch !== undefined &&
      section.mismatchers.has(viewer) &&
      !section.hidden.includes(section.mismatch)
        ? [section.mismatch]
        : [];

    return { section, own, hidden: [...own, ...section.hidden] };
  });
  const own = shown.flatMap((entry) => entry.own);
  const hidden = shown
    .flatMap((entry) => entry.section.hidden)
    .toSorted((a, b) => b.view.count - a.view.count || byRank(a, b));

  return {
    fixes: shown
      .flatMap((entry) =>
        entry.hidden.length === 0 && entry.section.fixView !== undefined
          ? [entry.section.fixView]
          : [],
      )
      .toSorted(byViewRank)
      .slice(0, maximumViews)
      .map(({ view }) => view),
    hidden: [...own, ...hidden].slice(0, maximumHidden).map(({ view }) => view),
  };
};

export const publicTimings = (timings: VideoTimings<FixWithCues>): VideoTimings => ({
  fixes: timings.fixes.map((view) => ({
    id: view.id,
    subtitleSketch: view.subtitleSketch,
    status: view.status,
    method: view.method,
    agreeing: view.agreeing,
    fromAudio: view.fromAudio,
    cueCount: view.cueCount,
  })),
  hidden: timings.hidden,
});

export const summarize = (
  fixes: FixRow[],
  mismatches: MismatchRow[],
  reports: ReportRow[],
  { groupingKey, viewer }: { groupingKey: Buffer; viewer?: string },
): VideoTimings<FixWithCues> => present(digest(fixes, mismatches, reports, groupingKey), viewer);
