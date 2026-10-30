// The job as the writing services see it: cover letters, essays and the résumé tailor get the same facts.
import type { JobContext } from "../../shared/types";
import { compactProfile } from "./mapFields";

export const jobBrief = (job: JobContext | null) =>
  compactProfile({
    company: job?.company,
    title: job?.jobTitle,
    url: job?.url,
    description: job?.text.slice(0, 8000) || job?.header,
  });
