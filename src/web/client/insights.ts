import { inject } from "@vercel/analytics";
import { injectSpeedInsights } from "@vercel/speed-insights";
import { analyticsEvent } from "./lib/analytics-event.ts";

inject({ beforeSend: analyticsEvent });
injectSpeedInsights({ beforeSend: analyticsEvent });
