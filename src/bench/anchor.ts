import type { Cue } from "../subtitles/cue.ts";
import { parseRelease } from "../subtitles/release.ts";
import { rankingOf, releaseScoreOf, type ScoreContext } from "../subtitles/score.ts";
import { anchorWithGuardsOf, firstAgreeing, rigidlyAligned, sameTiming } from "../timing/anchor.ts";
import { retimedMinimumScore } from "../timing/retime.ts";
import type { BenchFile, FileResult, Listed, Run } from "./stremio-bench.ts";
import { truthOf, type Truth } from "./truth.ts";

export type Member = Listed & { cues: Cue[] };

export type Counter = { checks: number };

type Video = ScoreContext["video"];

const checked = <T>(work: T, counter: Counter) => {
  counter.checks += 1;

  return work;
};

export const clustersOf = async (members: Member[], counter: Counter) =>
  members.reduce<Promise<Member[][]>>(async (done, member) => {
    const clusters = await done;
    const home = await clusters.reduce<Promise<Member[] | undefined>>(
      async (found, cluster) =>
        (await found) ??
        ((await checked(sameTiming(cluster[0]?.cues ?? [], member.cues), counter))
          ? cluster
          : undefined),
      Promise.resolve(undefined),
    );

    if (home === undefined) {
      return [...clusters, [member]];
    }

    home.push(member);

    return clusters;
  }, Promise.resolve([]));

const withRelease = (member: Member) => ({
  ...member,
  release: parseRelease(member.releaseName ?? ""),
});

const releaseScore = (member: Member, video: Video) =>
  releaseScoreOf(withRelease(member), { video });

const largest = (clusters: Member[][]) =>
  clusters.reduce<Member[] | undefined>(
    (best, cluster) => (best === undefined || cluster.length > best.length ? cluster : best),
    undefined,
  );

const withHash = (clusters: Member[][]) =>
  clusters.find((cluster) => cluster.some(({ hashMatch }) => hashMatch));

const byRelease = (clusters: Member[][], video: Video) => {
  const scored = clusters.map((cluster) => ({
    cluster,
    score: Math.max(...cluster.map((member) => releaseScore(member, video))),
  }));
  const best = Math.max(0, ...scored.map(({ score }) => score));

  return best === 0
    ? undefined
    : largest(scored.filter(({ score }) => score === best).map(({ cluster }) => cluster));
};

const atLeastTwo = (cluster: Member[] | undefined) =>
  cluster !== undefined && cluster.length >= 2 ? cluster : undefined;

export type Strategy = {
  name: string;
  anchor: (
    clusters: Member[][],
    video: Video,
    members: Member[],
  ) => Member[] | undefined | Promise<Member[] | undefined>;
  sameLanguageMember?: boolean;
};

export const strategies: Strategy[] = [
  { name: "A largest", anchor: largest },
  { name: "B hash, else A", anchor: (clusters) => withHash(clusters) ?? largest(clusters) },
  {
    name: "C release, else A",
    anchor: (clusters, video) => byRelease(clusters, video) ?? largest(clusters),
  },
  {
    name: "D1 B, then C, then A",
    anchor: (clusters, video) =>
      withHash(clusters) ?? byRelease(clusters, video) ?? largest(clusters),
  },
  { name: "D2 A, size >= 2", anchor: (clusters) => atLeastTwo(largest(clusters)) },
  {
    name: "D3 D1, size >= 2",
    anchor: (clusters, video) =>
      withHash(clusters) ?? atLeastTwo(byRelease(clusters, video)) ?? atLeastTwo(largest(clusters)),
  },
  {
    name: "D4 D3, same-language member first",
    anchor: (clusters, video) =>
      withHash(clusters) ?? atLeastTwo(byRelease(clusters, video)) ?? atLeastTwo(largest(clusters)),
    sameLanguageMember: true,
  },
  {
    name: "E hash or release candidate with an agreeing guard, no clustering",
    anchor: async (_clusters, video, members) => {
      const candidates = members.map(withRelease);
      const [anchor, ...guards] = anchorWithGuardsOf(candidates.toSorted(rankingOf({ video })), {
        video,
      });

      if (anchor === undefined) {
        return undefined;
      }

      const { partner } = await firstAgreeing(
        anchor.cues,
        guards.map(({ cues }) => Promise.resolve(cues)),
      );

      const agreeing = partner === undefined ? undefined : guards[partner];

      return agreeing === undefined
        ? undefined
        : [anchor, agreeing].flatMap((each) => members[candidates.indexOf(each)] ?? []);
    },
  },
];

export const retimedTo = (anchor: Cue[], subtitle: Cue[], counter: Counter) => {
  const aligned = checked(rigidlyAligned(anchor, subtitle), counter);

  return aligned.score >= retimedMinimumScore ? aligned.cues : subtitle;
};

const keyOf = ({ sourceName, ref }: Pick<Listed, "sourceName" | "ref">) => `${sourceName}\n${ref}`;

export type Simulated = {
  strategy: string;
  lang: string;
  production: Run["outcome"];
  outcome: Run["outcome"];
  anchored: boolean;
  anchorCorrect?: boolean;
  retimes: number;
};

