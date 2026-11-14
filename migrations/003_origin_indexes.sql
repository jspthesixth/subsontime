create index fixes_video_origin on fixes (video_hash, video_size, origin);
create index mismatches_video_origin on mismatches (video_hash, video_size, origin);
