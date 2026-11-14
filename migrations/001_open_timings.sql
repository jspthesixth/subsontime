create function subtitle_key(hashes text[]) returns text
  language sql immutable strict parallel safe
  return md5(array_to_string(hashes, ','));

create table fixes (
  id bigserial primary key,
  video_hash char(16) not null,
  video_size bigint not null,
  subtitle_hashes text[] not null,
  subtitle_key text generated always as (subtitle_key(subtitle_hashes)) stored,
  cues jsonb not null,
  method text not null check (method in ('audio', 'reference', 'release-name')),
  reference_key text,
  submitter char(32) not null,
  created_at timestamptz not null default now()
);

create index fixes_video on fixes (video_hash, video_size);
create unique index fixes_one_per_submitter on fixes (video_hash, video_size, submitter, subtitle_key);

create table mismatches (
  id bigserial primary key,
  video_hash char(16) not null,
  video_size bigint not null,
  subtitle_hashes text[] not null,
  subtitle_key text generated always as (subtitle_key(subtitle_hashes)) stored,
  submitter char(32) not null,
  created_at timestamptz not null default now()
);

create index mismatches_video on mismatches (video_hash, video_size);
create unique index mismatches_one_per_submitter on mismatches (video_hash, video_size, submitter, subtitle_key);

create table reports (
  id bigserial primary key,
  video_hash char(16) not null,
  video_size bigint not null,
  subtitle_hashes text[] not null,
  subtitle_key text generated always as (subtitle_key(subtitle_hashes)) stored,
  reason text not null check (reason in ('machine-translated', 'wrong-language', 'lines-missing', 'timing-off', 'broken-characters')),
  submitter char(32) not null,
  created_at timestamptz not null default now()
);

create index reports_video on reports (video_hash, video_size);
create unique index reports_one_per_submitter on reports (video_hash, video_size, submitter, subtitle_key);