export const simulateFile = async ({
  result,
  file,
  members,
  clusters,
  candidateTruths,
}: {
  result: FileResult;
  file: BenchFile;
  members: Member[];
  clusters: Member[][];
  candidateTruths: Map<string, Truth>;
}): Promise<Simulated[]> => {
  const judged = new Map<string, Promise<Truth>>();
  const judge = (cues: Cue[], lang: string) => {
    const key = `${lang}\n${cues.map(({ start, end, text }) => `${start} ${end} ${text}`).join("\n")}`;
    const truth = judged.get(key) ?? truthOf(cues, lang, file.verified);

    judged.set(key, truth);

    return truth;
  };
  const byKey = new Map(members.map((member) => [keyOf(member), member]));

  const simulateRun = async (strategy: Strategy, run: Run): Promise<Simulated> => {
    const anchor = await strategy.anchor(
      clusters,
      { type: file.kind === "film" ? "movie" : "series", filename: result.filename },
      members,
    );
    const served =
      run.servedRef === undefined
        ? undefined
        : byKey.get(keyOf({ sourceName: run.servedRef.n, ref: run.servedRef.r }));
    const base = { strategy: strategy.name, lang: run.lang, production: run.outcome };
    const leader = anchor?.[0];

    if (anchor === undefined || leader === undefined || served === undefined) {
      return { ...base, outcome: run.outcome, anchored: false, retimes: 0 };
    }

    const anchorCorrect = candidateTruths.get(keyOf(leader))?.outcome === "correct";
    const inAnchor = new Set(anchor.map(keyOf));
    const sameLanguage = strategy.sameLanguageMember
      ? run.candidates
          .map((each) => byKey.get(keyOf(each)))
          .find((each) => each !== undefined && inAnchor.has(keyOf(each)))
      : undefined;
    const counter = { checks: 0 };
    const cues =
      sameLanguage?.cues ??
      (inAnchor.has(keyOf(served)) ? served.cues : retimedTo(leader.cues, served.cues, counter));
    const truth = await judge(cues, run.lang);

    return {
      ...base,
      outcome: truth.outcome,
      anchored: true,
      anchorCorrect,
      retimes: counter.checks,
    };
  };

  return strategies.reduce<Promise<Simulated[]>>(
    async (done, strategy) => [
      ...(await done),
      ...(await result.runs.reduce<Promise<Simulated[]>>(
        async (runs, run) => [...(await runs), await simulateRun(strategy, run)],
        Promise.resolve([]),
      )),
    ],
    Promise.resolve([]),
  );
};

const outcomeNames = ["correct", "wrong-timing", "wrong-title", "unmeasurable", "nothing"] as const;

const row = (cells: (string | number)[]) => `| ${cells.join(" | ")} |`;

export const anchorTables = (
  perFile: {
    filename: string;
    simulated: Simulated[];
    clusterChecks: number;
    clusterCPUMs: number;
    members: number;
    clusters: number;
  }[],
) => {
  const all = perFile.flatMap(({ simulated }) => simulated);
  const names = [...new Set(all.map(({ strategy }) => strategy))];
  const production = all.filter(({ strategy }) => strategy === names[0]);
  const count = (runs: { outcome: Run["outcome"] }[]) =>
    outcomeNames.map((outcome) => runs.filter((each) => each.outcome === outcome).length);
  const pooled = [
    row([
      "strategy",
      ...outcomeNames,
      "correct to wrong",
      "wrong to correct",
      "files with a wrong anchor",
      "serving retimes",
    ]),
    row(Array.from({ length: outcomeNames.length + 5 }, () => "---")),
    row([
      "production 37c481c",
      ...count(production.map(({ production: outcome }) => ({ outcome }))),
      0,
      0,
      "-",
      0,
    ]),
    ...names.map((name) => {
      const runs = all.filter(({ strategy }) => strategy === name);
      const wrongAnchors = perFile.filter(({ simulated }) =>
        simulated.some(
          (each) => each.strategy === name && each.anchored && each.anchorCorrect === false,
        ),
      ).length;

      return row([
        name,
        ...count(runs),
        runs.filter((each) => each.production === "correct" && each.outcome !== "correct").length,
        runs.filter((each) => each.production !== "correct" && each.outcome === "correct").length,
        wrongAnchors,
        runs.reduce((sum, each) => sum + each.retimes, 0),
      ]);
    }),
  ];
  const films = [
    row([
      "file",
      "candidates",
      "clusters",
      "clustering checks",
      "clustering CPU",
      "production correct",
      ...names.map((name) => `${name.split(" ")[0]} correct`),
    ]),
    row(Array.from({ length: names.length + 6 }, () => "---")),
    ...perFile.map(({ filename, simulated, clusterChecks, clusterCPUMs, members, clusters }) =>
      row([
        filename,
        members,
        clusters,
        clusterChecks,
        `${(clusterCPUMs / 1000).toFixed(1)} s`,
        simulated.filter((each) => each.strategy === names[0] && each.production === "correct")
          .length,
        ...names.map((name) => {
          const runs = simulated.filter((each) => each.strategy === name);
          const anchorMark = runs.some((each) => each.anchored && each.anchorCorrect === false)
            ? " (wrong anchor)"
            : "";

          return `${runs.filter((each) => each.outcome === "correct").length}/${runs.length}${anchorMark}`;
        }),
      ]),
    ),
  ];

  return [...pooled, "", ...films].join("\n");
};
