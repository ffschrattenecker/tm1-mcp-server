import { z } from "zod";

// Which storage tree the file tools address. Shared by all five so the wording
// a model reads is identical everywhere.
export const CONTAINER_SCHEMA = {
  container: z
    .enum(["files", "applications"])
    .optional()
    .default("files")
    .describe(
      "'files' (default): the TI data directory (Files on v12, Blobs on v11). 'applications': the Applications tree of Architect/PAW; nests on both versions, only its documents carry content.",
    ),
};
