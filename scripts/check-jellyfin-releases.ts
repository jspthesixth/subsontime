import * as v from "valibot";
import releases from "../plugins/jellyfin/releases.json" with { type: "json" };
import { releasesSchema } from "../src/web/jellyfin-manifest.ts";

v.parse(releasesSchema, releases);
